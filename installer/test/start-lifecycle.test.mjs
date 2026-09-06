import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const INSTALLER = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitFor(check, message, timeout = 8_000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= end) throw new Error(typeof message === "function" ? message() : message);
    await pause(25);
  }
}

function fixture({ slowProbe = false, sidecarExit = false, ignoreTerm = false, missingSidecar = false, harnessExit = false, setup = false, doorPort } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "murage-start-lifecycle-")));
  const installed = join(dir, "installer");
  mkdirSync(join(installed, "bin"), { recursive: true });
  cpSync(join(INSTALLER, "lib"), join(installed, "lib"), { recursive: true });
  cpSync(join(INSTALLER, "bin", "murage.mjs"), join(installed, "bin", "murage.mjs"));
  const harness = join(dir, "harness.mjs");
  const sidecar = join(dir, "sidecar.mjs");
  const tailscale = join(dir, "tailscale-stub");
  const record = role => `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(dir, role + ".pid"))},String(process.pid));
writeFileSync(${JSON.stringify(join(dir, role + ".env.json"))},JSON.stringify({devSecretDisabled:process.env.MURAGE_NO_DEV_DESKTOP_SECRET,companionToken:process.env.MURAGE_COMPANION_TOKEN}));\n`;
  writeFileSync(harness, record("harness") + (harnessExit ? "process.exit(9);" :
    `${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ""}setInterval(()=>{},1000);`));
  if (!missingSidecar) writeFileSync(sidecar, record("sidecar") + (setup
    ? `import {createServer} from 'node:http'; createServer(()=>{}).listen(${doorPort},'127.0.0.1',()=>writeFileSync(${JSON.stringify(join(dir,"door.pid"))},String(process.pid)));`
    : sidecarExit ? "setTimeout(()=>process.exit(7),100);" :
      `${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ""}setInterval(()=>{},1000);`));
  const quotedMarker = "'" + join(dir,"probe.pid").replaceAll("'", "'\\''") + "'";
  writeFileSync(tailscale, slowProbe
    ? `#!/bin/sh\nprintf '%s' "$$" > ${quotedMarker}\nexec /bin/sleep 30\n`
    : `#!${process.execPath}\n` + record("probe") + (setup
      ? `console.log(process.argv[2] === 'status' ? JSON.stringify({BackendState:'Running',Self:{Online:true,TailscaleIPs:['100.81.158.63'],DNSName:'fixture.tail.test.',Tags:['tag:murage']}}) : '{}');`
      : "console.log('{}');"), { mode: 0o755 });
  const launcher = spawn(process.execPath, [join(installed,"bin","murage.mjs"), setup ? "setup" : "start"], {
    detached: process.platform !== "win32", stdio: ["ignore","pipe","pipe"],
    env: {
      PATH: dirname(process.execPath), HOME: dir, USERPROFILE: dir, NO_COLOR: "1",
      MURAGE_DATA_DIR: join(dir,"data"), MURAGE_ENV_FILE: join(dir,"absent.env"),
      MURAGE_SERVER_ENTRY: harness, MURAGE_COMPANION_ENTRY: sidecar,
      MURAGE_TAILSCALE_BIN: tailscale, MURAGE_BIND_MODE: "loopback",
      MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_DEV_DESKTOP_SECRET: "fixture-only-developer-secret",
      MURAGE_NO_DEV_DESKTOP_SECRET: "0",
      MURAGE_COMPANION_TOKEN: "ambient-token-must-be-replaced",
      ...(doorPort ? { MURAGE_BROWSER_PORT: String(doorPort) } : {}),
    },
  });
  let output = "";
  launcher.stdout.on("data", chunk => { output += chunk; });
  launcher.stderr.on("data", chunk => { output += chunk; });
  const pid = role => Number(readFileSync(join(dir,role + ".pid"),"utf8"));
  return {
    launcher, pid, output:()=>output,
    childEnv: role => JSON.parse(readFileSync(join(dir,role + ".env.json"),"utf8")),
    ready: role => waitFor(()=>existsSync(join(dir,role + ".pid")),()=>`no ${role} startup marker (exit=${launcher.exitCode}, signal=${launcher.signalCode}): ${output}`),
    exited: () => waitFor(()=>launcher.exitCode !== null || launcher.signalCode !== null,()=>`launcher did not exit: ${output}`),
    async close() {
      // Only this fixture's newly-created process group. Also closes inherited
      // pipes if a regression orphaned a child, so a red test remains bounded.
      try { process.kill(-launcher.pid,"SIGKILL"); } catch {}
      launcher.stdout.destroy(); launcher.stderr.destroy();
      await waitFor(()=>!alive(launcher.pid),"fixture launcher survived cleanup");
      rmSync(dir,{recursive:true,force:true});
    },
  };
}

