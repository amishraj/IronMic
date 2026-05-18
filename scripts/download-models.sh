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
INCLUDE_WESPEAKER=0
for arg in "$@"; do
    case "$arg" in
        --include-whisper-large) INCLUDE_WHISPER_LARGE=1 ;;
        --include-wespeaker) INCLUDE_WESPEAKER=1 ;;
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

# HuggingFace base URL for Moonshine ONNX exports.
# IMPORTANT: the canonical path requires `/float`. Without it HuggingFace
# returns "Entry not found" (404) for every file. Must stay in sync with
# MOONSHINE_HF_BASE in electron-app/src/shared/constants.ts.
MOONSHINE_HF_BASE="https://huggingface.co/UsefulSensors/moonshine/resolve/main/onnx/merged/base/float"

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

# Note: no `|| true` — set -e is in effect, and a failed Moonshine download
# (e.g. typo in URL) MUST abort the script. The previous "fail-soft" behavior
# masked broken URLs because tail-piped curl always returned 0, which is how
# this whole class of bug shipped.
download_moonshine_file "encoder_model.onnx" "$MOONSHINE_ENCODER"
download_moonshine_file "decoder_model_merged.onnx" "$MOONSHINE_DECODER"
download_moonshine_file "tokenizer.json" "$MOONSHINE_TOKENIZER"

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
echo "[3/4] Mistral-7B-Instruct LLM"
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

# ── Phi-3 Mini Q2_K (bundled default LLM, ~1.41 GB) ─────────────────────
# This is the model bundled with the installer via electron-builder extraResources.
# Users get local polish/AI out of the box with no post-install downloads.
# Mistral above remains available as a higher-quality optional upgrade.
PHI3_FILE="$MODELS_DIR/Phi-3-mini-4k-instruct-Q2_K.gguf"
PHI3_URL="https://huggingface.co/bartowski/Phi-3-mini-4k-instruct-GGUF/resolve/main/Phi-3-mini-4k-instruct-Q2_K.gguf"
PHI3_MIN_BYTES=1200000000

echo "[4/4] Phi-3 Mini Q2_K — bundled default LLM"
if [ -f "$PHI3_FILE" ]; then
    phi3_bytes=$(wc -c < "$PHI3_FILE" | tr -d ' ')
    if [ "$phi3_bytes" -ge $PHI3_MIN_BYTES ]; then
        echo "  [OK] Phi-3 Q2_K already exists: $(du -h "$PHI3_FILE" | cut -f1)"
    else
        echo "  [WARN] Phi-3 file exists but looks truncated ($phi3_bytes bytes) — re-downloading"
        rm -f "$PHI3_FILE"
    fi
fi
if [ ! -f "$PHI3_FILE" ]; then
    echo "  [DOWNLOAD] Phi-3-mini-4k-instruct-Q2_K.gguf (~1.41 GB)"
    echo "    URL: $PHI3_URL"
    echo "    Dest: $PHI3_FILE"
    if command -v curl >/dev/null 2>&1; then
        curl -L --fail -o "${PHI3_FILE}.partial" "$PHI3_URL" \
            && mv "${PHI3_FILE}.partial" "$PHI3_FILE" \
            && echo "    [OK] Downloaded $(du -h "$PHI3_FILE" | cut -f1)" \
            || { rm -f "${PHI3_FILE}.partial"; echo "    [FAIL] Download failed"; exit 1; }
    else
        echo "    curl not found — manual download required:"
        echo "      curl -L -o '$PHI3_FILE' '$PHI3_URL'"
    fi
fi

echo ""

# ── WeSpeaker ResNet34 (optional, M2 speaker diarization on loopback) ───
# Pinned to a specific HuggingFace commit so the bundled bytes are
# reproducible. The file is small (~26 MB) but kept opt-in because the
# remote-meeting capture pipeline is Windows-only today and not every
# downstream packager needs it.
WESPEAKER_DIR="$(dirname "$0")/../electron-app/resources/models/speaker-embedding"
WESPEAKER_SHA="0ae88dcaf48cacdf741275d6d1a8101f45eee220"
WESPEAKER_FILE="$WESPEAKER_DIR/speaker-embedding.onnx"
WESPEAKER_LICENSE="$WESPEAKER_DIR/LICENCE.md"
WESPEAKER_BASE="https://huggingface.co/hbredin/wespeaker-voxceleb-resnet34-LM/resolve/$WESPEAKER_SHA"

if [ "$INCLUDE_WESPEAKER" -eq 1 ]; then
    echo "[+] WeSpeaker ResNet34 — speaker diarization on remote-meeting loopback"
    mkdir -p "$WESPEAKER_DIR"
    if [ ! -f "$WESPEAKER_FILE" ]; then
        echo "  [DOWNLOAD] speaker-embedding.onnx (~26 MB)"
        if command -v curl >/dev/null 2>&1; then
            curl -L --fail -o "${WESPEAKER_FILE}.partial" "$WESPEAKER_BASE/speaker-embedding.onnx" \
                && mv "${WESPEAKER_FILE}.partial" "$WESPEAKER_FILE" \
                || { rm -f "${WESPEAKER_FILE}.partial"; echo "    [FAIL] Download failed"; exit 1; }
        else
            echo "    curl not found — manual download required:"
            echo "      curl -L -o '$WESPEAKER_FILE' '$WESPEAKER_BASE/speaker-embedding.onnx'"
            exit 1
        fi
    fi
    if [ ! -f "$WESPEAKER_LICENSE" ]; then
        echo "  [DOWNLOAD] LICENCE.md (Apache-2.0 attribution — required for redistribution)"
        curl -L --fail -o "$WESPEAKER_LICENSE" "$WESPEAKER_BASE/LICENCE.md" || true
    fi
    if command -v shasum >/dev/null 2>&1; then
        echo "  sha256:  $(shasum -a 256 "$WESPEAKER_FILE" | awk '{print $1}')"
        echo "  → paste this into electron-app/resources/models/models-manifest.json"
        echo "    (wespeaker-resnet34-LM entry) so the postbuild verifier becomes deterministic"
    fi
    echo "  [OK] $(du -h "$WESPEAKER_FILE" | cut -f1) at $WESPEAKER_FILE"
    echo ""
else
    echo "[+] WeSpeaker — SKIPPED (use --include-wespeaker to fetch for M2 speaker diarization)"
    echo ""
fi

echo "Done. After downloading, run:"
echo "  cd rust-core && cargo build --release --features napi-export,whisper,engine-multi"
