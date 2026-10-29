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
// The launcher's versioned sign-in stores: <ENGINE_ROOT>/<engine>/<SIGNIN_DIR> (the engine's own) and
// <ENGINE_ROOT>/<engine>/<BOTS_DIR>/<bot>/<SIGNIN_DIR> (a bot's), generation directories below each. Read from its source.
const constant = (name: string) => new RegExp(`^${name} = "([^"]+)"$`, "mu").exec(launcher)![1];
const engineRoot = constant("ENGINE_ROOT");
const signinDir = constant("SIGNIN_DIR");
const botsDir = constant("BOTS_DIR");
const engines = [.../^ENGINES = \{([^}]*)\}/mu.exec(launcher)![1].matchAll(/"([^"]+)"/gu)].map((m) => m[1]);
// Every file name a generation is published with (publish_generation's literal sets) plus the store's own files.
const published = [...launcher.matchAll(/publish_generation\(store, \{"([^"]+)"/gu), ...launcher.matchAll(/files, record = \{"([^"]+)"/gu)].map((m) => m[1]);
const generationFiles = [...new Set([...published, "record.json", "auth.json", ".codex/auth.json", ".grok/auth.json", ".kimi-code/credentials/a.json",
  ".local/share/opencode/auth.json"])];

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
  it("excludes the health runtime files, the token key and the page ledger, and nothing with a similar name", () => {
    for (const p of ["/data/home/health", "/data/home/health/server.current.ndjson", "/data/home/health-key", "/data/home/sentinel-delivery.json"]) expect(excluded(p), p).toBe(true);
    for (const p of ["/data/home/work/health/plan.md", "/data/home/health-notes.md", "/data/home/work/sentinel-delivery.json"]) expect(excluded(p), p).toBe(false);
  });
  it("does not exclude ordinary customer files", () => {
    for (const p of ["/data/home/work/report.md", "/data/home/memory/db.sqlite", "/data/home/.config/prefs.json"]) expect(excluded(p), p).toBe(false);
  });
  it("found the launcher's sign-in stores", () => {
    expect(engineRoot).toBe("/data/engine-homes");
    expect(engines).toEqual(expect.arrayContaining(["claudeAgent", "codex", "grokAgent", "kimiAgent", "opencodeGo"]));
    expect(published).toEqual(expect.arrayContaining(["token", "key"]));
  });
  it.each(engines)("excludes every generation of the %s sign-in stores, the engine's own and every bot's (Astra preaudit cloud-home H2)", (engine) => {
    const stores = [`${engineRoot}/${engine}/${signinDir}`, `${engineRoot}/${engine}/${botsDir}/bot_1/${signinDir}`, `${engineRoot}/${engine}/${botsDir}/b2/${signinDir}`];
    for (const store of stores) {
      expect(excluded(store), store).toBe(true);
      expect(excluded(`${store}/current`), store).toBe(true);
      for (const generation of ["1", "2", "41", "999999999999999999"]) {
        for (const name of generationFiles) expect(excluded(`${store}/${generation}/${name}`), `${store}/${generation}/${name}`).toBe(true);
      }
      expect(excluded(`${store}/.tmp-5`), store).toBe(true);
    }
    // The rest of an engine home (a bot's own state) is still backed up.
    expect(excluded(`${engineRoot}/${engine}/${botsDir}/bot_1/state/sessions.json`)).toBe(false);
  });
  it("the backup script refuses to run if the required entries are missing", () => {
    const script = read("murage-backup");
    const required = /REQUIRED_EXCLUDES = \(([^)]*)\)/.exec(script)![1].match(/"[^"]+"/g)!.map((s) => s.slice(1, -1));
    for (const r of required) expect(patterns).toContain(r);
    expect(required).toEqual(expect.arrayContaining([".claude", ".claude.json", ".codex", ".grok", ".kimi-code"]));
    // Every sign-in store of the launcher, whatever the engine, bot or generation: one pattern built from the launcher's own layout.
    expect(required).toContain(`${engineRoot}/**/${signinDir}`);
  });
  it("the backup run passes the exclude file and stays on one filesystem", () => {
    const script = read("murage-backup");
    expect(script).toContain('"--exclude-file", excludes');
    expect(script).toContain('"--one-file-system"');
  });
});
