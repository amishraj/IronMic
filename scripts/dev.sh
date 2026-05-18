#!/bin/bash
# Start IronMic in development mode.
# Builds the Rust addon, compiles Electron main/preload, and launches everything.

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# macOS: Command Line Tools sometimes ship with a stub libc++ at
# /Library/Developer/CommandLineTools/usr/include/c++/v1/ that's missing
# headers like <string> and <future>, breaking whisper.cpp / llama.cpp builds.
# The full libc++ lives in the SDK; point cc-rs at it explicitly.
if [ "$(uname -s)" = "Darwin" ]; then
    SDK_PATH="$(xcrun --show-sdk-path 2>/dev/null || echo '')"
    if [ -n "$SDK_PATH" ] && [ -d "$SDK_PATH/usr/include/c++/v1" ]; then
        export SDKROOT="$SDK_PATH"
        export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
        export CXXFLAGS="-isystem $SDK_PATH/usr/include/c++/v1 ${CXXFLAGS:-}"
        export CFLAGS="-isystem $SDK_PATH/usr/include/c++/v1 ${CFLAGS:-}"
    fi
fi

echo "=== IronMic Dev Mode ==="
echo ""

# Step 1: Build Rust native addon
echo "[1/4] Building Rust native addon..."
cd "$ROOT/rust-core"
# engine-multi is REQUIRED for Moonshine — it gates the Moonshine ONNX adapter
# in rust-core/src/transcription/engine.rs. Without it, build_engine() returns
# NullEngine for any moonshine-* kind and dictation produces silent empty
# chunks (transcribeWithTimeout swallows the rejection). metal pulls in
# whisper for the multilingual fallback path; tts pulls in ort+ndarray which
# transcribe-rs also uses, so there's no version conflict.
cargo build --release --features napi-export,metal,tts,engine-multi 2>&1 | tail -5

# Build LLM binary separately (avoids ggml symbol collision with whisper).
# This is what powers polish-now and the meeting live summarizer; if it
# isn't built, both features fail silently. Verify the binary exists after
# the build so we don't proceed to launch with a broken LLM pipeline.
echo "  Building LLM binary..."
cargo build --release --bin ironmic-llm --features llm-bin 2>&1 | tail -3
LLM_BIN="$ROOT/rust-core/target/release/ironmic-llm"
if [ ! -x "$LLM_BIN" ]; then
    echo ""
    echo "ERROR: LLM binary build reported success but $LLM_BIN is missing or not executable."
    echo "       Polish-now and meeting live summary will not work without it."
    echo "       If a previous Electron instance is running, quit it and re-run this script."
    exit 1
fi

# Copy the dylib as a .node file
if [ "$(uname -s)" = "Darwin" ]; then
    cp target/release/libironmic_core.dylib ironmic-core.node 2>/dev/null || true
elif [ "$(uname -s)" = "Linux" ]; then
    cp target/release/libironmic_core.so ironmic-core.node 2>/dev/null || true
else
    cp target/release/ironmic_core.dll ironmic-core.node 2>/dev/null || true
fi
echo "  Done."

# Step 2: Install npm deps if needed
cd "$ROOT/electron-app"
if [ ! -d node_modules ]; then
    echo ""
    echo "[2/4] Installing npm dependencies..."
    npm install
else
    echo "[2/4] npm dependencies already installed."
fi

# Step 3: Compile main process + preload
echo "[3/4] Compiling Electron main & preload..."
npx tsc -p tsconfig.main.json
npx tsc -p tsconfig.preload.json
echo "  Done."

# Step 4: Launch Vite + Electron
echo "[4/4] Launching..."
echo ""
echo "  Vite dev server → http://localhost:5173"
echo "  Electron window will open shortly."
echo "  Press Ctrl+C to stop."
echo ""

npx concurrently \
    --names "vite,electron" \
    --prefix-colors "cyan,green" \
    "npx vite" \
    "sleep 3 && NODE_ENV=development npx electron ."
