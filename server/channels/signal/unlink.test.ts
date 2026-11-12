// SPDX-License-Identifier: AGPL-3.0-or-later
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { authorizeUnlink, isAuthorizedUnlink } from './unlink.ts';
// @ts-expect-error Shared ESM verifier.
import { artifactBinding, verifySignalEvidence } from './evidence.mjs';
// @ts-expect-error Synthetic helper shared with staging tests.
import { makeSyntheticEvidence } from '../../../scripts/fixtures/signal-test-evidence.mjs';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => removeTempDirSync(root)));
function fixture() { const root = mkdtempSync(join(tmpdir(), 'signal-synthetic-unlink-')); roots.push(root); return { root, ...makeSyntheticEvidence(root) }; }
test('T-UNLINK-LINKED-ROLE/T-UNLINK-PROOF: only registered objects and live linked devices authorize', () => {
 const f = fixture(), request = authorizeUnlink(f.pin, verifySignalEvidence(f.pin, f.root));
 expect(request).toEqual({ method: 'unregister', params: {} });
 for (const id of [2, 7, 42]) expect(isAuthorizedUnlink(request, id)).toBe(true);
 for (const id of [1, 0, -1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(isAuthorizedUnlink(request, id)).toBe(false);
 expect(isAuthorizedUnlink({ ...request! }, 7)).toBe(false);
 expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request!.params)).toBe(true);
});
test('T-UNLINK-VERIFIED-INPUT/T-UNLINK-EMBEDDED-PROOF: copied, changed, or unrelated proof bytes cannot authorize', () => {
 const f = fixture(), verified = verifySignalEvidence(f.pin, f.root);
 expect(authorizeUnlink(f.pin, verified)).toBeDefined();
 expect(authorizeUnlink(f.pin, { ...verified })).toBeUndefined();
 expect(authorizeUnlink(f.pin, { ...verified, manifest: { ...verified.manifest, unlinkProof: {} } })).toBeUndefined();
 const changed = structuredClone(f.pin); changed.g0.manifestSha256 = '0'.repeat(64);
 expect(authorizeUnlink(changed, verified)).toBeUndefined();
 changed.g0 = f.pin.g0; changed.targets['linux-x64'].jars[0].sha256 = '0'.repeat(64);
 expect(authorizeUnlink(changed, verified)).toBeUndefined();
 verified.manifestBytes[0] ^= 1;
 expect(authorizeUnlink(f.pin, verified)).toBeUndefined();
});
test.each(['delete-account', 'deleteAccount', 'delete_account', 'account', 'deviceId'])('T-UNLINK-PROOF: no %s option, even false', key => {
 const f = fixture(); f.manifest.unlinkProof.params[key] = false; f.save();
 expect(() => verifySignalEvidence(f.pin, f.root)).toThrow();
});
test.each(['jar', 'archive'])('T-UNLINK-VERIFIED-INPUT: pin A evidence cannot authorize pin B with changed %s bytes', kind => {
 const f = fixture(), verified = verifySignalEvidence(f.pin, f.root);
 expect(authorizeUnlink(f.pin, verified)).toBeDefined();
 const pinB = structuredClone(f.pin);
 if (kind === 'jar') pinB.targets['linux-x64'].jars[0].sha256 = '0'.repeat(64);
 else pinB.releaseInputs['linux-x64'].sha256 = '0'.repeat(64);
 pinB.g0.artifactSha256 = artifactBinding(pinB);
 expect(pinB.g0.artifactSha256).not.toBe(f.pin.g0.artifactSha256);
 expect(pinB.g0.manifestSha256).toBe(f.pin.g0.manifestSha256);
 expect(authorizeUnlink(pinB, verified)).toBeUndefined();
 expect(authorizeUnlink(f.pin, verified)).toBeDefined();
});
