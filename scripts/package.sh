#!/bin/bash
# Full build pipeline: compile Rust → build Electron → package installer.

set -e

ROOT="$(dirname "$0")/.."
cd "$ROOT"

echo "=========================================="
echo "  IronMic — Full Build Pipeline"
echo "=========================================="
echo ""

# Step 1: Build Rust
echo "[1/3] Building Rust native addon..."
./scripts/build-rust.sh
echo ""

# Step 2: Build Electron
echo "[2/3] Building Electron app..."
cd electron-app
npm install
npm run build
cd ..
echo ""

# Step 3: Package
echo "[3/3] Packaging installer..."
cd electron-app
npx electron-builder --config electron-builder.config.js
cd ..
echo ""

echo "=========================================="
echo "  Build complete!"
echo "  Output: electron-app/release/"
echo "=========================================="
