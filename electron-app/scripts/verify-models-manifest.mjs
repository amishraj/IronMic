#!/usr/bin/env node
/**
 * Verify every bundled model file against
 * `resources/models/models-manifest.json`. Run from the packaging script
 * (`scripts/package.sh`) BEFORE invoking electron-builder so a checksum
 * mismatch fails the build instead of silently shipping mystery bytes.
 *
 *   npm run verify-models
 *
 * Behavior:
 *  - For every entry whose file exists: re-hash and assert sha256 matches.
 *    A mismatch is a hard error (exit 1).
 *  - For an entry with `optional: true` whose file is missing: log a
 *    warning and continue. The runtime readiness check (M2.5b for
 *    speaker diarization) handles the degraded case gracefully.
 *  - For an entry without `optional: true` whose file is missing: hard
 *    error.
 *  - For every CC-BY-licensed entry whose file is present: confirm
 *    `THIRD_PARTY_NOTICES.md` (at repo root) references it by `id`.
 *
 * Why a separate script rather than inline electron-builder logic:
 * electron-builder's `afterPack` runs AFTER copy, so a mismatch would
 * still ship — running this as a postbuild gate fails earlier and keeps
 * the manifest readable without burying it in JS config.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_APP_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(ELECTRON_APP_ROOT, '..');
const MANIFEST_PATH = path.join(
  ELECTRON_APP_ROOT,
  'resources/models/models-manifest.json',
);
const NOTICES_PATH = path.join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md');

const PLACEHOLDER_SHA = 'REPLACE_WITH_SHA256_AFTER_DOWNLOAD';

function sha256(filePath) {
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`[verify-models] manifest missing: ${MANIFEST_PATH}`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (err) {
    console.error(`[verify-models] manifest JSON parse failed: ${err.message}`);
    process.exit(1);
  }
}

function loadNoticesText() {
  if (!existsSync(NOTICES_PATH)) return null;
  return readFileSync(NOTICES_PATH, 'utf8');
}

/**
 * Whether a license requires preserving an attribution / copyright notice
 * in redistributions of the binary. We treat this generously: every
 * named license we ship under (MIT, Apache-2.0, BSD-3-Clause, CC-BY-*)
 * carries an attribution clause, so the safe rule is to require a
 * THIRD_PARTY_NOTICES entry for every model that has any license
 * string. A null/empty license (purely-internal artifact) is exempt.
 */
function requiresAttribution(license) {
  return typeof license === 'string' && license.trim().length > 0;
}

function main() {
  const manifest = loadManifest();
  if (!Array.isArray(manifest.models) || manifest.models.length === 0) {
    console.error('[verify-models] manifest has no models');
    process.exit(1);
  }

  const noticesText = loadNoticesText();
  let hardErrors = 0;
  let warnings = 0;

  for (const m of manifest.models) {
    const abs = path.resolve(ELECTRON_APP_ROOT, m.path);
    const present = existsSync(abs);

    if (!present) {
      if (m.optional) {
        console.warn(
          `[verify-models] optional model missing — runtime falls back gracefully:\n` +
            `    id=${m.id}\n` +
            `    path=${m.path}\n` +
            `    reason=${m.optionalReason ?? '(none provided)'}`,
        );
        warnings++;
        continue;
      }
      console.error(
        `[verify-models] required model missing:\n` +
          `    id=${m.id}\n    path=${m.path}`,
      );
      hardErrors++;
      continue;
    }

    // Size check (advisory — saves a real-bytes hash on truncated files)
    if (typeof m.sizeBytes === 'number') {
      const actual = statSync(abs).size;
      // Allow ±5% slack — sizes shift by re-export
      const lo = m.sizeBytes * 0.95;
      const hi = m.sizeBytes * 1.05;
      if (actual < lo || actual > hi) {
        console.warn(
          `[verify-models] size out of expected range for ${m.id}: ` +
            `got ${actual}, expected ~${m.sizeBytes}`,
        );
        warnings++;
      }
    }

    // Checksum
    if (!m.sha256 || m.sha256 === PLACEHOLDER_SHA) {
      console.error(
        `[verify-models] ${m.id}: sha256 placeholder — paste the real hash into ` +
          `${path.relative(REPO_ROOT, MANIFEST_PATH)}. ` +
          `Compute it with: shasum -a 256 ${path.relative(REPO_ROOT, abs)}`,
      );
      hardErrors++;
      continue;
    } else {
      const actual = sha256(abs);
      if (actual !== m.sha256) {
        console.error(
          `[verify-models] sha256 mismatch for ${m.id}:\n` +
            `    expected: ${m.sha256}\n` +
            `    actual:   ${actual}`,
        );
        hardErrors++;
        continue;
      }
    }

    // Attribution
    if (requiresAttribution(m.license)) {
      if (!noticesText) {
        console.error(
          `[verify-models] ${m.id} is ${m.license} but ` +
            `${path.relative(REPO_ROOT, NOTICES_PATH)} is missing.`,
        );
        hardErrors++;
      } else if (!noticesText.includes(m.id)) {
        console.error(
          `[verify-models] ${m.id} is ${m.license} but ` +
            `THIRD_PARTY_NOTICES.md does not reference its id — add an ` +
            `attribution block citing this manifest entry.`,
        );
        hardErrors++;
      }
    }

    if (present && (!m.sha256 || m.sha256 !== PLACEHOLDER_SHA)) {
      console.log(`[verify-models] OK  ${m.id}  (${m.path})`);
    }
  }

  if (hardErrors > 0) {
    console.error(
      `\n[verify-models] FAILED — ${hardErrors} error(s), ${warnings} warning(s).`,
    );
    process.exit(1);
  }
  console.log(
    `\n[verify-models] OK — ${manifest.models.length} model(s), ${warnings} warning(s).`,
  );
}

main();
