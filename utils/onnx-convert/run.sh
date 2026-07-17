#!/usr/bin/env bash
# uv-managed entrypoint:
#   utils/onnx-convert/run.sh all --model-id google/medgemma-4b-it --out ./models/out
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
exec uv run onnx-convert "$@"
