#!/bin/bash
# Download baseline models for IronMic development and packaging.
# In production releases, these models are bundled with the installer.
#
# Enterprise rule: baseline models come from IronMic release assets or an
# approved internal mirror, not HuggingFace. Override with:
#   IRONMIC_MODEL_BASE_URL=https://artifact.example.com/ironmic/models-v1
#
# Whisper Large v3 Turbo is optional and only needed for multilingual fallback.
# Run with --include-whisper-large to stage it as well.

set -e

MODELS_DIR="$(dirname "$0")/../rust-core/models"
MODELS_BASE_URL="${IRONMIC_MODEL_BASE_URL:-https://github.com/greenpioneersolutions/IronMic/releases/download/models-v1}"
mkdir -p "$MODELS_DIR"

INCLUDE_WHISPER_LARGE=0
for arg in "$@"; do
    case "$arg" in
        --include-whisper-large) INCLUDE_WHISPER_LARGE=1 ;;
    esac
done

MOONSHINE_DIR="$MODELS_DIR/moonshine-base"
MOONSHINE_ENCODER="$MOONSHINE_DIR/encoder_model.onnx"
MOONSHINE_DECODER="$MOONSHINE_DIR/decoder_model_merged.onnx"
MOONSHINE_TOKENIZER="$MOONSHINE_DIR/tokenizer.json"

WHISPER_MODEL="$MODELS_DIR/whisper-large-v3-turbo.bin"

PHI3_MODEL="$MODELS_DIR/Phi-3-mini-4k-instruct-q4.gguf"
PHI3_PARTS=(
    "Phi-3-mini-4k-instruct-q4.gguf.part0"
    "Phi-3-mini-4k-instruct-q4.gguf.part1"
)

echo "IronMic Model Downloader"
echo "========================"
echo ""
echo "Models directory: $MODELS_DIR"
echo "Model mirror:     $MODELS_BASE_URL"
echo ""

download_file() {
    local url="$1"
    local dest="$2"
    echo "    URL: $url"
    echo "    Dest: $dest"
    if ! command -v curl >/dev/null 2>&1; then
        echo "    curl not found — manual download required:"
        echo "      curl -L -o '$dest' '$url'"
        return 1
    fi
    curl -L --fail -o "$dest" "$url" \
        && echo "    [OK] Downloaded $(du -h "$dest" | cut -f1)" \
        || { echo "    [FAIL] Download failed — see error above"; rm -f "$dest"; return 1; }
}

download_moonshine_file() {
    local asset="$1"
    local relpath="$2"
    local dest="$3"
    if [ -s "$dest" ]; then
        echo "  [OK] $relpath already exists: $(du -h "$dest" | cut -f1)"
        return
    fi
    echo "  [DOWNLOAD] $relpath"
    download_file "$MODELS_BASE_URL/$asset" "$dest"
}

echo "[1/3] Moonshine Base — default transcription engine"
mkdir -p "$MOONSHINE_DIR"
download_moonshine_file "moonshine-base-encoder_model.onnx" "encoder_model.onnx" "$MOONSHINE_ENCODER"
download_moonshine_file "moonshine-base-decoder_model_merged.onnx" "decoder_model_merged.onnx" "$MOONSHINE_DECODER"
download_moonshine_file "moonshine-base-tokenizer.json" "tokenizer.json" "$MOONSHINE_TOKENIZER"
echo ""

if [ "$INCLUDE_WHISPER_LARGE" -eq 1 ]; then
    echo "[2/3] Whisper Large v3 Turbo — multilingual fallback"
    if [ -s "$WHISPER_MODEL" ]; then
        echo "  [OK] Whisper model already exists: $(du -h "$WHISPER_MODEL" | cut -f1)"
    else
        echo "  [DOWNLOAD] whisper-large-v3-turbo.bin"
        download_file "$MODELS_BASE_URL/whisper-large-v3-turbo.bin" "$WHISPER_MODEL"
    fi
else
    echo "[2/3] Whisper Large v3 Turbo — SKIPPED (use --include-whisper-large to fetch)"
    echo "  Moonshine Base above is the default; Whisper is only needed for non-English."
fi
echo ""

echo "[3/3] Phi-3 Mini — baseline local LLM"
if [ -s "$PHI3_MODEL" ]; then
    echo "  [OK] Phi-3 model already exists: $(du -h "$PHI3_MODEL" | cut -f1)"
else
    echo "  [DOWNLOAD] Phi-3 Mini Q4 (~2.2 GB, split release assets)"
    PART_PATHS=()
    for part in "${PHI3_PARTS[@]}"; do
        part_path="$MODELS_DIR/$part"
        PART_PATHS+=("$part_path")
        if [ -s "$part_path" ]; then
            echo "  [OK] $part already exists: $(du -h "$part_path" | cut -f1)"
        else
            echo "  [DOWNLOAD] $part"
            download_file "$MODELS_BASE_URL/$part" "$part_path"
        fi
    done
    echo "  [ASSEMBLE] Phi-3 Mini"
    tmp="$PHI3_MODEL.assembling"
    rm -f "$tmp"
    for part_path in "${PART_PATHS[@]}"; do
        cat "$part_path" >> "$tmp"
    done
    mv "$tmp" "$PHI3_MODEL"
    rm -f "${PART_PATHS[@]}"
    echo "  [OK] Assembled Phi-3 model: $(du -h "$PHI3_MODEL" | cut -f1)"
fi

echo ""
echo "Done. After downloading, run:"
echo "  cd rust-core && cargo build --release --features napi-export,whisper,engine-multi"
