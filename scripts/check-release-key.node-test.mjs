import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkReleaseKey } from "./check-release-key.mjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

// Independent key fixture, only public bytes are serialized.
function publicArmor({ comment = "Release publisher", uid = "Murage releases", algo = 22 } = {}) {
  const raw = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const key = Buffer.concat([Buffer.from([4, 0x65, 0x53, 0xf1, 0, algo, 9]), Buffer.from("2b06010401da470f01", "hex"), Buffer.from([1, 7, 0x40]), raw]);
  const user = Buffer.from(uid);
  const bytes = Buffer.concat([Buffer.from([0xc6, key.length]), key, Buffer.from([0xcd, user.length]), user]);
  let crc = 0xb704ce;
  for (const b of bytes) {
    crc ^= b << 16;
    for (let i = 0; i < 8; i++) { crc <<= 1; if (crc & 0x1000000) crc ^= 0x1864cfb; }
  }
  const check = Buffer.from([crc >>> 16 & 255, crc >>> 8 & 255, crc & 255]).toString("base64");
  return `-----BEGIN PGP PUBLIC KEY BLOCK-----\nComment: ${comment}\n\n${bytes.toString("base64").match(/.{1,64}/g).join("\n")}\n=${check}\n-----END PGP PUBLIC KEY BLOCK-----\n`;
}

test("release checker rejects the shipped test key, missing files and malformed keys", async () => {
  await assert.rejects(() => checkReleaseKey(), /TEST KEY/i);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./check-release-key.mjs", import.meta.url))], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TEST KEY/i);
  await assert.rejects(() => checkReleaseKey(new URL("./missing-release-key.asc", import.meta.url)), /ENOENT/);
});
test("release checker accepts a non-test Ed25519 public key and rejects either test marker and other algorithms", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "murage-release-key-"));
  t.after(() => safeWipeSync(dir));
  const file = join(dir, "release-key.asc");
  await writeFile(file, publicArmor());
  assert.match((await checkReleaseKey(file)).fingerprint, /^[a-f0-9]{40}$/);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./check-release-key.mjs", import.meta.url)), file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  for (const options of [{ comment: "MURAGE TEST KEY - NOT FOR RELEASE" }, { uid: "Murage TEST KEY (do not ship)" }, { algo: 1 }]) {
    await writeFile(file, publicArmor(options));
    await assert.rejects(() => checkReleaseKey(file));
  }
  await writeFile(file, "not a key");
  await assert.rejects(() => checkReleaseKey(file));
});
test("release packaging runs the shipped-key guard in all three jobs before packaging", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  for (const job of ["mac", "windows", "linux"]) {
    const body = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [a-z][a-z-]*:\n/)[0];
    const guard = body.indexOf("run: node scripts/check-release-key.mjs");
    assert.ok(guard >= 0, `${job} guard is present`);
    assert.ok(guard < body.indexOf("- name: Package"), `${job} guard precedes packaging`);
  }
  const builder = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.match(builder, /\n  - electron\/\*\*/);
});

test("the test key is refused by fingerprint even with its labels stripped", async () => {
  const { TEST_KEY_FINGERPRINTS } = await import("./check-release-key.mjs");
  const { parseReleaseKey } = await import("../electron/update-signature.mjs");
  const { readFile } = await import("node:fs/promises");
  const shipped = parseReleaseKey(await readFile(new URL("../electron/release-key.asc", import.meta.url)));
  assert.ok(TEST_KEY_FINGERPRINTS.includes(shipped.fingerprint));
});
