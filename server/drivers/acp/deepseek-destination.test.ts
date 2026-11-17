import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deepseekDestinationAnswer, resolveDeepseekDestination } from "./deepseek-destination.ts";
import { fluxDestination } from "../../flux-destination.ts";
import { DeepSeekAgentDriver } from "./deepseek.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";

let root: string, cwd: string, home: string;
const MODEL = '["deepseek-official","deepseek-v4-flash"]';
const FLUX = "https://api.fluxrouter.ai/v1";
const NATIVE = "https://api.deepseek.com/anthropic";
const config = (baseURL?: unknown) => [
  { name: "@deepseek-ai/dsh-llm-deepseek-api-key", config: baseURL === undefined ? {} : { baseURL } },
  { name: "@deepseek-ai/dsh-acp", config: { provider: "deepseek-official", model: "deepseek-v4-flash" } },
];
const answer = (text: string, env: Record<string, string> = {}, model: string | undefined = MODEL) =>
  deepseekDestinationAnswer(text, { cwd, env: { DSH_HOME: home, ...env }, model });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deepseek-destination-"));
  cwd = join(root, "project"); home = join(root, "home");
  mkdirSync(cwd); mkdirSync(home);
});
afterEach(() => removeTempDirSync(root));

it("uses the native compiled endpoint only for the actual composed official provider", async () => {
  const native = await answer(JSON.stringify(config()));
  expect(native).toMatchObject({ provider: "deepseek-official", urls: [NATIVE] });
  expect(fluxDestination(native, "flux")).toBe("other");
  expect(native.forModel?.('["other-provider","same-model"]', true)).toEqual({ unknown: "deepseek-config" });
  expect(fluxDestination(await answer(JSON.stringify([])), "flux")).toBe("refuse-unknown");
  expect(fluxDestination(await answer(JSON.stringify(config()), { DSH_SNAPSHOT: "replay" }), "flux")).toBe("refuse-unknown");
  const defaults = await deepseekDestinationAnswer(JSON.stringify(config()), { cwd, env: { DSH_HOME: home } });
  expect(defaults).toMatchObject({ model: MODEL, urls: [NATIVE] });
  for (const env of [{}, { DSH_HOME: "relative-home" }]) {
    expect(fluxDestination(await deepseekDestinationAnswer(JSON.stringify(config()), { cwd, env, model: MODEL }), "flux")).toBe("refuse-unknown");
  }
});

it("uses profile baseURL before launch layers and recognizes nested groups", async () => {
  const tree = [{ name: "group", group: true, config: config(FLUX) }];
  expect(fluxDestination(await answer(JSON.stringify(tree), { DEEPSEEK_BASE_URL: NATIVE }), "flux")).toBe("refuse-alias");
  const native = await answer(JSON.stringify(config(NATIVE)), { DEEPSEEK_BASE_URL: FLUX });
  expect(fluxDestination(native, "flux")).toBe("other");
});

it("accepts the home endpoint under the process value and refuses project endpoint injection", async () => {
  writeFileSync(join(home, ".env"), `DEEPSEEK_BASE_URL=${FLUX}\n`);
  expect(fluxDestination(await answer(JSON.stringify(config())), "flux")).toBe("refuse-alias");
  expect(fluxDestination(await answer(JSON.stringify(config()), { DEEPSEEK_BASE_URL: NATIVE }), "flux")).toBe("other");
  writeFileSync(join(cwd, ".env"), `DEEPSEEK_BASE_URL=${NATIVE}\n`);
  expect(fluxDestination(await answer(JSON.stringify(config())), "flux")).toBe("refuse-unknown");
  expect(fluxDestination(await answer(JSON.stringify(config()), { DEEPSEEK_BASE_URL: NATIVE }), "flux")).toBe("refuse-unknown");
});

it.each(["baseURL: !!js process.env.DSH_ENDPOINT", "baseURL: 17", "baseURL: 'https://example.invalid/?endpoint=secret'", "baseURL: ''"])("keeps ambiguous route %s closed", async field => {
  const yaml = `- name: '@deepseek-ai/dsh-llm-deepseek-api-key'\n  config:\n    ${field}\n`;
  expect(fluxDestination(await answer(yaml), "flux")).toBe("refuse-unknown");
});

it("does not evaluate unrelated expressions, and never falls back after a route parse failure", async () => {
  const yaml = `- name: '@deepseek-ai/dsh-llm-deepseek-api-key'\n  config: {}\n- name: sandbox\n  config:\n    cwd: !!js process.cwd()\n`;
  expect(fluxDestination(await answer(yaml), "flux")).toBe("other");
  for (const bad of ["[unterminated", "{}", JSON.stringify([...config(), config()[0]]), JSON.stringify([{ name: "custom-provider" }])])
    expect(fluxDestination(await answer(bad), "flux")).toBe("refuse-unknown");
  mkdirSync(join(cwd, ".env"));
  expect(fluxDestination(await answer(JSON.stringify(config())), "flux")).toBe("refuse-unknown");
});

