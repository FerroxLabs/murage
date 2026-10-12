// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TEST ONLY, Windows only, run by .github/workflows/engine-real-windows.yml (MURAGE_REAL_ENGINES=1). The REAL native addon against the
// REAL npm-installed Claude Code and Codex CLIs, started with no credentials in a mode that stays alive without signing in
// (`claude mcp serve`, `codex app-server --listen ws://...`, `codex mcp-server`; the first one that stays up is used). Every home is a
// temp folder; nothing of a real profile is read or written.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { engineState } from "./engine-closed.ts";
import { loadExclusionAddon, type NativeProcess } from "./engine-exclusion.ts";
import { builtAddonPath, useRealExclusion } from "./testing/engine-exclusion-fake.ts";

const built = builtAddonPath();
const enabled = process.platform === "win32" && process.env.MURAGE_REAL_ENGINES === "1";
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-realwin-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms: number, step = 250): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await sleep(step); }
  return check();
}

const children: ChildProcess[] = [];
function killTree(child: ChildProcess): void {
  if (child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
}
afterEach(() => { for (const c of children.splice(0)) killTree(c); });

const npmPrefix = (): string => {
  const r = spawnSync("npm prefix -g", { shell: true, encoding: "utf8" });
  return r.stdout.trim().split(/\r?\n/).pop()!.trim();
};
/** First file called `name` under `dir` (a native engine inside the npm package), depth-limited. */
function findFile(dir: string, name: string, depth = 8): string | null {
  if (depth < 0 || !existsSync(dir)) return null;
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.isFile() && e.name.toLowerCase() === name) return join(dir, e.name);
  for (const e of entries) if (e.isDirectory()) { const hit = findFile(join(dir, e.name), name, depth - 1); if (hit) return hit; }
  return null;
}

interface Engine { id: "claude" | "codex"; pkg: string; exe: string; modes: string[][] }
const ENGINES: Engine[] = [
  { id: "claude", pkg: "@anthropic-ai/claude-code", exe: "claude.exe", modes: [["mcp", "serve"]] },
  { id: "codex", pkg: "@openai/codex", exe: "codex.exe", modes: [["app-server", "--listen", "ws://127.0.0.1:47631"], ["mcp-server"]] },
];

function testEnv(id: string): { env: NodeJS.ProcessEnv; home: string } {
  const root = mkdtempSync(join(scratch, `${id}-home-`));
  const home = join(root, id === "claude" ? ".claude" : ".codex");
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: join(root, "AppData", "Roaming"), LOCALAPPDATA: join(root, "AppData", "Local"), CLAUDE_CONFIG_DIR: join(root, ".claude"), CODEX_HOME: join(root, ".codex"), CI: "1", DISABLE_AUTOUPDATER: "1" };
  for (const k of Object.keys(env)) if (/KEY|TOKEN|SECRET/i.test(k) && !/^(PATH)$/i.test(k)) delete env[k];
  mkdirSync(env.APPDATA!, { recursive: true }); mkdirSync(env.LOCALAPPDATA!, { recursive: true });
  return { env, home };
}

const mentions = (p: NativeProcess, e: Engine): boolean => {
  const hay = [p.exe ?? "", p.comm ?? "", ...(p.argv ?? [])].join(" ").replace(/\\/g, "/").toLowerCase();
  return hay.includes(e.id) || hay.includes(e.pkg);
};

