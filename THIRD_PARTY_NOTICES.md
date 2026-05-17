# Third-Party Notices

This file carries attribution for third-party model artifacts bundled
into IronMic. Source code dependencies are governed by their respective
`LICENSE` files and the project license at [`LICENSE`](LICENSE).

The authoritative list of bundled model files (with paths, sha256
checksums, license identifiers, source URLs, and pinned source
revisions) lives in
[`electron-app/resources/models/models-manifest.json`](electron-app/resources/models/models-manifest.json).
The packaging script `scripts/package.sh` runs
[`electron-app/scripts/verify-models-manifest.mjs`](electron-app/scripts/verify-models-manifest.mjs)
before invoking electron-builder, which re-hashes each entry and
asserts that every CC-BY-licensed entry is referenced (by `id`) in
this file.

---

## Speech-to-text models

### Moonshine Base (Useful Sensors)

- **License:** MIT
- **Source:** https://github.com/usefulsensors/moonshine
- **Bundled paths:**
  `electron-app/resources/models/moonshine-base/{encoder_model,decoder_model_merged}.onnx`,
  `tokenizer.json`
- **Purpose:** Default speech-to-text engine. Bundled so first-launch
  dictation works fully offline.

### Whisper models (OpenAI / whisper.cpp)

- **License:** MIT (whisper.cpp); model weights MIT (OpenAI)
- **Source:** https://github.com/ggerganov/whisper.cpp
- **Bundled paths:** None bundled — users download via
  [`scripts/download-models.sh`](scripts/download-models.sh) or the
  in-app model manager. Whisper is the recommended engine for
  remote-meeting capture because its segment timestamps drive
  speaker-embedding slicing.

---

## Speaker-embedding models

### `wespeaker-resnet34-LM` — WeSpeaker ResNet34 (VoxCeleb)

- **Manifest entry:** `wespeaker-resnet34-LM`
- **License:** Apache-2.0 — https://www.apache.org/licenses/LICENSE-2.0
- **Source artifact:**
  https://huggingface.co/hbredin/wespeaker-voxceleb-resnet34-LM
  → `speaker-embedding.onnx` (pinned commit
  `0ae88dcaf48cacdf741275d6d1a8101f45eee220`)
- **Upstream project:** WeSpeaker — https://github.com/wenet-e2e/wespeaker
- **Authors / attribution:** Hongji Wang, Chengdong Liang, Shuai Wang,
  Zhengyang Chen, Binbin Zhang, Xu Xiang, Yanlei Hong, Lei Xie (WeSpeaker
  contributors). ONNX export published by Hervé Bredin and the pyannote
  team.
- **Bundled path:**
  `electron-app/resources/models/speaker-embedding/speaker-embedding.onnx`
- **Purpose:** Acoustic speaker-embedding inference for the remote-meeting
  capture loopback path. Produces a 256-d L2-normalized embedding per
  Whisper transcript segment; the renderer-side `SpeakerClusterer`
  clusters embeddings into `[Speaker N]` labels with end-of-meeting AHC
  refinement.
- **Consumer:** [`rust-core/src/speaker/wespeaker.rs`](rust-core/src/speaker/wespeaker.rs)
  (lazy `ort::Session`) and
  [`electron-app/src/main/SpeakerClusterer.ts`](electron-app/src/main/SpeakerClusterer.ts)
  (clustering + AHC refinement).
- **Citation:**
  Wang, H. et al. "WeSpeaker: A Research and Production-Oriented Speaker
  Embedding Learning Toolkit." ICASSP 2023.

Apache-2.0 requires attribution and preservation of the upstream license
in redistributions of the binary. IronMic redistributes the ONNX file
unmodified; this notice carries the attribution and the bundled
`LICENSE` / model-card files are preserved in
`electron-app/resources/models/speaker-embedding/` and copied to
user-data on first launch by `ensureBundledWeSpeaker()`.

---

## Text-to-speech models

### Kokoro (StyleTTS 2)

- **License:** Apache 2.0
- **Source:** https://huggingface.co/hexgrad/Kokoro-82M
- **Bundled paths:** `electron-app/resources/models/voices/*.bin` and
  Kokoro ONNX in the TTS path
- **Purpose:** On-device speech synthesis for the TTS read-aloud feature.

---

## TensorFlow.js models

The bundled TF.js model archives under
`electron-app/resources/ml-models/*.tar.gz` (Silero VAD, Universal
Sentence Encoder, intent classifier, meeting detector, etc.) carry
their own LICENSE files inside the archives. Each model's upstream
repository is listed in
[`electron-app/src/main/model-downloader.ts`](electron-app/src/main/model-downloader.ts).

---

## How to update this file

When bundling a new model, also:
1. Add an entry to
   [`electron-app/resources/models/models-manifest.json`](electron-app/resources/models/models-manifest.json)
   with `sha256`, `sourceUrl`, and `sourceRevision`.
2. Reference the manifest entry's `id` here. If the license is CC-BY*,
   the postbuild verifier will fail the build if the `id` isn't found
   in this file.
