"""Dispatch ONNX export to the architecture backend matched for a model."""

from __future__ import annotations

from pathlib import Path

from .architectures import detect_architecture
from .package_assets import load_hub_config


def export_onnx(
    model_id: str,
    output_dir: str | Path,
    *,
    arch: str | None = None,
    device: str = "cpu",
    dtype: str = "fp32",
    opset: int = 18,
    token: str | None = None,
    trust_remote_code: bool = False,
    components: tuple[str, ...] | None = None,
) -> Path:
    config = load_hub_config(model_id, token=token)
    backend = detect_architecture(config, explicit=arch)
    kwargs = dict(
        model_id=model_id,
        output_dir=output_dir,
        device=device,
        dtype=dtype,
        opset=opset,
        token=token,
        trust_remote_code=trust_remote_code,
    )
    if components is not None:
        kwargs["components"] = components
    return backend.export(**kwargs)
