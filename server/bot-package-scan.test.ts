// secret-scan: fixture (example host paths are deliberate scanner inputs)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanBotPackageContents } from "./bot-package-scan.ts";
import { MAX_BOT_PACKAGE_ENTRIES, MAX_BOT_PACKAGE_EXPANDED_BYTES } from "./bot-package-manifest.ts";

describe("selected package content scan", () => {
  it("blocks credential canaries in nested manifest instructions and files without echoing them", () => {
    const secret = "sk-proj-" + "FAKECANARY".repeat(8);
    const result = scanBotPackageContents([
      { path: "manifest.json", content: JSON.stringify({ agents: [{ instructions: `Use ${secret}` }] }) },
      { path: "skills/auth.md", content: "First line\nAuthorization: Bearer fake_canary_token_1234567890" },
      { path: "skills/private.pem", content: "-----BEGIN PRIVATE KEY-----\nfake only" },
      { path: "skills/cookie.txt", content: "sessionid=fake_canary_session_1234567890" },
    ]);
    expect(result.blocked).toBe(true);
    expect(result.findings.map(item => item.rule)).toEqual(expect.arrayContaining(["provider-token", "bearer-token", "private-key", "session-cookie"]));
    expect(result.findings.find(item => item.rule === "bearer-token")?.line).toBe(2);
    expect(JSON.stringify(result)).not.toContain("FAKECANARY");
    expect(JSON.stringify(result)).not.toContain("fake_canary");
  });
  it("requires review for machine paths and environment dependencies, not benign API-key prose", () => {
    const result = scanBotPackageContents([{ path: "instructions.md", content: "Get an API key from your provider.\nRead process.env.MY_KEY or ${MY_KEY}; local data: /Users/example/work" }]);
    expect(result.blocked).toBe(false); expect(result.reviewRequired).toBe(true);
    expect(result.findings.map(item => item.rule)).toEqual(expect.arrayContaining(["environment-lookup", "machine-local-path"]));
    expect(scanBotPackageContents([{ path: "README.md", content: 'API key: <your key>\napi_key=""\nBearer <token>' }]).findings).toEqual([]);
  });
  it("fails closed for uninspected binaries, bytes and excessive files", () => {
    expect(scanBotPackageContents([{ path: "image.png", content: new Uint8Array([137, 80, 0, 255]) }]).blocked).toBe(true);
    expect(scanBotPackageContents([{ path: "document.pdf", content: "%PDF-1.7\nplain ASCII still needs binary review" }]).blocked).toBe(true);
    const tooMany = Array.from({ length: MAX_BOT_PACKAGE_ENTRIES + 1 }, () => ({ path: "a.txt", content: "" }));
    expect(scanBotPackageContents(tooMany)).toMatchObject({ blocked: true, truncated: true });
    expect(scanBotPackageContents([{ path: "large.txt", content: new Uint8Array(MAX_BOT_PACKAGE_EXPANDED_BYTES + 1) }])).toMatchObject({ blocked: true, truncated: true });
  });
  it("caps findings and sanitizes credential-bearing or local finding paths", () => {
    const secret = "sk-" + "F".repeat(40);
    const result = scanBotPackageContents([{ path: `${secret}.txt`, content: "Bearer fake_canary_token_1234567890\n".repeat(1100) }]);
    expect(result).toMatchObject({ blocked: true, truncated: true });
    expect(result.findings).toHaveLength(1000);
    expect(result.findings[0].path).toBe("entry-1");
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("reads JSON escapes as text, so a built-in Library bot's newlines are not drive paths", () => {
    // In raw JSON "Mind:\n\n-" is the characters d, :, \, n — once read as a d:\ path.
    const prose = { instructions: "Mind:\n\n- one\nSteps:\n1. two\nSee a:\tb" };
    expect(scanBotPackageContents([{ path: "manifest.json", content: JSON.stringify(prose) }]).findings).toEqual([]);
    // Plain text keeps the drive rule, but a letter inside a word is not a drive.
    expect(scanBotPackageContents([{ path: "notes.md", content: 'printf("Steps:\\n")' }]).findings).toEqual([]);
  });
  it("still flags real machine paths in JSON and text, grouped into one row with the matched text", () => {
    const manifest = JSON.stringify({ a: "Open C:\\Users\\example\\work now", b: "and /Users/example/notes", c: "and /Users/example/notes again", d: "keys in ~/.config/example/key.json" });
    expect(manifest).toContain("C:\\\\Users");
    const result = scanBotPackageContents([{ path: "manifest.json", content: manifest }, { path: "notes.md", content: "x\nsee C:\\Users\\example\\a.txt\nand D:\\data" }]);
    expect(result).toMatchObject({ blocked: false, reviewRequired: true });
    const json = result.findings.filter((f) => f.path === "manifest.json");
    expect(json).toEqual([{ path: "manifest.json", rule: "machine-local-path", severity: "review", offset: manifest.indexOf('"Open'), line: 1, evidence: "C:\\Users\\example\\work", count: 4 }]);
    const md = result.findings.filter((f) => f.path === "notes.md");
    expect(md).toEqual([{ path: "notes.md", rule: "machine-local-path", severity: "review", offset: 6, line: 2, evidence: "C:\\Users\\example\\a.txt", count: 2 }]);
    // Escaped slashes do not hide a path any more.
    expect(scanBotPackageContents([{ path: "m.json", content: '{"a":"\\/Users\\/example"}' }]).findings.map((f) => f.evidence)).toEqual(["/Users/example"]);
    // A file that is not valid JSON is read as plain text, as before.
    expect(scanBotPackageContents([{ path: "bad.json", content: '{"a":"/Users/example" ' }]).findings.map((f) => f.rule)).toEqual(["machine-local-path"]);
  });
  it("keeps block findings one per match, read from the raw JSON text", () => {
    const secret = "sk-proj-" + "FAKECANARY".repeat(8);
    const result = scanBotPackageContents([{ path: "manifest.json", content: JSON.stringify({ a: `Use ${secret}`, b: `and ${secret}` }) }]);
    expect(result.blocked).toBe(true);
    expect(result.findings.filter((f) => f.rule === "provider-token")).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("FAKECANARY");
  });
  it("imports every built-in Library bot with no machine-local-path finding except the listed home-folder mentions", () => {
    // Moltbook names its credentials file under the user's home folder on
    // purpose; unsigned packages keep that warning (botscan-1020 DECISIONS).
    // Those builtins are being removed, so each is expected only while present.
    const deliberate: Record<string, string> = {
      "moltbook.json": "~/.config/moltbook/credentials.json`",
      "moltbook-skills.json": "~/.config/moltbook/credentials.json`",
    };
    const dir = join(process.cwd(), "bot-library", "builtins");
    const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
    expect(files.length).toBeGreaterThan(100);
    const found: Record<string, string> = {};
    for (const name of files) {
      // The Library sends the parsed document back as JSON text, as the import route reads it.
      const content = JSON.stringify(JSON.parse(readFileSync(join(dir, name), "utf8")));
      const rows = scanBotPackageContents([{ path: "manifest.json", content }]).findings.filter((f) => f.rule === "machine-local-path");
      expect(rows.length, name).toBeLessThanOrEqual(1);
      if (rows[0]) found[name] = rows[0].evidence ?? "";
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(deliberate).filter(([name]) => files.includes(name))));
  });
});
