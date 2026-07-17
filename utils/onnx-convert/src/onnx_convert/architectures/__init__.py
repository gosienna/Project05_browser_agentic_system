"""Architecture plugins for onnx-convert.

Each plugin exports:
  - name: str
  - match(config: dict) -> bool
  - required_onnx: tuple[str, ...]
  - export(...): Path
  - validate_config(cfg: dict) -> list[str]
  - normalize_config(cfg: dict) -> dict  (optional)
"""

from __future__ import annotations

from . import gemma3_vlm

_ARCHITECTURES = (
    gemma3_vlm,
)


def list_architectures() -> list[str]:
    return [m.name for m in _ARCHITECTURES]


def detect_architecture(config: dict, *, explicit: str | None = None) -> object:
    if explicit:
        for mod in _ARCHITECTURES:
            if mod.name == explicit:
                return mod
        raise ValueError(
            f"Unknown architecture {explicit!r}. Supported: {', '.join(list_architectures())}"
        )

    matches = [m for m in _ARCHITECTURES if m.match(config)]
    if not matches:
        model_type = config.get("model_type")
        arches = config.get("architectures")
        raise ValueError(
            f"No onnx-convert backend for model_type={model_type!r} architectures={arches!r}. "
            f"Supported: {', '.join(list_architectures())}. Pass --arch explicitly if needed."
        )
    if len(matches) > 1:
        names = ", ".join(m.name for m in matches)
        raise ValueError(f"Ambiguous architecture match ({names}); pass --arch.")
    return matches[0]