it.each([FLUX, { dynamic: true }])("refuses the effective destination before any ACP prompt: %j", async base => {
  const instance = await DeepSeekAgentDriver.create({ instanceId: "destination-fixture", displayName: "Fixture", enabled: true,
    environment: { HOME: home, USERPROFILE: home, DSH_HOME: home, DEEPSEEK_API_KEY: "fixture-key", FAKE_CUSTOM_ACP_DIRECTORY: home, FAKE_CUSTOM_DEEPSEEK: "1", FAKE_DSH_CONFIG: JSON.stringify(config(base)) },
    config: { cli: `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(resolve("server/testing/fake-custom-acp-models.ts"))}`, fullAuto: false } });
  try {
    await expect(instance.adapter.sendTurn({ cwd, threadId: "refuse", text: "fixture", model: "deepseek-official/deepseek-v4-flash" })).rejects.toThrow();
    expect(existsSync(join(home, "receipts.jsonl"))).toBe(true);
    const rows = readFileSync(join(home, "receipts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toEqual([{ method: "dump-config", args: ["--profile", "acp", "--dump-config"] }]);
  } finally { await instance.dispose(); }
});

it("cancellation owns and stops a hung DeepSeek config probe and its descendant", async () => {
  const script = join(root, "probe.mjs"), pids = join(root, "pids.json");
  writeFileSync(script, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));
setInterval(()=>{},1000);
`);
  const controller = new AbortController();
  const pending = resolveDeepseekDestination({ env: { ...process.env, HOME: home, DSH_HOME: home }, cwd,
    cli: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, signal: controller.signal, model: MODEL, memoryOff: true });
  const outcome = pending.catch(error => error as Error);
  let ids: number[] = [];
  try {
    await vi.waitFor(() => expect(existsSync(pids)).toBe(true), { timeout: 10000 });
    ids = JSON.parse(readFileSync(pids, "utf8"));
    controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    for (const pid of ids) await vi.waitFor(() => {
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      if (alive && process.platform === "linux") {
        try { alive = !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { alive = false; }
      }
      expect(alive).toBe(false);
    }, { timeout: 5000 });
  } finally {
    controller.abort(); await outcome;
    for (const pid of ids) { try { process.kill(pid, "SIGKILL"); } catch { /* already closed */ } }
  }
}, 30000);

// Run the actual decoder in an expendable process: a regression must fail
// this test without freezing Vitest itself or leaving a blocked reader behind.
it.each(["regular", "fifo", "swap-fifo", "swap-file", "swap-remove", "grow"])("checks .env safety without blocking the server loop: %s", async mode => {
  const path = join(home, ".env");
  if (mode === "fifo") {
    if (process.platform === "win32") mkdirSync(path);
    else execFileSync("mkfifo", [path]);
  }
  else writeFileSync(path, "# initial regular file\n");
  const preload = join(root, "fs-race.mjs");
  writeFileSync(preload, `
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import threads from 'node:worker_threads';
const target = ${JSON.stringify(path)}, mode = ${JSON.stringify(mode)};
function install(fs, execFileSync, target, mode) {
let changed = false;
for (const name of ['statSync', 'lstatSync', 'fstatSync']) {
  const original = fs[name];
  fs[name] = function(file, ...args) {
    const result = original.call(this, file, ...args);
    if (!changed && (mode === 'grow' ? ((file === target && name === 'statSync') || (name === 'fstatSync' && result.isFile())) : (file === target && name !== 'fstatSync'))) {
      if (mode === 'grow') fs.appendFileSync(target, '# ' + 'x'.repeat(70000) + '\\nDEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic\\n');
      else if (mode.startsWith('swap-')) {
        fs.unlinkSync(target);
        if (mode === 'swap-fifo') {
          if (process.platform === 'win32') fs.mkdirSync(target);
          else execFileSync('mkfifo', [target]);
        }
        else if (mode !== 'swap-remove') fs.writeFileSync(target, 'DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic\\n');
      }
      changed = true;
    }
    return result;
  };
}
}
install(fs, execFileSync, target, mode);
// Node eval workers do not run --import preloads. Install the identical race
// inside their real filesystem implementation before the production source.
const NativeWorker = threads.Worker;
threads.Worker = class extends NativeWorker {
  constructor(source, options) {
    const prefix = '(' + install.toString() + ')(require("node:fs"), require("node:child_process").execFileSync, ' + JSON.stringify(target) + ', ' + JSON.stringify(mode) + ');\\n';
    super(prefix + source, options);
  }
};
syncBuiltinESMExports();
`);
  const script = `
import { deepseekDestinationAnswer } from ${JSON.stringify(resolve("server/drivers/acp/deepseek-destination.ts"))};
const timer = setInterval(() => {}, 10);
try {
  const answer = await deepseekDestinationAnswer(${JSON.stringify(JSON.stringify(config()))}, ${JSON.stringify({ cwd, env: { DSH_HOME: home }, model: MODEL })});
  console.log(JSON.stringify({unknown: answer.unknown, urls: answer.urls}));
} finally { clearInterval(timer); }
`;
  const scriptPath = join(root, "decode.mjs");
  writeFileSync(scriptPath, script);
  const child = spawn(process.execPath, ["--experimental-strip-types", "--import", preload, scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", data => stdout += data);
  child.stderr.on("data", data => stderr += data);
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 6000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    expect(timedOut, "decoder froze; owned watchdog killed its exact process").toBe(false);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual(mode === "regular" ? { urls: [NATIVE] } : { unknown: "deepseek-config" });
  } finally { clearTimeout(timer); child.kill("SIGKILL"); }
}, 15000);
