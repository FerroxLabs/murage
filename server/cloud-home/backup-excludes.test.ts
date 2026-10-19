// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(`../../deploy/cloud-home/${p}`, import.meta.url), "utf8");
const patterns = read("backup-excludes.txt").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

/** restic exclude semantics: leading "/" anchors; otherwise the pattern matches any trailing run of components. */
function excluded(path: string): boolean {
  return patterns.some((pattern) => {
    const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
    const re = pattern.startsWith("/") ? new RegExp(`^${body}(/.*)?$`) : new RegExp(`(^|/)${body}(/.*)?$`);
    return re.test(path);
  });
}

// Every credential path the launcher knows, read from its source so a new engine cannot slip through.
const launcher = read("murage-turn-launch.py");
const block = /RECOVERY_CREDENTIALS = \{([\s\S]*?)\n\}/.exec(launcher)![1];
const credentialPaths = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((p) => p.includes("/"));
const roots = ["/data/home", "/data/home/engines/claudeAgent", "/data/home/engines/codex", "/data/engines/grokAgent"];

describe("backup exclusions (Anthropic hosting terms: no engine credentials in backups)", () => {
  it("found the launcher's credential list", () => {
    expect(credentialPaths).toEqual(expect.arrayContaining([".claude/.credentials.json", ".codex/auth.json", ".grok/auth.json", ".kimi-code/credentials"]));
  });
  it.each(roots)("excludes every launcher credential path under %s", (root) => {
    for (const rel of credentialPaths) expect(excluded(`${root}/${rel}`), `${root}/${rel}`).toBe(true);
  });
  it.each([".claude", ".claude.json", ".claude.json.backup", ".codex", ".grok", ".kimi-code", ".config/opencode", ".local/share/opencode"])(
    "excludes the whole %s location and anything below it", (dir) => {
      for (const root of roots) {
        expect(excluded(`${root}/${dir}`)).toBe(true);
        expect(excluded(`${root}/${dir}/anything/deep.json`)).toBe(true);
      }
    });
  it("excludes browser cookie jars and storage but not similarly named customer folders", () => {
    expect(excluded("/data/browser/bot1/Default/Cookies")).toBe(true);
    expect(excluded("/data/browser/bot1/Default/Local Storage/leveldb/000003.log")).toBe(true);
    expect(excluded("/data/home/work/Network/plan.md")).toBe(false);
    expect(excluded("/data/home/work/Sessions/notes.md")).toBe(false);
  });
  it("does not exclude ordinary customer files", () => {
    for (const p of ["/data/home/work/report.md", "/data/home/memory/db.sqlite", "/data/home/.config/prefs.json"]) expect(excluded(p), p).toBe(false);
  });
  it("the backup script refuses to run if the required entries are missing", () => {
    const script = read("murage-backup");
    const required = /REQUIRED_EXCLUDES = \(([^)]*)\)/.exec(script)![1].match(/"[^"]+"/g)!.map((s) => s.slice(1, -1));
    for (const r of required) expect(patterns).toContain(r);
    expect(required).toEqual(expect.arrayContaining([".claude", ".claude.json", ".codex", ".grok", ".kimi-code"]));
  });
  it("the backup run passes the exclude file and stays on one filesystem", () => {
    const script = read("murage-backup");
    expect(script).toContain('"--exclude-file", excludes');
    expect(script).toContain('"--one-file-system"');
  });
});
