#!/bin/bash
# Compile the Rust native addon for the current platform.

set -e

cd "$(dirname "$0")/../rust-core"

echo "Building IronMic Rust core..."
echo "Platform: $(uname -s) $(uname -m)"
echo ""

# Build the native addon in release mode
cargo build --release

echo ""
echo "Build complete."
echo ""

# Find the compiled library
if [ "$(uname -s)" = "Darwin" ]; then
    LIB="target/release/libironmic_core.dylib"
    NODE_FILE="ironmic-core.node"
elif [ "$(uname -s)" = "Linux" ]; then
    LIB="target/release/libironmic_core.so"
    NODE_FILE="ironmic-core.node"
else
    LIB="target/release/ironmic_core.dll"
    NODE_FILE="ironmic-core.node"
fi

if [ -f "$LIB" ]; then
    cp "$LIB" "$NODE_FILE"
    echo "Native addon copied to: rust-core/$NODE_FILE"
    echo "Size: $(du -h "$NODE_FILE" | cut -f1)"
else
    echo "Warning: Expected library not found at $LIB"
    echo "The cdylib may have a different name. Check target/release/"
fi
