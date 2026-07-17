"""Gemma 3 multimodal (image-text-to-text) → transformers.js ONNX layout.

Covers google/gemma-3-*-it, google/medgemma-*-it, and other Gemma3ForConditionalGeneration
checkpoints. Layout matches onnx-community/gemma-3-*-it-ONNX.
"""

from __future__ import annotations

import gc
from pathlib import Path

import torch
import torch.nn as nn
from transformers import AutoModelForImageTextToText, AutoProcessor

name = "gemma3-vlm"

required_onnx = (
    "vision_encoder.onnx",
    "embed_tokens.onnx",
    "decoder_model_merged.onnx",
)

required_assets = (
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
)


def match(config: dict) -> bool:
    model_type = (config.get("model_type") or "").lower()
    arches = [str(a) for a in (config.get("architectures") or [])]
    if model_type == "gemma3" and any("ForConditionalGeneration" in a for a in arches):
        return True
    if any(a == "Gemma3ForConditionalGeneration" for a in arches):
        return True
    # Multimodal gemma3 configs expose vision + image token fields.
    if model_type == "gemma3" and (
        "vision_config" in config or "image_token_index" in config or "image_token_id" in config
    ):
        return True
    return False


def normalize_config(cfg: dict) -> dict:
    cfg = dict(cfg)
    cfg.setdefault("model_type", "gemma3")
    arches = list(cfg.get("architectures") or [])
    if "Gemma3ForConditionalGeneration" not in arches:
        cfg["architectures"] = ["Gemma3ForConditionalGeneration"]
    return cfg


def validate_config(cfg: dict) -> list[str]:
    problems: list[str] = []
    if cfg.get("model_type") != "gemma3":
        problems.append(f"config.model_type should be 'gemma3' (got {cfg.get('model_type')!r})")
    arches = cfg.get("architectures") or []
    if "Gemma3ForConditionalGeneration" not in arches:
        problems.append("config.architectures must include Gemma3ForConditionalGeneration")
    if "image_token_index" not in cfg and "image_token_id" not in cfg:
        problems.append("config missing image_token_index / image_token_id")
    return problems


# --- torch wrappers (onnx-community Gemma 3 VLM I/O contract) ---


class VisionEncoderWrapper(nn.Module):
    def __init__(self, model: nn.Module):
        super().__init__()
        self.vision_tower = model.model.vision_tower
        self.multi_modal_projector = model.model.multi_modal_projector

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        vision_outputs = self.vision_tower(pixel_values=pixel_values, return_dict=True)
        return self.multi_modal_projector(vision_outputs.last_hidden_state)


class EmbedTokensWrapper(nn.Module):
    def __init__(self, model: nn.Module):
        super().__init__()
        self.embed_tokens = model.model.language_model.get_input_embeddings()

    def forward(self, input_ids: torch.Tensor) -> torch.Tensor:
        safe_ids = input_ids.clone()
        vocab = self.embed_tokens.num_embeddings
        safe_ids[safe_ids >= vocab] = 0
        return self.embed_tokens(safe_ids)


class DecoderMergedWrapper(nn.Module):
    def __init__(self, model: nn.Module):
        super().__init__()
        self.language_model = model.model.language_model
        self.lm_head = model.lm_head
        self.num_layers = model.config.text_config.num_hidden_layers
        self.num_kv_heads = model.config.text_config.num_key_value_heads
        self.head_dim = model.config.text_config.head_dim

    def forward(
        self,
        inputs_embeds: torch.Tensor,
        attention_mask: torch.Tensor,
        num_logits_to_keep: torch.Tensor,
        *past_flat: torch.Tensor,
    ):
        from transformers import DynamicCache

        # Gemma 3 expects a Cache object, not a legacy tuple.
        if past_flat and past_flat[0].shape[-2] > 0:
            pairs = tuple(
                (past_flat[2 * i], past_flat[2 * i + 1]) for i in range(self.num_layers)
            )
            past_key_values = DynamicCache.from_legacy_cache(pairs)
        else:
            past_key_values = None

        outputs = self.language_model(
            inputs_embeds=inputs_embeds,
            attention_mask=attention_mask,
            past_key_values=past_key_values,
            use_cache=True,
            return_dict=True,
        )
        hidden = outputs.last_hidden_state
        keep = int(num_logits_to_keep.reshape(()).item()) if num_logits_to_keep.numel() else 1
        if keep > 0:
            hidden = hidden[:, -keep:, :]
        logits = self.lm_head(hidden)

        presents = []
        pkv = outputs.past_key_values
        if hasattr(pkv, "to_legacy_cache"):
            pkv = pkv.to_legacy_cache()
        for layer_past in pkv:
            if isinstance(layer_past, (tuple, list)) and len(layer_past) >= 2:
                presents.extend([layer_past[0], layer_past[1]])
            else:
                raise TypeError(
                    f"Unsupported past_key_values entry type: {type(layer_past)}. "
                    "Need a legacy Cache / tuple[(key, value), ...] for ONNX export."
                )
        return (logits, *presents)