/** Starts `command` (a .cmd shim through the shell, or a real .exe directly) with each mode until one stays up for 4 s. Returns the child and the mode. */
async function launch(e: Engine, command: string, shell: boolean, env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; mode: string[]; log: () => string } | null> {
  for (const mode of e.modes) {
    let out = "";
    const child = spawn(shell ? `"${command}"` : command, mode, { env, shell, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child.stdout!.on("data", (d) => { out += d; }); child.stderr!.on("data", (d) => { out += d; });
    child.on("error", (err) => { out += String(err); });
    children.push(child);
    await sleep(4000);
    if (child.exitCode === null && child.signalCode === null) return { child, mode, log: () => out };
    console.log(`[${e.id}] mode ${mode.join(" ")} exited early (${child.exitCode}): ${out.slice(0, 400)}`);
  }
  return null;
}

describe.skipIf(!enabled || !built)("real engines on Windows", () => {
  let restore = () => {};
  beforeAll(() => { restore = useRealExclusion(built!); });
  afterAll(() => restore());

  it("the CLIs are installed and start", () => {
    for (const bin of ["claude", "codex"]) {
      const r = spawnSync(`${bin} --version`, { shell: true, encoding: "utf8", env: testEnv(bin).env });
      console.log(`${bin} --version -> ${r.stdout.trim()} (status ${r.status})`);
      expect(r.status).toBe(0);
    }
  });

  for (const e of ENGINES) {
    describe(e.id, () => {
      const prefix = () => npmPrefix();
      const shim = () => join(prefix(), `${e.id}.cmd`);
      const nativeExe = () => findFile(join(prefix(), "node_modules"), e.exe);

      for (const route of ["shim", "native"] as const) {
        it(`${route}: processes() lists it with name/argv/uid; closed() is open while it runs and closed after exit`, async () => {
          const addon = loadExclusionAddon()!;
          const { env, home } = testEnv(e.id);
          let command: string, shell: boolean;
          if (route === "shim") { command = shim(); shell = true; expect(existsSync(command), `${command} exists`).toBe(true); }
          else {
            const exe = nativeExe();
            if (!exe) { console.log(`[${e.id}] no native ${e.exe} in the package (JS-only install): native route skipped`); return; }
            command = exe; shell = false;
          }
          // a clean machine first: nothing of this engine is running
          const before = engineState(e.id, home);
          expect(before.state, `baseline ${JSON.stringify(before)}`).toBe("closed");

          const started = await launch(e, command, shell, env);
          expect(started, `${e.id} (${route}) stayed up in one of its modes`).not.toBeNull();
          const { child, mode, log } = started!;
          console.log(`[${e.id}/${route}] running mode: ${mode.join(" ")}; pid ${child.pid}`);

          const listed = addon.processes().filter((p) => mentions(p, e) && p.pid !== process.pid);
          console.log(`[${e.id}/${route}] listed: ` + JSON.stringify(listed.map((p) => ({ pid: p.pid, comm: p.comm, exe: p.exe, argv: p.argv?.[0]?.slice(0, 160), uid: p.uid, mine: p.mine }))));
          expect(listed.length, `the addon lists the ${e.id} process\n${log()}`).toBeGreaterThan(0);
          for (const p of listed) {
            expect(Array.isArray(p.argv) || p.argv === null).toBe(true);
            expect("uid" in p, "uid field present").toBe(true);
            expect(p.uid === null || typeof p.uid === "number").toBe(true);
            expect(typeof p.pid).toBe("number");
          }
          expect(listed.some((p) => p.mine === true && Array.isArray(p.argv) && p.argv.length > 0), "one of ours with readable argv").toBe(true);

          const open = engineState(e.id, home);
          expect(open.state, `open while running: ${JSON.stringify(open)}`).toBe("open");

          killTree(child);
          const gone = await until(() => engineState(e.id, home).state === "closed", 30_000);
          expect(gone, `closed after exit: ${JSON.stringify(engineState(e.id, home))}`).toBe(true);
        }, 120_000);
      }
    });
  }

  it("a share-none hold on a history file: a writer in this process and in another one gets a sharing violation", () => {
    const addon = loadExclusionAddon()!;
    const file = join(scratch, "history.jsonl");
    writeFileSync(file, "{}\n");
    const held = addon.openFile!(file, 0)!;
    expect(held).toBeTruthy();
    let code = "";
    try { openSync(file, "r+"); } catch (err) { code = (err as NodeJS.ErrnoException).code ?? String(err); }
    expect(["EBUSY", "EPERM", "EACCES"]).toContain(code);
    const other = spawnSync(process.execPath, ["-e", `try{require("fs").appendFileSync(process.argv[1],"x\\n");console.log("WROTE")}catch(e){console.log("ERR "+e.code)}`, file], { encoding: "utf8" });
    console.log("second-process writer: " + other.stdout.trim());
    expect(other.stdout).toMatch(/ERR (EBUSY|EPERM|EACCES)/);
    expect(addon.openFile!(file, 0)).toBeNull();
    addon.handleClose!(held);
    const after = spawnSync(process.execPath, ["-e", `require("fs").appendFileSync(process.argv[1],"x\\n");console.log("WROTE")`, file], { encoding: "utf8" });
    expect(after.stdout).toContain("WROTE");
  });

  it("renameNoReplace refuses when the target exists, and works when it does not", () => {
    const addon = loadExclusionAddon()!;
    const dir = mkdtempSync(join(scratch, "rename-"));
    const a = join(dir, "a"), b = join(dir, "b");
    writeFileSync(a, "first");
    expect(addon.renameNoReplace(a, b)).toBe(0);
    writeFileSync(a, "second");
    expect(addon.renameNoReplace(a, b)).toBe(1);
  });
});
