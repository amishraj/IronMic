#!/bin/bash
# Compile the Rust native addon for the current platform.

set -e

cd "$(dirname "$0")/../rust-core"

echo "Building IronMic Rust core..."
echo "Platform: $(uname -s) $(uname -m)"
echo ""

# macOS C++ toolchain fix:
# Some CLT installs have an empty /usr/include/c++/v1/ (missing <future>, <string>, etc.).
# Point the compiler at the SDK's C++ headers to work around it.
if [ "$(uname -s)" = "Darwin" ]; then
    export SDKROOT="${SDKROOT:-$(xcrun --show-sdk-path)}"
    export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
    export CPLUS_INCLUDE_PATH="${SDKROOT}/usr/include/c++/v1:${CPLUS_INCLUDE_PATH}"
fi

# Build the native addon in release mode
# Build the N-API addon (whisper + TTS, no LLM to avoid ggml collision)
cargo build --release --features napi-export,metal,tts

# Build the standalone LLM binary (separate process)
echo ""
echo "Building LLM binary..."
cargo build --release --bin ironmic-llm --features llm-bin

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
