#!/bin/bash
# Full build pipeline: compile Rust → build Electron → package installer.

set -e

ROOT="$(dirname "$0")/.."
cd "$ROOT"

echo "=========================================="
echo "  IronMic — Full Build Pipeline"
echo "=========================================="
echo ""

# Step 1: Stage Moonshine Base + verify presence.
# The default transcription engine MUST ship in the installer. We run
# download-models.sh (idempotent — skips files already on disk) and then
# verify each of the three required filenames exists with non-zero size.
# Without this guarantee, electron-builder silently skips a missing
# `extraResources` `from` directory and produces a Moonshine-less installer.
echo "[1/4] Staging Moonshine Base for bundling..."
./scripts/download-models.sh
MOONSHINE_DIR="$ROOT/rust-core/models/moonshine-base"
REQUIRED_FILES=(
    "encoder_model.onnx"
    "decoder_model_merged.onnx"
    "tokenizer.json"
)
for f in "${REQUIRED_FILES[@]}"; do
    full="$MOONSHINE_DIR/$f"
    if [ ! -s "$full" ]; then
        echo ""
        echo "ERROR: required Moonshine file is missing or empty:"
        echo "       $full"
        echo "       The packaged installer would ship without a working default"
        echo "       transcription engine. Aborting before electron-builder runs."
        echo ""
        echo "       Re-run scripts/download-models.sh and check the network."
        exit 1
    fi
done
echo "  All 3 Moonshine Base files present in $MOONSHINE_DIR"
echo ""

# Step 1b: Verify Phi-3 Mini Q2_K (bundled default LLM).
PHI3_FILE="$ROOT/rust-core/models/Phi-3-mini-4k-instruct-Q2_K.gguf"
phi3_bytes=$(wc -c < "$PHI3_FILE" 2>/dev/null | tr -d ' ' || echo 0)
if [ "$phi3_bytes" -lt 1200000000 ]; then
    echo ""
    echo "ERROR: Phi-3 Mini Q2_K model is missing or truncated ($phi3_bytes bytes)."
    echo "       The packaged installer would ship without a bundled default LLM."
    echo "       Re-run scripts/download-models.sh and check the network."
    echo ""
    exit 1
fi
echo "  Phi-3 Q2_K present: $(du -h "$PHI3_FILE" | cut -f1)"
echo ""

# Step 2: Build Rust
echo "[2/4] Building Rust native addon..."
./scripts/build-rust.sh
echo ""

# Step 3: Build Electron
echo "[3/4] Building Electron app..."
cd electron-app
npm install
npm run build
cd ..
echo ""

# Step 4: Package
echo "[4/4] Packaging installer..."
cd electron-app
npx electron-builder --config electron-builder.config.js
cd ..
echo ""

echo "=========================================="
echo "  Build complete!"
echo "  Output: electron-app/release/"
echo "=========================================="
