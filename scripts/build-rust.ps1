# Build the IronMic Rust native addon for Windows.
# Run from the repository root or scripts/ directory.
# Requires: Rust stable + cargo, Visual Studio C++ Build Tools, CMake.

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $scriptDir ".." "rust-core")

Write-Host "Building IronMic Rust core (Windows)..."
Write-Host "Platform: Windows $([System.Environment]::OSVersion.Version)"
Write-Host ""

# Build the N-API addon with whisper + engine-multi (no metal — Metal is Apple-only).
# engine-multi is REQUIRED for Moonshine (the default engine on Windows); without
# it, build_engine() returns NullEngine and dictation fails at transcribe time
# with "Engine 'moonshine-base' is not available". transcribe-rs reuses the same
# ort/ndarray versions tts already pulls in, so there is no dependency conflict.
#
# speaker-diarization compiles rust-core/src/speaker/ (WeSpeaker ResNet34 via ort)
# so remote-meeting capture's loopback path can label voices [Speaker 1..N] live.
# Reuses the same ort dep already pulled in by tts/engine-multi; without this
# feature the speaker module exports a stub that returns Unsupported and the
# meeting recorder falls back to the legacy text-LLM diarization at stop.
cargo build --release --features napi-export,whisper,tts,engine-multi,forge,speaker-diarization

Write-Host ""
Write-Host "Building LLM binary..."
cargo build --release --bin ironmic-llm --features llm-bin

$dll = "target\release\ironmic_core.dll"
$node = "ironmic-core.node"

if (Test-Path $dll) {
    Copy-Item $dll $node -Force
    $size = (Get-Item $node).Length / 1MB
    Write-Host ""
    Write-Host "Native addon: rust-core\$node ($([math]::Round($size,1)) MB)"
} else {
    Write-Host "WARNING: $dll not found — check cargo output above."
    exit 1
}

Write-Host ""
Write-Host "Build complete."
