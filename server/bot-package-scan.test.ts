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
});
