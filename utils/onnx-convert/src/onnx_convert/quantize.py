"""Quantize exported ONNX graphs into transformers.js dtype suffixes."""

from __future__ import annotations

import re
from pathlib import Path

import onnx
from onnxruntime.quantization import QuantType
from onnxruntime.quantization.onnx_quantizer import ONNXQuantizer
from onnxruntime.quantization.quant_utils import QuantizationMode
from onnxruntime.quantization.registry import IntegerOpsRegistry
from tqdm import tqdm

try:
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer as _MatMul4Bits
except ImportError:  # older ORT
    from onnxruntime.quantization.matmul_4bits_quantizer import MatMul4BitsQuantizer as _MatMul4Bits


_QUANT_SUFFIXES = ("fp16", "q4", "q4f16", "quantized", "int8", "uint8", "bnb4", "fp32")
_QUANT_RE = re.compile(r"_(" + "|".join(_QUANT_SUFFIXES) + r")\.onnx$")


def discover_base_graphs(onnx_dir: Path) -> list[Path]:
    """Return fp32/base `.onnx` files (skip already-quantized siblings)."""
    found = []
    for path in sorted(Path(onnx_dir).glob("*.onnx")):
        if _QUANT_RE.search(path.name):
            continue
        found.append(path)
    return found


def quantize_dir(
    onnx_dir: str | Path,
    *,
    modes: tuple[str, ...] = ("q4", "q4f16", "fp16", "quantized"),
    block_size: int = 32,
) -> None:
    onnx_dir = Path(onnx_dir)
    sources = discover_base_graphs(onnx_dir)
    if not sources:
        raise FileNotFoundError(f"No base ONNX graphs found in {onnx_dir}")

    for src in sources:
        stem = src.stem
        model = _load(src)
        for mode in tqdm(modes, desc=stem):
            out = onnx_dir / f"{stem}_{_suffix(mode)}.onnx"
            print(f"[quantize] {src.name} → {out.name}")
            if mode == "fp16":
                _to_fp16(model, out)
            elif mode == "q4":
                _to_q4(model, out, block_size=block_size)
            elif mode == "q4f16":
                q4 = _to_q4(model, None, block_size=block_size)
                _to_fp16(q4, out)
            elif mode in ("quantized", "q8"):
                _to_q8(model, out)
            else:
                raise ValueError(f"Unknown quant mode: {mode}")


def _suffix(mode: str) -> str:
    return "quantized" if mode in ("quantized", "q8") else mode


def _load(path: Path) -> onnx.ModelProto:
    return onnx.load(str(path), load_external_data=True)


def _save(model: onnx.ModelProto, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save_model(
        model,
        str(path),
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=path.name + "_data",
        size_threshold=1024,
    )


def _to_fp16(model: onnx.ModelProto, path: Path) -> None:
    from onnxruntime.transformers.float16 import convert_float_to_float16

    cloned = onnx.ModelProto()
    cloned.CopyFrom(model)
    disable_shape_infer = cloned.ByteSize() >= onnx.checker.MAXIMUM_PROTOBUF
    fp16 = convert_float_to_float16(
        cloned, keep_io_types=True, disable_shape_infer=disable_shape_infer
    )
    _save(fp16, path)


def _to_q4(model: onnx.ModelProto, path: Path | None, *, block_size: int) -> onnx.ModelProto:
    cloned = onnx.ModelProto()
    cloned.CopyFrom(model)
    quantizer = _MatMul4Bits(
        model=cloned,
        block_size=block_size,
        is_symmetric=True,
        accuracy_level=None,
    )
    quantizer.process()
    qmodel = quantizer.model.model
    if path is not None:
        _save(qmodel, path)
    return qmodel


def _to_q8(model: onnx.ModelProto, path: Path) -> None:
    cloned = onnx.ModelProto()
    cloned.CopyFrom(model)
    quantizer = ONNXQuantizer(
        cloned,
        per_channel=False,
        reduce_range=False,
        mode=QuantizationMode.IntegerOps,
        static=False,
        weight_qType=QuantType.QInt8,
        activation_qType=QuantType.QUInt8,
        tensors_range=None,
        nodes_to_quantize=[],
        nodes_to_exclude=[],
        op_types_to_quantize=set(IntegerOpsRegistry.keys()),
        extra_options=dict(EnableSubgraph=True, MatMulConstBOnly=True),
    )
    quantizer.quantize_model()
    _save(quantizer.model.model, path)
