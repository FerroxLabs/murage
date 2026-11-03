// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The desktop sign-in through the real server, with the real runner from electron/ and a stand-in CLI: the routes answer
// the desktop alone, the child gets the recipe's environment, and nothing the child prints reaches the window.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { createLocalEngineLogin } from "../electron/engine-login-local.mjs";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const CODE = "ZX9Q-48KT";
let fixture: VerificationServer;
let headers: Record<string, string> = {};
const scratch = mkdtempSync(join(tmpdir(), "signin-api-"));
const seenEnv = join(scratch, "env.txt");
const cli = join(scratch, "fake-codex");
// The stand-in names its tools by full path: the PATH it is handed is the point of the test, not a way to find env and sleep.
// A verification server starts with an empty PATH, and on Ubuntu the login shell keeps it empty (its /etc/profile sets none),
// so the owner capture falls back to the install folders alone and a bare `env` would not be found there.
writeFileSync(cli, `#!/bin/sh\n[ "$1 $#" = "login 1" ] || exit 0\n/usr/bin/env > ${JSON.stringify(seenEnv)}\necho "1. Open this link"\necho "https://auth.openai.com/codex/device"\necho "2. Enter this one-time code"\necho "${CODE}"\nexec /bin/sleep 60\n`);
chmodSync(cli, 0o755);

const api = async (method: string, path: string, body?: unknown, proven = true) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...(proven ? headers : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as any };
};
const askDir = () => join(fixture.info.dataDir, "ask");

describe.skipIf(process.platform === "win32")("desktop engine sign-in, real server", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const dataDir=process.env.MURAGE_DATA_DIR;
      const askDir=path.join(dataDir,'ask');fs.mkdirSync(askDir,{recursive:true});
      const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "drivers", "builtIn.ts")).href)});
      const { makeAskDriver } = await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-ask-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeAskDriver());
      const file=path.join(dataDir,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.text={driver:'fakeAsk',displayName:'Text only',environment:{FAKE_ASK_DIR:askDir}};
      cfg.instances.signin={driver:'codex',displayName:'Codex two',config:{cli:${JSON.stringify(cli)}},environment:{CODEX_HOME:${JSON.stringify(join(scratch, "codex-home"))},SSL_CERT_FILE:'/tmp/planted'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    mkdirSync(askDir(), { recursive: true });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  });
  afterAll(async () => { await fixture?.stop?.(); });

  it("answers the desktop alone, by instance id, with no text from the caller", async () => {
    expect((await api("POST", "/api/engine-signin-recipe", { instanceId: "signin" }, false)).status).toBe(404);
    expect((await api("POST", "/api/engine-signin-probe", { instanceId: "signin" }, false)).status).toBe(404);
    expect((await api("POST", "/api/engine-signin-recipe", { instanceId: "signin", argv: ["/bin/sh"] })).status).toBe(400);
    expect((await api("POST", "/api/engine-signin-probe", { instanceId: "signin", argv: ["/bin/sh"] })).status).toBe(400);
    expect((await api("POST", "/api/engine-signin-recipe", { instanceId: "nothing-here" })).status).toBe(404);
    expect((await api("POST", "/api/engine-signin-probe", { instanceId: "nothing-here" })).status).toBe(404);
    const recipe = await api("POST", "/api/engine-signin-recipe", { instanceId: "signin" });
    expect(recipe.status).toBe(200);
    expect(recipe.body).toMatchObject({ kind: "headless", accountRoot: join(scratch, "codex-home"), accountEnv: { CODEX_HOME: join(scratch, "codex-home") } });
    expect(recipe.body.argv.slice(1)).toEqual(["login"]);
    expect(Object.keys(recipe.body.env).sort()).toEqual(["CODEX_HOME", "HOME", "PATH"]);
  });

  it("the old hold route is gone", async () => {
    expect((await api("POST", "/api/engine-signin-hold", { action: "begin", id: "a" })).status).toBe(404);
  });

  it("the probe reads one engine", async () => {
    const reply = await api("POST", "/api/engine-signin-probe", { instanceId: "signin" });
    expect(reply.status).toBe(200);
    expect([true, false, null]).toContain(reply.body.authenticated);
  });

  it("runs the child on the recipe's environment alone, and nothing it prints reaches the window", async () => {
    const heard: any[] = [];
    const runner = createLocalEngineLogin({
      api: (path: string, body?: unknown) => api(body === undefined ? "GET" : "POST", path, body), spawn, launchTerminal: async () => ({ ok: false }),
      killTree: (child: any, signal: string) => { try { process.kill(-child.pid, signal as NodeJS.Signals); } catch { child.kill(signal); } },
    });
    const sender = { send: (_channel: string, payload: any) => heard.push(payload) };
    const preview = await runner.preview({ instanceId: "signin" });
    expect(preview).toMatchObject({ ok: true, kind: "headless", label: "Codex two" });
    expect(existsSync(seenEnv)).toBe(false);
    expect(await runner.start({ sender, instanceId: "signin" })).toMatchObject({ ok: true });
    await expect.poll(() => existsSync(seenEnv) && readFileSync(seenEnv, "utf8").includes("PATH="), { timeout: 10_000 }).toBe(true);

    const seen = readFileSync(seenEnv, "utf8");
    expect(seen).toContain(`CODEX_HOME=${join(scratch, "codex-home")}`);
    for (const name of ["SSL_CERT_FILE", "MURAGE_DATA_DIR", "NODE_OPTIONS", "OPENAI_API_KEY"]) expect(seen).not.toContain(`${name}=`);
    await runner.shutdown();
    expect(JSON.stringify(heard)).not.toContain(CODE);
    expect(JSON.stringify(heard)).not.toContain("auth.openai.com");
  }, 60_000);
});
