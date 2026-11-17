// secret-scan: fixture
import { describe, expect, it } from "vitest";
import { credentialGlobHit, powershellGlobWords, segmentsIntersect } from "./sensitive-globs.ts";
import { gateHit } from "./gate-files.ts";
import { dequotedShellText } from "../server/auto-approve.ts";

// Inert command text. No shell expands these fixtures.
const rows: [string, boolean][] = [
  ["ls /tmp/*", false], ["cat /tmp/*", false], ["ls -d /tmp/*/", false],
  ["ls /tmp/murage-*", true], ["tar cf - /tmp/murage-*", true], ["grep -r x /tmp/murage-*", true],
  ["cat /tmp/*/*.json", true], ["cat /tmp/murage-*/*", true], ["cat /tmp/murage-?red-[B-Z]*/*.json", true],
  ["cat /tmp/*/env/*", true], ["cat /tmp/*/*.log", false], ["cat /tmp/foo-*/*", false],
  ["cat /tmp/**/*.json", true], ["cat /*/*/*.json", true], ["ls /tmp/*/*", true],
  ["cat /*/*/*", true], ["ls /*/*/*", true], ["cat /**/*", true], ["cat /*/*", false],
  ["cat */*.json", false], ['prettier "**/*.json"', false], ["cd /tmp; cat murage-*/*", true],
  ["curl https://x/*/*.json", false], ["printf '%s\\n' '/tmp/*/*.json'", false],
  ["cat <<'EOF'\n/**\n/*\nEOF", false],
];
describe("X3 command table", () => {
  it.each(rows)("%s", (command, held) => {
    const words = (dequotedShellText(command) as { globWords?: string[] })?.globWords ?? [];
    expect(Boolean((gateHit as (texts: string[], words: string[]) => string | null)([], words))).toBe(held);
  });
});

