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