def _empty_past(batch: int, device: torch.device, dtype: torch.dtype, wrapper: DecoderMergedWrapper):
    past = []
    for _ in range(wrapper.num_layers):
        z = torch.zeros(
            batch, wrapper.num_kv_heads, 0, wrapper.head_dim, device=device, dtype=dtype
        )
        past.extend([z, z.clone()])
    return past


def _decoder_io_names(num_layers: int) -> tuple[list[str], list[str]]:
    inputs = ["inputs_embeds", "attention_mask", "num_logits_to_keep"]
    outputs = ["logits"]
    for i in range(num_layers):
        inputs.append(f"past_key_values.{i}.key")
        inputs.append(f"past_key_values.{i}.value")
        outputs.append(f"present.{i}.key")
        outputs.append(f"present.{i}.value")
    return inputs, outputs


def export(
    model_id: str,
    output_dir: str | Path,
    *,
    device: str = "cpu",
    dtype: str = "fp32",
    opset: int = 18,
    token: str | None = None,
    trust_remote_code: bool = False,
    components: tuple[str, ...] = ("vision", "embed", "decoder"),
) -> Path:
    out = Path(output_dir)
    onnx_dir = out / "onnx"
    onnx_dir.mkdir(parents=True, exist_ok=True)

    torch_dtype = {"fp32": torch.float32, "fp16": torch.float16, "bf16": torch.bfloat16}[dtype]

    print(f"[export:{name}] loading {model_id} on {device} ({dtype})")
    model = AutoModelForImageTextToText.from_pretrained(
        model_id,
        dtype=torch_dtype,
        token=token,
        trust_remote_code=trust_remote_code,
        low_cpu_mem_usage=True,
    )
    model.eval()
    model.to(device)
    processor = AutoProcessor.from_pretrained(
        model_id, token=token, trust_remote_code=trust_remote_code
    )

    pixel_values, input_ids, attention_mask = _dummy_inputs(
        processor, device=device, dtype=torch_dtype
    )

    if "vision" in components:
        _export_vision(model, pixel_values, onnx_dir / "vision_encoder.onnx", opset)
        gc.collect()
    if "embed" in components:
        _export_embed(model, input_ids, onnx_dir / "embed_tokens.onnx", opset)
        gc.collect()
    if "decoder" in components:
        _export_decoder(
            model,
            input_ids=input_ids,
            attention_mask=attention_mask,
            pixel_values=pixel_values,
            path=onnx_dir / "decoder_model_merged.onnx",
            opset=opset,
            device=device,
            dtype=torch_dtype,
        )
        gc.collect()

    del model
    gc.collect()
    if device.startswith("cuda") and torch.cuda.is_available():
        torch.cuda.empty_cache()

    print(f"[export:{name}] wrote ONNX graphs → {onnx_dir}")
    return onnx_dir


def _dummy_inputs(processor, *, device: str, dtype: torch.dtype):
    from PIL import Image

    image = Image.new("RGB", (896, 896), color=(128, 128, 128))
    # Instruct checkpoints have a chat template; -pt / base models often do not.
    chat_template = getattr(processor, "chat_template", None) or getattr(
        getattr(processor, "tokenizer", None), "chat_template", None
    )
    if chat_template:
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": image},
                    {"type": "text", "text": "Describe this image."},
                ],
            }
        ]
        inputs = processor.apply_chat_template(
            messages,
            add_generation_prompt=True,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
        )
    else:
        # Gemma 3 / MedGemma PT: processor expects BOI (`<start_of_image>`), not soft image token.
        tok = getattr(processor, "tokenizer", None)
        image_token = (
            getattr(tok, "boi_token", None)
            or getattr(processor, "boi_token", None)
            or "<start_of_image>"
        )
        inputs = processor(text=image_token, images=image, return_tensors="pt")

    return (
        inputs["pixel_values"].to(device=device, dtype=dtype),
        inputs["input_ids"].to(device),
        inputs["attention_mask"].to(device),
    )


