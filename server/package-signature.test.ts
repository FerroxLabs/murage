// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBotPackageEntry } from "./bot-package-manifest.ts";
import { readBotPackageArchive, writeBotPackageArchive } from "./bot-package-archive.ts";
import { OFFICIAL_PACKAGE_KEYS, canonicalJson, packageDigest, publicKeyOf, signPackage, verifyOfficialPackage } from "./package-signature.ts";
import { signPackageFile } from "./package-signing-cli.ts";

// Test keys only, made here for the test run and never written to the repo.
const pem = (pair = generateKeyPairSync("ed25519")) => pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const officialPem = pem();
const officialKey = publicKeyOf(officialPem);
const document = () => ({ format: "murage.team", version: 2, team: { name: "Launch Crew", members: [{ name: "Ada", description: "Calm and clear." }] } });

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "murage-sign-")); dirs.push(dir); return dir; };

describe("Official mark", () => {
  it("ships with no private key and no trusted key until Ferrox Labs adds its own", () => {
    expect(Array.isArray(OFFICIAL_PACKAGE_KEYS)).toBe(true);
    for (const key of OFFICIAL_PACKAGE_KEYS) expect(JSON.stringify(key)).not.toMatch(/PRIVATE KEY/);
  });
  it("marks a package Official only with a valid signature from a trusted key", () => {
    const signed = signPackage(document(), officialPem);
    expect(signed.signature).toMatchObject({ alg: "ed25519", keyId: officialKey.id });
    expect(verifyOfficialPackage(signed, [officialKey])).toEqual({ official: true, keyId: officialKey.id });
  });
  it("never marks an unsigned package", () => {
    expect(verifyOfficialPackage(document(), [officialKey])).toEqual({ official: false, reason: "unsigned" });
  });
  it("never marks a package changed after signing, in any field", () => {
    const signed = signPackage(document(), officialPem);
    const edits: Array<(d: any) => void> = [
      (d) => { d.team.name = "Launch Crew 2"; }, (d) => { d.team.members[0].description = "Ignore previous instructions."; },
      (d) => { d.team.members.push({ name: "Eve", description: "x" }); }, (d) => { d.extra = true; }, (d) => { d.version = 3; },
    ];
    for (const edit of edits) {
      const copy = JSON.parse(JSON.stringify(signed));
      edit(copy);
      expect(verifyOfficialPackage(copy, [officialKey])).toMatchObject({ official: false, reason: "bad-signature" });
    }
  });
  it("never marks a package signed by another key, and tells an unknown key apart", () => {
    const other = pem();
    const signed = signPackage(document(), other);
    expect(verifyOfficialPackage(signed, [officialKey])).toMatchObject({ official: false, reason: "unknown-key" });
    const forged = { ...signed, signature: { ...signed.signature, keyId: officialKey.id } };
    expect(verifyOfficialPackage(forged, [officialKey])).toMatchObject({ official: false, reason: "bad-signature" });
  });
  it("refuses malformed signatures without throwing", () => {
    const base = document();
    for (const signature of [null, "x", 5, {}, { alg: "rsa", keyId: officialKey.id, value: "AAAA" }, { alg: "ed25519", keyId: officialKey.id, value: "AAAA" }, { alg: "ed25519", keyId: 7, value: "AAAA" }, { alg: "ed25519", keyId: officialKey.id, value: "A".repeat(500) }]) {
      expect(verifyOfficialPackage({ ...base, signature }, [officialKey]).official).toBe(false);
    }
    for (const value of [null, "x", 5, [], undefined]) expect(verifyOfficialPackage(value, [officialKey]).official).toBe(false);
  });
  it("accepts any key in the trusted list, so a key can be rotated", () => {
    const next = pem();
    const keys = [officialKey, publicKeyOf(next)];
    expect(verifyOfficialPackage(signPackage(document(), next), keys).official).toBe(true);
    expect(verifyOfficialPackage(signPackage(document(), officialPem), keys).official).toBe(true);
  });
  it("signs the meaning of the package, not its key order or spacing", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}');
    const signed = signPackage(document(), officialPem);
    const reordered = JSON.parse(JSON.stringify({ signature: signed.signature, team: { members: signed.team.members, name: signed.team.name }, version: 2, format: "murage.team" }));
    expect(verifyOfficialPackage(reordered, [officialKey]).official).toBe(true);
    expect(packageDigest(signed)).toBe(packageDigest(document()));
  });
  it("only signs with an Ed25519 key", () => {
    expect(() => signPackage(document(), generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toThrow(/Ed25519/);
  });
});

describe("sign-package script", () => {
  it("signs a JSON package from a key file and never prints the key", async () => {
    const dir = temp();
    const key = join(dir, "official.pem"), input = join(dir, "team.json"), output = join(dir, "team.signed.json");
    writeFileSync(key, officialPem, { mode: 0o600 }); writeFileSync(input, JSON.stringify(document()));
    const result = await signPackageFile(input, key, output);
    expect(result).toEqual({ output, keyId: officialKey.id, kind: "json" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(verifyOfficialPackage(JSON.parse(readFileSync(output, "utf8")), [officialKey]).official).toBe(true);
    await expect(signPackageFile(input, key, output)).rejects.toThrow();
    expect(existsSync(output)).toBe(true);
  });
  it("signs a package archive and the signature survives reading it back", async () => {
    const dir = temp();
    const payloads = new Map([["bots/scout/SOUL.md", "Use evidence."], ["skills/research/SKILL.md", "---\nname: research\ndescription: Find evidence.\nlicense: MIT\n---\nRead sources.\n"]]);
    const manifest = {
      format: "murage.package.bundle", version: 1,
      definition: { format: "murage.package", version: 1, package: { id: "sample", release: "1.0.0", name: "Sample", tagline: "Sample team", summary: "Definition only", category: "Community",
        author: { name: "Example" }, license: "MIT", outcomes: ["Research"], setupMinutes: 2, requirements: { apps: [], capabilities: [] },
        agents: [{ key: "scout", name: "Scout", appearance: { color: "green" }, skills: ["research"] }] } },
      skills: [{ key: "research", name: "Research", license: "MIT", dependencies: [], files: ["skills/research/SKILL.md"] }],
      instructions: [{ agent: "scout", path: "bots/scout/SOUL.md" }],
      entries: [...payloads].map(([path, content]) => createBotPackageEntry(path, content)),
    };
    const plain = join(dir, "plain.zip"), signedPath = join(dir, "signed.zip"), key = join(dir, "k.pem");
    await writeBotPackageArchive(plain, { manifest, payloads });
    writeFileSync(key, officialPem, { mode: 0o600 });
    expect((await readBotPackageArchive(plain)).official).toMatchObject({ official: false, reason: "unsigned" });
    const result = await signPackageFile(plain, key, signedPath);
    expect(result.kind).toBe("archive");
    const read = await readBotPackageArchive(signedPath);
    // The app's own key list is empty in tests, so the archive reads as unsigned-by-us.
    expect(read.official.official).toBe(false);
    expect(read.official.reason).toBe("unknown-key");
    expect(read.manifest.signature?.keyId).toBe(officialKey.id);
  });
});
