"""Validate an exported transformers.js ONNX package layout."""

from __future__ import annotations

import json
import re
from pathlib import Path

from . import CORE_ASSETS
from .architectures import detect_architecture

_QUANT_SUFFIXES = ("fp16", "q4", "q4f16", "quantized", "int8", "uint8", "bnb4", "fp32")
_QUANT_RE = re.compile(r"_(" + "|".join(_QUANT_SUFFIXES) + r")\.onnx$")


def _discover_base_graphs(onnx_dir: Path) -> list[Path]:
    found = []
    for path in sorted(Path(onnx_dir).glob("*.onnx")):
        if _QUANT_RE.search(path.name):
            continue
        found.append(path)
    return found


def validate_layout(
    output_dir: str | Path,
    *,
    arch: str | None = None,
    require_quants: bool = False,
) -> list[str]:
    root = Path(output_dir)
    problems: list[str] = []

    cfg_path = root / "config.json"
    cfg: dict = {}
    if cfg_path.is_file():
        cfg = json.loads(cfg_path.read_text())
    else:
        problems.append("missing asset: config.json")

    backend = None
    try:
        if cfg:
            backend = detect_architecture(cfg, explicit=arch)
    except ValueError as e:
        problems.append(str(e))

    required_assets = tuple(getattr(backend, "required_assets", None) or CORE_ASSETS)
    for name in required_assets:
        if not (root / name).is_file():
            problems.append(f"missing asset: {name}")

    onnx_dir = root / "onnx"
    if not onnx_dir.is_dir():
        problems.append("missing directory: onnx/")
        return problems

    required_onnx = tuple(getattr(backend, "required_onnx", None) or ())
    if required_onnx:
        for name in required_onnx:
            if not (onnx_dir / name).is_file():
                problems.append(f"missing ONNX graph: onnx/{name}")
    elif not _discover_base_graphs(onnx_dir):
        problems.append("onnx/ has no base .onnx graphs")

    if backend is not None and hasattr(backend, "validate_config") and cfg:
        problems.extend(backend.validate_config(cfg))

    pre_path = root / "preprocessor_config.json"
    if pre_path.is_file():
        pre = json.loads(pre_path.read_text())
        if "image_processor_type" not in pre and "feature_extractor_type" not in pre:
            problems.append("preprocessor_config.json missing image_processor_type")

    if require_quants:
        bases = [p.stem for p in _discover_base_graphs(onnx_dir)]
        if required_onnx:
            bases = [Path(n).stem for n in required_onnx]
        for base in bases:
            for suffix in ("q4", "q4f16"):
                name = f"{base}_{suffix}.onnx"
                if not (onnx_dir / name).is_file():
                    problems.append(f"missing quant: onnx/{name}")

    return problems


def print_report(
    output_dir: str | Path,
    *,
    arch: str | None = None,
    require_quants: bool = False,
) -> bool:
    problems = validate_layout(output_dir, arch=arch, require_quants=require_quants)
    if not problems:
        print(f"[validate] OK — {output_dir}")
        return True
    print(f"[validate] FAILED — {output_dir}")
    for p in problems:
        print(f"  - {p}")
    return False
