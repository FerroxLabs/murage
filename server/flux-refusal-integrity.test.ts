import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("./__fixtures__/flux-refusals/prod-00000000/", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("M14 production refusal provenance", () => {
  it("imports the complete upstream evidence verbatim, with a digest and endpoint provenance for every file", () => {
    const provenance = JSON.parse(read("PROVENANCE.json").toString());
    const manifest = JSON.parse(read("MANIFEST.json").toString());
    const cases = Object.keys(provenance.files).sort();
    expect(cases).toHaveLength(20);
    expect(Object.keys(manifest.files).sort()).toEqual([...cases, "PROVENANCE.json"].sort());
    expect(readdirSync(root).filter(f => f !== "siblings").sort()).toEqual([...cases, "PROVENANCE.json", "MANIFEST.json"].sort());
    for (const [file, entry] of Object.entries(manifest.files) as Array<[string, { sha256: string; source: string; fixture_set: string; capture_method: unknown; redaction: string }]>) {
      expect(sha(read(file)), file).toBe(entry.sha256);
      expect(entry.source).toBe(`build-host:/root/fuigo-builds/swarm-b/busyloop-capture/flux-prod-429/${file}`);
      expect(entry.fixture_set).toBe("000000005e57485741d2ec74492392de7c049946");
      expect(entry.redaction).toBe("KEYHASH_REDACTED, <HTTP-date>");
      if (file !== "PROVENANCE.json") expect(entry.capture_method).toEqual(provenance.files[file].capture_method);
    }
  });
});

it('M14: sibling and executable-spec files match the imported sha256 manifest', () => {
  const base = new URL('./__fixtures__/flux-refusals/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('INTEGRITY.json', base), 'utf8'));
  for (const [file, digest] of Object.entries(manifest)) expect(sha(readFileSync(new URL(file, base))), file).toBe(digest);
});
