import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const handler = source.slice(source.indexOf('ipcMain.handle("credential:set"'), source.indexOf("async function broadcastDesktopCapabilities"));
// The real resolver, not a stand-in. Every gate calls it now, so a test that
// invented its own version would be testing the invention.
const resolver = source.slice(
  source.indexOf("async function ensureDesktopSurfaceSecret()"),
  source.indexOf("let CREDENTIALS_FILE"),
);
function fixture(proof, code = handler, { packaged = true, handshake } = {}) {
  let invoke, calls = 0, handshakes = 0;
  const ipcMain = { handle: (_name, fn) => { invoke = fn; } };
  const fetch = async (url, options) => {
    // The dev handshake, which carries no headers of its own.
    if (String(url).endsWith("/api/desktop-secret")) {
      handshakes++;
      if (!handshake) return { ok: false, status: 404, json: async () => ({ error: "no such route" }) };
      return { ok: true, status: 200, json: async () => ({ secret: handshake }) };
    }
    calls++;
    const authorized = options.headers["x-murage-surface"] === "desktop" && options.headers["x-murage-surface-secret"] === "fixture-proof";
    return { ok: authorized, status: authorized ? 200 : 404, json: async () => authorized ? { saved: true } : { error: "no such route" } };
  };
  new Function("ipcMain", "fetch", "desktopSurfaceSecret", "packaged", "resolver", `
    const app={isPackaged:packaged},safeStorage={isAsyncEncryptionAvailable:async()=>true},SERVER_PORT=1;
    eval(resolver);
    const CREDENTIAL_PATCH={telegramBotToken:value=>({telegram:{botToken:value}})};
    const updateSecureCredentialDocument=async(derive,apply)=>{derive({});return apply();};
    ${code}
  `)(ipcMain, fetch, proof, packaged, resolver);
  return {
    save: () => invoke({}, "telegramBotToken", "fake-test-token"),
    calls: () => calls,
    handshakes: () => handshakes,
  };
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

// SAVING A CREDENTIAL ON A RUN WHERE WE DID NOT FORK THE HARNESS.
//
// Reported live: connecting Flux Router answered "Error invoking remote method
// flux-connection:mutate: Desktop authorization is not ready. Try again
// shortly." and never stopped answering it.
//
// The proof arrives over the utility-process channel, and that channel exists
// only when the PACKAGED app forked the harness itself. Start the harness
// separately, which is how the app runs in development and against a built
// bundle, and this process never receives one. "Try again shortly" was
// therefore false: nothing was ever going to make it ready, and every
// credential in the app was unsavable.
//
// The renderer already had this exact problem and already solved it by asking
// the harness over /api/desktop-secret. Main had never been given the same
// fallback, so the renderer believed it was the desktop while main could not
// prove it.
test("an unforked harness is asked for the proof instead of refusing forever", async () => {
  const f = fixture("", handler, { packaged: false, handshake: "fixture-proof" });
  assert.deepEqual(await f.save(), { saved: true });
  assert.equal(f.handshakes(), 1, "the dev handshake was never attempted");
  assert.equal(f.calls(), 1);
});

// THE LOCK THAT KEEPS THIS OUT OF A SHIPPED APP.
//
// Two independent ones stand in front of it and this pins the near one. The
// far one is the route itself, which 404s whenever the harness is a packaged
// utility child (`devDesktopSecretOffered`, server/sse-visibility.ts).
test("a packaged app never asks, and still refuses without the forked child's proof", async () => {
  const f = fixture("", handler, { packaged: true, handshake: "fixture-proof" });
  await assert.rejects(f.save(), /Desktop authorization is not ready/);
  assert.equal(f.handshakes(), 0, "a packaged build reached for the dev handshake");
  assert.equal(f.calls(), 0);
});

// A harness that refuses the handshake leaves the message TRUE rather than
// looping: nothing is saved and nothing is sent unauthorized.
test("a refused handshake still refuses the save", async () => {
  const f = fixture("", handler, { packaged: false, handshake: "" });
  await assert.rejects(f.save(), /Desktop authorization is not ready/);
  assert.equal(f.handshakes(), 1);
  assert.equal(f.calls(), 0);
});

// The forked child's proof still wins outright, and costs no handshake.
test("a proof already in hand is used without asking anyone", async () => {
  const f = fixture("fixture-proof", handler, { packaged: false, handshake: "wrong-proof" });
  assert.deepEqual(await f.save(), { saved: true });
  assert.equal(f.handshakes(), 0);
});
