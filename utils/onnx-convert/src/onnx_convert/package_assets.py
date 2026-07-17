"""Copy / download Hugging Face config + tokenizer (+ optional processor) assets."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from huggingface_hub import hf_hub_download, list_repo_files, snapshot_download

from . import CORE_ASSETS, OPTIONAL_ASSETS


def package_assets(
    model_id: str,
    output_dir: str | Path,
    *,
    revision: str | None = None,
    token: str | None = None,
    arch=None,
) -> Path:
    """Download Transformers metadata into `output_dir` (no weight tensors)."""
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    repo_files = set(list_repo_files(model_id, revision=revision, token=token))
    required = tuple(getattr(arch, "required_assets", None) or CORE_ASSETS)
    wanted = list(required) + [f for f in OPTIONAL_ASSETS if f in repo_files and f not in required]

    missing = [f for f in required if f not in repo_files]
    if missing:
        raise FileNotFoundError(
            f"{model_id} is missing required assets: {missing}. "
            "Use a Transformers checkpoint (config + tokenizer), not onnxruntime-genai."
        )

    for name in wanted:
        path = hf_hub_download(
            repo_id=model_id,
            filename=name,
            revision=revision,
            token=token,
        )
        shutil.copy2(path, out / name)

    _ensure_chat_template_file(out)
    _normalize_config(out, arch=arch)
    return out


def package_assets_from_local(src_dir: str | Path, output_dir: str | Path, *, arch=None) -> Path:
    src = Path(src_dir)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    required = tuple(getattr(arch, "required_assets", None) or CORE_ASSETS)
    missing = [f for f in required if not (src / f).is_file()]
    if missing:
        raise FileNotFoundError(f"{src} missing required assets: {missing}")

    for name in list(required) + list(OPTIONAL_ASSETS):
        p = src / name
        if p.is_file():
            shutil.copy2(p, out / name)

    _ensure_chat_template_file(out)
    _normalize_config(out, arch=arch)
    return out


def download_full_snapshot(
    model_id: str,
    cache_dir: str | Path,
    *,
    revision: str | None = None,
    token: str | None = None,
) -> Path:
    path = snapshot_download(
        repo_id=model_id,
        revision=revision,
        token=token,
        local_dir=str(cache_dir),
        local_dir_use_symlinks=False,
    )
    return Path(path)


def load_hub_config(
    model_id: str,
    *,
    revision: str | None = None,
    token: str | None = None,
) -> dict:
    path = hf_hub_download(
        repo_id=model_id, filename="config.json", revision=revision, token=token
    )
    return json.loads(Path(path).read_text())


def _ensure_chat_template_file(out: Path) -> None:
    jinja = out / "chat_template.jinja"
    if jinja.is_file():
        return
    tok_cfg_path = out / "tokenizer_config.json"
    if not tok_cfg_path.is_file():
        return
    tok_cfg = json.loads(tok_cfg_path.read_text())
    template = tok_cfg.get("chat_template")
    if isinstance(template, str) and template.strip():
        jinja.write_text(template)


def _normalize_config(out: Path, *, arch=None) -> None:
    cfg_path = out / "config.json"
    if not cfg_path.is_file():
        return
    cfg = json.loads(cfg_path.read_text())
    if arch is not None and hasattr(arch, "normalize_config"):
        cfg = arch.normalize_config(cfg)
    cfg_path.write_text(json.dumps(cfg, indent=2) + "\n")
