"""CLI: convert Hugging Face Transformers checkpoints to transformers.js ONNX.

Examples (from utils/onnx-convert):

  uv sync

  # Package config/tokenizer/processor only
  uv run onnx-convert assets \\
      --model-id google/medgemma-4b-it \\
      --out ./models/MedGemma-4B-IT-ONNX

  # Full export (arch auto-detected from config.json)
  uv run onnx-convert all \\
      --model-id google/medgemma-4b-it \\
      --out ./models/MedGemma-4B-IT-ONNX \\
      --device cuda \\
      --quantize

  uv run onnx-convert validate --out ./models/MedGemma-4B-IT-ONNX

Gated models need `huggingface-cli login` or HF_TOKEN.
Supported architectures: see `uv run onnx-convert arches`.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path


def _token(explicit: str | None) -> str | None:
    return explicit or os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")


def cmd_arches(_args: argparse.Namespace) -> int:
    from .architectures import list_architectures

    for name in list_architectures():
        print(name)
    return 0


def cmd_assets(args: argparse.Namespace) -> int:
    from .architectures import detect_architecture
    from .package_assets import load_hub_config, package_assets

    cfg = load_hub_config(args.model_id, revision=args.revision, token=_token(args.token))
    arch = detect_architecture(cfg, explicit=args.arch)
    package_assets(
        args.model_id,
        args.out,
        revision=args.revision,
        token=_token(args.token),
        arch=arch,
    )
    print(f"[assets] arch={arch.name} → {args.out}")
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    from .architectures import detect_architecture
    from .export import export_onnx
    from .package_assets import load_hub_config, package_assets

    cfg = load_hub_config(args.model_id, revision=args.revision, token=_token(args.token))
    arch = detect_architecture(cfg, explicit=args.arch)

    if not args.skip_assets:
        package_assets(
            args.model_id,
            args.out,
            revision=args.revision,
            token=_token(args.token),
            arch=arch,
        )

    components = tuple(args.components.split(",")) if args.components else None
    export_onnx(
        args.model_id,
        args.out,
        arch=arch.name,
        device=args.device,
        dtype=args.dtype,
        opset=args.opset,
        token=_token(args.token),
        components=components,
    )
    return 0


def cmd_quantize(args: argparse.Namespace) -> int:
    from .quantize import quantize_dir

    modes = tuple(args.modes.split(","))
    quantize_dir(Path(args.out) / "onnx", modes=modes, block_size=args.block_size)
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    from .validate import print_report

    ok = print_report(args.out, arch=args.arch, require_quants=args.require_quants)
    return 0 if ok else 1


def cmd_all(args: argparse.Namespace) -> int:
    rc = cmd_export(args)
    if rc != 0:
        return rc
    if args.quantize:
        rc = cmd_quantize(
            argparse.Namespace(out=args.out, modes=args.modes, block_size=args.block_size)
        )
        if rc != 0:
            return rc
    return cmd_validate(
        argparse.Namespace(
            out=args.out, arch=args.arch, require_quants=bool(args.quantize)
        )
    )


def build_parser() -> argparse.ArgumentParser:
    from .architectures import list_architectures

    p = argparse.ArgumentParser(
        prog="onnx-convert",
        description="Convert Hugging Face Transformers models to transformers.js ONNX packages.",
    )
    sub = p.add_subparsers(dest="command", required=True)

    def add_model_opts(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--model-id", required=True, help="HF Transformers repo id or local path.")
        sp.add_argument("--revision", default=None)
        sp.add_argument("--token", default=None, help="HF token (or set HF_TOKEN).")
        sp.add_argument(
            "--arch",
            default=None,
            choices=list_architectures(),
            help="Export backend (default: auto-detect from config.json).",
        )
        sp.add_argument("--out", required=True, help="Output model directory.")

    sp = sub.add_parser("arches", help="List supported architecture backends.")
    sp.set_defaults(func=cmd_arches)

    sp = sub.add_parser("assets", help="Download config/tokenizer/processor only.")
    add_model_opts(sp)
    sp.set_defaults(func=cmd_assets)

    sp = sub.add_parser("export", help="Package assets + export ONNX subgraphs.")
    add_model_opts(sp)
    sp.add_argument("--device", default="cpu", help="cpu | cuda | cuda:0 | …")
    sp.add_argument("--dtype", default="fp32", choices=("fp32", "fp16", "bf16"))
    sp.add_argument("--opset", type=int, default=18)
    sp.add_argument(
        "--components",
        default=None,
        help="Comma list of subgraphs (arch-specific; e.g. vision,embed,decoder).",
    )
    sp.add_argument("--skip-assets", action="store_true")
    sp.set_defaults(func=cmd_export)

    sp = sub.add_parser("quantize", help="Quantize onnx/*.onnx into q4/q4f16/fp16/q8.")
    sp.add_argument("--out", required=True)
    sp.add_argument("--modes", default="q4,q4f16,fp16,quantized")
    sp.add_argument("--block-size", type=int, default=32)
    sp.set_defaults(func=cmd_quantize)

    sp = sub.add_parser("validate", help="Check transformers.js package layout.")
    sp.add_argument("--out", required=True)
    sp.add_argument("--arch", default=None, choices=list_architectures())
    sp.add_argument("--require-quants", action="store_true")
    sp.set_defaults(func=cmd_validate)

    sp = sub.add_parser("all", help="assets + export + optional quantize + validate.")
    add_model_opts(sp)
    sp.add_argument("--device", default="cpu")
    sp.add_argument("--dtype", default="fp32", choices=("fp32", "fp16", "bf16"))
    sp.add_argument("--opset", type=int, default=18)
    sp.add_argument("--components", default=None)
    sp.add_argument("--skip-assets", action="store_true")
    sp.add_argument("--quantize", action="store_true")
    sp.add_argument("--modes", default="q4,q4f16,fp16,quantized")
    sp.add_argument("--block-size", type=int, default=32)
    sp.set_defaults(func=cmd_all)

    return p


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    raise SystemExit(args.func(args))


if __name__ == "__main__":
    main()
