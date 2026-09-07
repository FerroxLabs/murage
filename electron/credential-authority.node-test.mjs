import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const handler = source.slice(source.indexOf('ipcMain.handle("credential:set"'), source.indexOf("async function broadcastDesktopCapabilities"));
function fixture(proof, code = handler) {
  let invoke, calls = 0;
  const ipcMain = { handle: (_name, fn) => { invoke = fn; } };
  const fetch = async (_url, options) => {
    calls++;
    const authorized = options.headers["x-murage-surface"] === "desktop" && options.headers["x-murage-surface-secret"] === "fixture-proof";
    return { ok: authorized, status: authorized ? 200 : 404, json: async () => authorized ? { saved: true } : { error: "no such route" } };
  };
  new Function("ipcMain", "fetch", "desktopSurfaceSecret", `
    const app={isPackaged:true},safeStorage={isAsyncEncryptionAvailable:async()=>true},SERVER_PORT=1;
    const CREDENTIAL_PATCH={telegramBotToken:value=>({telegram:{botToken:value}})};
    const updateSecureCredentialDocument=async(derive,apply)=>{derive({});return apply();};
    ${code}
  `)(ipcMain, fetch, proof);
  return { save: () => invoke({}, "telegramBotToken", "fake-test-token"), calls: () => calls };
}
test("actual credential IPC supplies desktop marker and proof", async () => {
  const f = fixture("fixture-proof");
  assert.deepEqual(await f.save(), { saved: true });
  assert.equal(f.calls(), 1);
});
test("missing desktop proof refuses before credential request", async () => {
  const f = fixture("");
  await assert.rejects(f.save(), /Desktop authorization is not ready/);
  assert.equal(f.calls(), 0);
});
test("control without authorization headers reproduces denied save", async () => {
  const oldShape = handler.replace(/\s*"x-murage-surface": "desktop",/, "").replace(/\s*"x-murage-surface-secret": desktopSurfaceSecret,/, "");
  await assert.rejects(fixture("fixture-proof", oldShape).save(), /no such route/);
});