const options = { skip: process.platform === "win32", timeout: 15_000 };
test("SIGTERM during startup probe leaves no harness or probe child", options, async () => {
  const f = fixture({slowProbe:true});
  try {
    await f.ready("harness"); await f.ready("probe");
    f.launcher.kill("SIGTERM");
    await f.exited();
    assert.equal(alive(f.pid("harness")),false,"harness was orphaned by early termination");
    assert.equal(alive(f.pid("probe")),false,"startup probe was orphaned by early termination");
  } finally { await f.close(); }
});

test("shutdown waits for stubborn harness and sidecar children to exit", options, async () => {
  const f = fixture({ignoreTerm:true});
  try {
    await f.ready("harness"); await f.ready("sidecar");
    assert.equal(f.childEnv("harness").devSecretDisabled,"1","headless harness inherited developer authority");
    assert.match(f.childEnv("harness").companionToken,/^[a-f0-9]{64}$/);
    assert.equal(f.childEnv("harness").companionToken,f.childEnv("sidecar").companionToken);
    assert.ok(!f.output().includes(f.childEnv("harness").companionToken),"private launch token was printed");
    f.launcher.kill("SIGTERM");
    await f.exited();
    assert.equal(alive(f.pid("harness")),false,"harness still alive when launcher exited");
    assert.equal(alive(f.pid("sidecar")),false,"sidecar still alive when launcher exited");
  } finally { await f.close(); }
});

test("sidecar failure waits for harness cleanup before exiting nonzero", options, async () => {
  const f = fixture({sidecarExit:true,ignoreTerm:true});
  try {
    await f.ready("harness"); await f.ready("sidecar");
    await f.exited();
    assert.equal(f.launcher.exitCode,1,f.output());
    assert.equal(alive(f.pid("harness")),false,"failed sidecar left its harness alive");
  } finally { await f.close(); }
});

test("early harness exit cancels an in-progress startup probe", options, async () => {
  const f = fixture({slowProbe:true,harnessExit:true});
  try {
    await f.ready("harness");
    await f.exited();
    assert.equal(f.launcher.exitCode,9,f.output());
  } finally { await f.close(); }
});

test("missing sidecar keeps the documented harness-only fallback and cleans up", options, async () => {
  const f = fixture({missingSidecar:true});
  try {
    await f.ready("harness");
    await waitFor(()=>f.output().includes("starting the harness alone"),"fallback was not reported");
    assert.equal(f.launcher.exitCode,null);
    f.launcher.kill("SIGTERM");
    await f.exited();
    assert.equal(alive(f.pid("harness")),false);
  } finally { await f.close(); }
});

test("Ctrl-C during setup door startup stops its temporary sidecar and releases the port", options, async () => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0,"127.0.0.1",resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const f = fixture({setup:true,doorPort:port});
  try {
    await f.ready("door");
    f.launcher.kill("SIGINT");
    await f.exited();
    assert.equal(alive(f.pid("sidecar")),false,"setup sidecar survived Ctrl-C");
    assert.equal(f.launcher.exitCode,130,f.output());
    const listener = createServer();
    await new Promise((resolve,reject) => { listener.once("error",reject); listener.listen(port,"127.0.0.1",resolve); });
    await new Promise(resolve => listener.close(resolve));
  } finally { await f.close(); }
});