describe("platform roots and shell words", () => {
  const platforms = [
    { platform: "linux", temp: "/tmp", home: "/home/Jane Doe" },
    { platform: "darwin", temp: "/var/folders/ab/cd/T", home: "/Users/Jane Doe" },
    { platform: "win32", temp: "C:/Users/Jane Doe/AppData/Local/Temp", home: "C:/Users/Jane Doe" },
  ] as const;
  for (const { platform, temp, home } of platforms) {
    const options = { platform, roots: { temp: [temp, "/tmp", "/private/tmp", ...(platform === "darwin" ? ["/private" + temp] : [])], home, data: [home + "/.murage"] } };
    it.each(rows)(platform + ": %s", (command, held) => {
      const words = dequotedShellText(command)?.globWords ?? [];
      expect(Boolean(credentialGlobHit(words.map(word => word.replaceAll("/tmp", temp)), options))).toBe(held);
    });
    it(platform + " variables and names with spaces", () => {
      for (const command of ['cat "\${TMPDIR:-/tmp}/"*/*.json', 'cat \${TMPDIR:-/tmp}/*/*.json', 'cat \${CONFIG_FILES:-/tmp/*/mcp.json /tmp/*/*.json}', 'cat \${X:-/tmp/*}', 'cat $TMPDIR/murage-*', 'cat $TMPDIR/murage-*/*', 'cat $TMPDIR/*/*.json.*.tmp']) {
        expect(credentialGlobHit(dequotedShellText(command)?.globWords ?? [], options), command).not.toBeNull();
      }
      for (const command of ['ls $TMPDIR/*', 'ls -d $TMPDIR/*/', 'cat $FOO/*/*.json', 'printf "%s" "/tmp/*/*.json"']) {
        expect(credentialGlobHit(dequotedShellText(command)?.globWords ?? [], options), command).toBeNull();
      }
      expect(credentialGlobHit([home + "/.murage/claude-private/*.json"], options)).not.toBeNull();
    });
  }
  it("Windows quoted PowerShell and Git Bash paths", () => {
    const options = { platform: "win32" as const, roots: { temp: ["C:/Users/Jane Doe/AppData/Local/Temp"], home: "C:/Users/Jane Doe" } };
    for (const text of ['Get-Content "C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\*\\mcp.json"', 'Get-Content "\${env:TEMP}\\*\\mcp.json"', 'Get-Content "~/AppData/Local/Temp/*/*.json"']) {
      expect(credentialGlobHit(powershellGlobWords(text), options)).not.toBeNull();
    }
    expect(credentialGlobHit(dequotedShellText('cat "/c/Users/Jane Doe/AppData/Local/Temp/"*/*.json')!.globWords, options)).not.toBeNull();
  });
  it("intersects alphabets rather than one random suffix", () => {
    expect(segmentsIntersect("[B-Z]*", ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", "0123456789"])).toBe(true);
    expect(segmentsIntersect("[g-z]*", ["0123456789abcdef"])).toBe(false);
    expect(segmentsIntersect("[!a]", ["a"])).toBe(true);
  });
  it("eligibility precedes the depth cap", () => {
    expect(credentialGlobHit(["**/".repeat(30) + "*.json"], { roots: { temp: ["/tmp"] } })).toBeNull();
    expect(credentialGlobHit(["/" + "**/".repeat(30) + "*.json"], { roots: { temp: ["/tmp"] } })).not.toBeNull();
  });
});

describe("X3 named data list", () => {
  it("Cloud data lives two segments from the root", () => {
    expect(credentialGlobHit(["/*/*"], { roots: { temp: ["/tmp"], data: ["/data"] } })).not.toBeNull();
  });
  it.each(["/home/Jane Doe/.murage", "C:/Users/Jane Doe/.murage", "/data"])("data root %s", data => {
    const roots = { temp: ["/tmp"], data: [data] };
    for (const pattern of ["credentials.bin.*", "credentials.enc.*.tmp", "claude-signin-answers.json.*.tmp", "webhooks.json.*.tmp", "local-servers.json.*.tmp", "flux-composio-broker-token.json.*.tmp", "config.json.*.tmp", "browser-engine/*/home/.agent-browser/sessions/*.json*", "native/cursor-host-config/*/cli-config.json"]) {
      expect(credentialGlobHit([data + "/" + pattern], { roots })).not.toBeNull();
    }
    for (const pattern of ["attachments/*", "artifact-files/*", "skills/*", "recordings/*", "connector-tools-cache/*", "events/*", "flux-hermes-home/state.*", "native/*.ndjson", "native/fuigo-turn-logs/*"]) {
      expect(credentialGlobHit([data + "/" + pattern], { roots }), pattern).toBeNull();
    }
  });
});

describe("X3 scan corrections", () => {
  it("records the three corrected writer classifications", async () => {
    const { readFileSync } = await import("node:fs");
    const scan = readFileSync("docs/verification/gate-credential-writers-1018.md", "utf8");
    expect(scan).toContain("server/drivers/acp/cursor.ts:455 | A | data | native/cursor-host-config/<bot>/cli-config.json");
    expect(scan).toContain("server/drivers/claude.ts:2738 | N | os.tmpdir()");
    expect(scan).toContain("server/drivers/acp/hermes.ts:345 | A | data | flux-hermes-home/config.yaml");
  });
  it("lists every rendered put and confirms the two Claude callers omit overlay env", async () => {
    const { readFileSync } = await import("node:fs");
    const scan = readFileSync("docs/verification/gate-credential-writers-1018.md", "utf8").split("## Files visible inside a Cloud turn")[1] ?? "";
    const launcher = readFileSync("deploy/cloud-home/murage-turn-launch.py", "utf8").split("\n");
    let inRender = false;
    for (const [index, line] of launcher.entries()) {
      if (line.startsWith("def render_plan(")) inRender = true;
      else if (inRender && line.startsWith("def ")) break;
      if (inRender && /^\s+put\(/.test(line)) expect(scan).toContain("murage-turn-launch.py:" + (index + 1) + " |");
    }
    const claude = readFileSync("server/drivers/claude.ts", "utf8");
    expect(claude.match(/claudeIsolation\(/g)).toHaveLength(3);
    expect(claude).toContain("...claudeIsolation(env, process.cwd())");
    expect(claude).toContain("claudeIsolation(turnEnv, cwd)");
  });
});
