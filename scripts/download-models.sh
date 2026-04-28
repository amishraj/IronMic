#!/bin/bash
# Download models for IronMic development.
# In production releases, models are bundled with the installer.
#
# Phase 1 redesign — Moonshine is the new default transcription engine.
# Whisper Large v3 Turbo is now optional and only needed for the multilingual
# fallback path. Run with --include-whisper-large to fetch it as well.

set -e

MODELS_DIR="$(dirname "$0")/../rust-core/models"
mkdir -p "$MODELS_DIR"

INCLUDE_WHISPER_LARGE=0
for arg in "$@"; do
    case "$arg" in
        --include-whisper-large) INCLUDE_WHISPER_LARGE=1 ;;
    esac
done

# Default transcription engine — Moonshine Base (English, ~146 MB)
MOONSHINE_DIR="$MODELS_DIR/moonshine-base"
MOONSHINE_ENCODER="$MOONSHINE_DIR/encoder_model.onnx"
MOONSHINE_DECODER="$MOONSHINE_DIR/decoder_model_merged.onnx"
MOONSHINE_TOKENIZER="$MOONSHINE_DIR/tokenizer.json"

# Optional fallback — multilingual Whisper
WHISPER_MODEL="$MODELS_DIR/whisper-large-v3-turbo.bin"

LLM_MODEL="$MODELS_DIR/mistral-7b-instruct-q4_k_m.gguf"

# HuggingFace base URLs for Moonshine ONNX exports
MOONSHINE_HF_BASE="https://huggingface.co/UsefulSensors/moonshine/resolve/main/onnx/merged/base"

echo "IronMic Model Downloader"
echo "========================"
echo ""
echo "Models directory: $MODELS_DIR"
echo ""

# ── Moonshine Base (default transcription engine) ────────────────────────
echo "[1/3] Moonshine Base — default transcription engine"
mkdir -p "$MOONSHINE_DIR"

download_moonshine_file() {
    local relpath="$1"   # e.g. "encoder_model.onnx"
    local dest="$2"
    if [ -f "$dest" ]; then
        echo "  [OK] $relpath already exists: $(du -h "$dest" | cut -f1)"
        return
    fi
    echo "  [DOWNLOAD] $relpath"
    echo "    URL: $MOONSHINE_HF_BASE/$relpath"
    echo "    Dest: $dest"
    if command -v curl >/dev/null 2>&1; then
        curl -L --fail -o "$dest" "$MOONSHINE_HF_BASE/$relpath" \
            && echo "    [OK] Downloaded $(du -h "$dest" | cut -f1)" \
            || { echo "    [FAIL] Download failed — see error above"; rm -f "$dest"; return 1; }
    else
        echo "    curl not found — manual download required:"
        echo "      curl -L -o '$dest' '$MOONSHINE_HF_BASE/$relpath'"
    fi
}

download_moonshine_file "encoder_model.onnx" "$MOONSHINE_ENCODER" || true
download_moonshine_file "decoder_model_merged.onnx" "$MOONSHINE_DECODER" || true
download_moonshine_file "tokenizer.json" "$MOONSHINE_TOKENIZER" || true

echo ""

# ── Whisper Large v3 Turbo (optional, multilingual fallback) ─────────────
if [ "$INCLUDE_WHISPER_LARGE" -eq 1 ]; then
    echo "[2/3] Whisper Large v3 Turbo — multilingual fallback"
    if [ -f "$WHISPER_MODEL" ]; then
        echo "  [OK] Whisper model already exists: $(du -h "$WHISPER_MODEL" | cut -f1)"
    else
        echo "  [DOWNLOAD] Whisper large-v3-turbo (~1.5 GB)"
        echo "    Download from: https://huggingface.co/ggerganov/whisper.cpp/tree/main"
        echo "    Example:"
        echo "      curl -L -o '$WHISPER_MODEL' \\"
        echo "        'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin'"
    fi
else
    echo "[2/3] Whisper Large v3 Turbo — SKIPPED (use --include-whisper-large to fetch)"
    echo "  Moonshine Base above is the default; Whisper is only needed for non-English."
fi

echo ""

# ── LLM (Mistral-7B for text cleanup, polish, AI notes) ──────────────────
echo "[3/3] Mistral-7B-Instruct LLM"
if [ -f "$LLM_MODEL" ]; then
    echo "  [OK] LLM model already exists: $(du -h "$LLM_MODEL" | cut -f1)"
else
    echo "  [DOWNLOAD] Mistral-7B-Instruct Q4_K_M (~4.4 GB)"
    echo "    Download from: https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF"
    echo "    Example:"
    echo "      curl -L -o '$LLM_MODEL' \\"
    echo "        'https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF/resolve/main/mistral-7b-instruct-v0.2.Q4_K_M.gguf'"
fi

echo ""
echo "Done. After downloading, run:"
echo "  cd rust-core && cargo build --release --features napi-export,whisper,engine-multi"
