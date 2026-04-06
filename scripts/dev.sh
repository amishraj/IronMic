#!/bin/bash
# Start IronMic in development mode.
# Builds the Rust addon, compiles Electron main/preload, and launches everything.

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== IronMic Dev Mode ==="
echo ""

# Step 1: Build Rust native addon
echo "[1/4] Building Rust native addon..."
cd "$ROOT/rust-core"
cargo build --release --features metal,tts 2>&1 | tail -5

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
