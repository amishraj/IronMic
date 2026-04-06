#!/bin/bash
# Download models for IronMic development.
# In production releases, models are bundled with the installer.

set -e

MODELS_DIR="$(dirname "$0")/../rust-core/models"
mkdir -p "$MODELS_DIR"

WHISPER_MODEL="$MODELS_DIR/whisper-large-v3-turbo.bin"
LLM_MODEL="$MODELS_DIR/mistral-7b-instruct-q4_k_m.gguf"

echo "IronMic Model Downloader"
echo "========================"
echo ""
echo "Models directory: $MODELS_DIR"
echo ""

# Whisper model
if [ -f "$WHISPER_MODEL" ]; then
    echo "[OK] Whisper model already exists: $(du -h "$WHISPER_MODEL" | cut -f1)"
else
    echo "[DOWNLOAD] Whisper large-v3-turbo (~1.5 GB)"
    echo "  Download from: https://huggingface.co/ggerganov/whisper.cpp/tree/main"
    echo "  File: ggml-large-v3-turbo.bin"
    echo "  Save to: $WHISPER_MODEL"
    echo ""
    echo "  Example:"
    echo "    curl -L -o '$WHISPER_MODEL' \\"
    echo "      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin'"
fi

echo ""

# LLM model
if [ -f "$LLM_MODEL" ]; then
    echo "[OK] LLM model already exists: $(du -h "$LLM_MODEL" | cut -f1)"
else
    echo "[DOWNLOAD] Mistral-7B-Instruct Q4_K_M (~4.4 GB)"
    echo "  Download from: https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF"
    echo "  File: mistral-7b-instruct-v0.2.Q4_K_M.gguf"
    echo "  Save to: $LLM_MODEL"
    echo ""
    echo "  Example:"
    echo "    curl -L -o '$LLM_MODEL' \\"
    echo "      'https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF/resolve/main/mistral-7b-instruct-v0.2.Q4_K_M.gguf'"
fi

echo ""
echo "Done. After downloading, run: cd rust-core && cargo build --release"