def _onnx_export(model, args, path: Path, **kwargs) -> None:
    """Export with the TorchScript ONNX path — dynamo+dynamic_axes breaks on *past_kv."""
    torch.onnx.export(
        model,
        args,
        str(path),
        dynamo=False,
        opset_version=kwargs.pop("opset_version", 18),
        do_constant_folding=kwargs.pop("do_constant_folding", True),
        **kwargs,
    )
    _consolidate_external_data(path)


def _consolidate_external_data(path: Path) -> None:
    """Rewrite weights into a single `{stem}.onnx_data` sibling (transformers.js style)."""
    import onnx
    from onnx.external_data_helper import convert_model_to_external_data

    model = onnx.load(str(path), load_external_data=True)
    data_name = path.name + "_data"
    convert_model_to_external_data(
        model,
        all_tensors_to_one_file=True,
        location=data_name,
        size_threshold=1024,
        convert_attribute=False,
    )
    onnx.save_model(model, str(path))
    # Drop Torch's default multi-file external shards / alternate extensions.
    keep = {path.name, data_name}
    for sibling in path.parent.iterdir():
        if sibling.name in keep or not sibling.is_file():
            continue
        if sibling.name.startswith("onnx__") or sibling.name == path.name + ".data":
            sibling.unlink(missing_ok=True)



@torch.inference_mode()
def _export_vision(model, pixel_values: torch.Tensor, path: Path, opset: int) -> None:
    print(f"[export:{name}] vision_encoder → {path.name}")
    wrapper = VisionEncoderWrapper(model).eval()
    _onnx_export(
        wrapper,
        (pixel_values,),
        path,
        input_names=["pixel_values"],
        output_names=["image_features"],
        dynamic_axes={
            "pixel_values": {0: "batch"},
            "image_features": {0: "batch", 1: "num_image_tokens"},
        },
        opset_version=opset,
    )


@torch.inference_mode()
def _export_embed(model, input_ids: torch.Tensor, path: Path, opset: int) -> None:
    print(f"[export:{name}] embed_tokens → {path.name}")
    wrapper = EmbedTokensWrapper(model).eval()
    _onnx_export(
        wrapper,
        (input_ids,),
        path,
        input_names=["input_ids"],
        output_names=["inputs_embeds"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "sequence"},
            "inputs_embeds": {0: "batch", 1: "sequence"},
        },
        opset_version=opset,
    )


@torch.inference_mode()
def _export_decoder(
    model,
    *,
    input_ids: torch.Tensor,
    attention_mask: torch.Tensor,
    pixel_values: torch.Tensor,
    path: Path,
    opset: int,
    device: str,
    dtype: torch.dtype,
) -> None:
    print(f"[export:{name}] decoder_model_merged → {path.name}")
    vision = VisionEncoderWrapper(model).eval()
    embed = EmbedTokensWrapper(model).eval()
    image_features = vision(pixel_values)
    inputs_embeds = embed(input_ids)
    image_token_id = model.config.image_token_index
    mask = (input_ids == image_token_id).unsqueeze(-1).expand_as(inputs_embeds)
    inputs_embeds = inputs_embeds.masked_scatter(
        mask, image_features.to(inputs_embeds.dtype).reshape(-1, inputs_embeds.shape[-1])
    )

    wrapper = DecoderMergedWrapper(model).eval()
    past = _empty_past(inputs_embeds.shape[0], torch.device(device), dtype, wrapper)
    num_logits_to_keep = torch.tensor(1, dtype=torch.int64, device=device)

    input_names, output_names = _decoder_io_names(wrapper.num_layers)
    dynamic_axes = {
        "inputs_embeds": {0: "batch", 1: "sequence"},
        "attention_mask": {0: "batch", 1: "sequence"},
    }
    for i in range(wrapper.num_layers):
        dynamic_axes[f"past_key_values.{i}.key"] = {0: "batch", 2: "past_sequence"}
        dynamic_axes[f"past_key_values.{i}.value"] = {0: "batch", 2: "past_sequence"}
        dynamic_axes[f"present.{i}.key"] = {0: "batch", 2: "present_sequence"}
        dynamic_axes[f"present.{i}.value"] = {0: "batch", 2: "present_sequence"}

    _onnx_export(
        wrapper,
        (inputs_embeds, attention_mask, num_logits_to_keep, *past),
        path,
        input_names=input_names,
        output_names=output_names,
        dynamic_axes=dynamic_axes,
        opset_version=opset,
    )
