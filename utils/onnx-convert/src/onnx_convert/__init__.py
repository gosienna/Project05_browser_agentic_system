"""Convert Hugging Face Transformers models to transformers.js ONNX packages."""

from __future__ import annotations

__all__ = ["CORE_ASSETS", "OPTIONAL_ASSETS"]

# Always needed for AutoTokenizer / config load in the browser.
CORE_ASSETS = (
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
)

# Copied when present (VLMs, chat models, etc.).
OPTIONAL_ASSETS = (
    "generation_config.json",
    "preprocessor_config.json",
    "processor_config.json",
    "chat_template.jinja",
    "special_tokens_map.json",
    "added_tokens.json",
    "tokenizer.model",
)
