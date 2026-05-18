# WeSpeaker ResNet34 — Speaker Embedding Model

This directory bundles the WeSpeaker ResNet34 ONNX speaker-embedding model
used by IronMic's remote-meeting capture path to label voices
`[Speaker 1..N]` live. The Rust loader lives in
[`rust-core/src/speaker/wespeaker.rs`](../../../../rust-core/src/speaker/wespeaker.rs)
and runs inference via the existing `ort` ONNX Runtime dependency.

## Bundled file

| File | Source | License |
|------|--------|---------|
| `speaker-embedding.onnx` | [hbredin/wespeaker-voxceleb-resnet34-LM](https://huggingface.co/hbredin/wespeaker-voxceleb-resnet34-LM) @ `0ae88dca…` | Apache-2.0 |

The commit revision is pinned in
[`../models-manifest.json`](../models-manifest.json) so the bundled bytes
are reproducible.

## How to fetch (one-time)

```sh
# Fetch the pinned revision directly:
curl -L -o speaker-embedding.onnx \
  "https://huggingface.co/hbredin/wespeaker-voxceleb-resnet34-LM/resolve/0ae88dcaf48cacdf741275d6d1a8101f45eee220/speaker-embedding.onnx"

# Also fetch the LICENSE / model card (Apache-2.0 requires preserving them
# in redistributions of the binary):
curl -L -o LICENCE.md \
  "https://huggingface.co/hbredin/wespeaker-voxceleb-resnet34-LM/resolve/0ae88dcaf48cacdf741275d6d1a8101f45eee220/LICENCE.md"

# Compute the SHA-256 and paste it into models-manifest.json's
# `wespeaker-resnet34-LM` entry (replace the REPLACE_WITH_SHA256_AFTER_DOWNLOAD
# placeholder):
shasum -a 256 speaker-embedding.onnx
```

Or, equivalently, run the convenience script from the repo root:

```sh
scripts/download-models.sh --include-wespeaker
```

which downloads the file + LICENSE to this directory and prints the
hash. The maintainer still has to paste the hash into the manifest
manually so the postbuild verifier becomes deterministic.

Place the resulting `voxceleb_resnet34_LM.onnx` in this directory. The
electron-builder `extraResources` glob filter (`*.onnx`, `*.md`,
`LICENSE*`) means a missing file is silently skipped at package time and
the M2.5b runtime readiness check declines to flip
`meeting_diarization_mode` to `'embedding'` — diarization falls back to
the legacy text-LLM pass at stop.

## License attribution

CC-BY 4.0 requires attribution on redistribution. Attribution is carried
in [`THIRD_PARTY_NOTICES.md`](../../../../THIRD_PARTY_NOTICES.md) at the
repo root. Also preserve any `LICENSE` / model-card metadata files
shipped alongside the ONNX (the glob filter includes `LICENSE*` and
`*.md`).

## Why pin a commit SHA, not `main`

Hugging Face revisions are mutable on `main`. Pinning a commit SHA means
the manifest's `sourceRevision` is the exact bytes shipped, and
`scripts/verify-models-manifest.js` re-hashes at package time to confirm.
