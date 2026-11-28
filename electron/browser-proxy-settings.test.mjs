// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Built-in browser: optional SOCKS5 proxy and locale. Off unless set; a proxy
// URL with credentials lives only in the encrypted store, never in plain config.
import { createServer, connect } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as proxySettings from "./browser-proxy-settings.mjs";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import { applyBrowserNetwork, createBrowserProxyStore, createSocks5AuthRelay, parseSocks5Url } from "./browser-proxy-settings.mjs";

const fakeSafeStorage = {
  isAsyncEncryptionAvailable: async () => true,
  getSelectedStorageBackend: () => "gnome_libsecret",
  encryptString: (text) => Buffer.from(`sealed:${Buffer.from(text).toString("base64")}`),
  decryptString: (buffer) => Buffer.from(buffer.toString().slice("sealed:".length), "base64").toString(),
};
const URL_WITH_CREDS = "socks5://fixture-user:secret@proxy.example:1080";
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bps-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const store = (extra = {}) => createBrowserProxyStore({ safeStorage: fakeSafeStorage, directory: dir, platform: "darwin", ...extra });
const fakeSession = () => { const calls = { proxy: [], lang: [] }; return { calls, setProxy: async (c) => { calls.proxy.push(c); }, setUserAgent: (ua, lang) => { calls.lang.push(lang); } }; };

describe("parseSocks5Url", () => {
  it("reads host, port and credentials", () => {
    expect(parseSocks5Url(URL_WITH_CREDS)).toEqual({ host: "proxy.example", port: 1080, username: "fixture-user", password: "secret" });
    expect(parseSocks5Url("socks5://10.0.0.2:9050")).toEqual({ host: "10.0.0.2", port: 9050, username: "", password: "" });
  });
  it("refuses other schemes, missing ports and paths", () => {
    for (const bad of ["http://p:1", "socks4://p:1", "socks5://p", "socks5://p:1/x", "socks5://:1", "", "socks5://p:70000"]) expect(() => parseSocks5Url(bad)).toThrow();
  });
});

describe("no proxy unless set", () => {
  it("a fresh store applies nothing: no proxy rules, default language", async () => {
    const ses = fakeSession();
    await applyBrowserNetwork(ses, await store().read());
    expect(ses.calls.proxy).toEqual([{ mode: "system" }]);
    expect(ses.calls.lang).toEqual([]);
  });
  it("a proxy-free setting never produces proxy rules", async () => {
    const s = store(); await s.save({ locale: "de-DE" });
    const ses = fakeSession(); await applyBrowserNetwork(ses, await s.read());
    expect(ses.calls.proxy).toEqual([{ mode: "system" }]);
    expect(ses.calls.lang).toEqual(["de-DE"]);
  });
});

describe("credentials stay in the encrypted store", () => {
  it("plain config holds no URL, host, user or password", async () => {
    const s = store(); await s.save({ proxyUrl: URL_WITH_CREDS, locale: "fr-FR" });
    const files = readdirSync(dir);
    const plain = files.filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const raw = readFileSync(join(dir, f)).toString("latin1");
      if (plain.includes(f)) for (const secret of ["fixture-user", "secret", "proxy.example", "socks5"]) expect(raw).not.toContain(secret);
      else { for (const secret of ["fixture-user", "secret"]) expect(raw).not.toContain(secret); }
    }
    expect(files.some((f) => f.endsWith(".bin"))).toBe(true);
    const back = await s.read();
    expect(back.proxy).toEqual(parseSocks5Url(URL_WITH_CREDS));
    expect(back.locale).toBe("fr-FR");
  });
  it("refuses to save a proxy when the credential store cannot encrypt", async () => {
    const s = createBrowserProxyStore({ safeStorage: { ...fakeSafeStorage, isAsyncEncryptionAvailable: async () => false }, directory: dir, platform: "darwin" });
    await expect(s.save({ proxyUrl: URL_WITH_CREDS })).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
  it("clearing removes the proxy and its sealed file", async () => {
    const s = store(); await s.save({ proxyUrl: URL_WITH_CREDS }); await s.save({ proxyUrl: null });
    expect((await s.read()).proxy).toBeNull();
    expect(readdirSync(dir).filter((f) => f.endsWith(".bin"))).toEqual([]);
  });
  it("rejects a malformed locale", async () => { await expect(store().save({ locale: "en_US; x" })).rejects.toThrow(); });
});

describe("applying a proxy", () => {
  it("a proxy without credentials also uses the checked relay", async () => {
    const s = store(); await s.save({ proxyUrl: "socks5://proxy.example:1080" });
    const ses = fakeSession(); const seen = [];
    await applyBrowserNetwork(ses, await s.read(), { startRelay: async proxy => { seen.push(proxy); return { port: 4555, close() {} }; } });
    expect(seen).toHaveLength(1);
    expect(ses.calls.proxy).toEqual([{ mode: "fixed_servers", proxyRules: "socks5://127.0.0.1:4555" }]);
  });
  it("credentials never reach Chromium's proxy rules; a loopback relay carries them", async () => {
    const s = store(); await s.save({ proxyUrl: URL_WITH_CREDS });
    const ses = fakeSession(); const relays = [];
    await applyBrowserNetwork(ses, await s.read(), { startRelay: async (p) => { relays.push(p); return { port: 4555, close() {} }; } });
    expect(relays).toEqual([parseSocks5Url(URL_WITH_CREDS)]);
    expect(ses.calls.proxy).toEqual([{ mode: "fixed_servers", proxyRules: "socks5://127.0.0.1:4555" }]);
    expect(JSON.stringify(ses.calls)).not.toContain("secret");
  });
});

describe("auth relay", () => {
  it("answers no-auth locally and logs in upstream with the stored credentials", async () => {
    const seen = {};
    const upstream = createServer((c) => {
      let stage = 0;
      c.on("data", (d) => {
        if (stage === 0) { seen.methods = [...d]; c.write(Buffer.from([5, 2])); stage = 1; }
        else if (stage === 1) { seen.auth = d.toString("latin1", 2); c.write(Buffer.from([1, 0])); stage = 2; }
        else if (stage === 2) { seen.connect = [...d]; c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); stage = 3; }
        else c.write(d);
      });
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const relay = await createSocks5AuthRelay({ host: "127.0.0.1", port: upstream.address().port, username: "u1", password: "p1" }, { resolveHost: async () => ({ endpoints: [{ address: "93.184.216.34" }] }) });
    try {
      const reply = await new Promise((resolve, reject) => {
        const c = connect(relay.port, "127.0.0.1"); const got = []; let stage = 0;
        c.on("error", reject);
        c.on("data", (d) => {
          got.push([...d]);
          if (stage === 0) { c.write(Buffer.concat([Buffer.from([5, 1, 0, 3, 11]), Buffer.from("example.com"), Buffer.from([0, 80])])); stage = 1; }
          else if (stage === 1) { c.write("ping"); stage = 2; }
          else { c.destroy(); resolve(got); }
        });
        c.write(Buffer.from([5, 1, 0]));
      });
      expect(reply[0]).toEqual([5, 0]);
      expect(seen.methods).toEqual([5, 2, 0, 2]);
      expect(seen.auth).toBe("u1\x02p1");
      expect(seen.connect).toEqual([5, 1, 0, 1, 93, 184, 216, 34, 0, 80]);
      expect(Buffer.from(reply[2]).toString()).toBe("ping");
    } finally { relay.close(); upstream.close(); }
  });
  it("binds loopback only", async () => {
    const relay = await createSocks5AuthRelay({ host: "127.0.0.1", port: 9, username: "u", password: "p" });
    try { expect(relay.address).toBe("127.0.0.1"); } finally { relay.close(); }
  });
});


describe("review regressions: fail closed", () => {
  it.each(["unreadable", "malformed", "locked", "missing sealed", "missing marker"])("refuses navigation for %s configuration", async (failure) => {
    const s = store(); await s.save({ proxyUrl: URL_WITH_CREDS });
    let damaged = s;
    if (failure === "unreadable") damaged = store({ fs: { readFile: async () => { throw Object.assign(new Error("read denied"), { code: "EACCES" }); } } });
    if (failure === "malformed") writeFileSync(join(dir, "browser-network.json"), "{");
    if (failure === "locked") damaged = store({ safeStorage: { ...fakeSafeStorage, decryptString: () => { throw new Error(URL_WITH_CREDS); } } });
    if (failure === "missing sealed") rmSync(join(dir, "browser-proxy.bin"));
    if (failure === "missing marker") rmSync(join(dir, "browser-network.json"));
    const ses = fakeSession();
    await expect(damaged.read().then(settings => applyBrowserNetwork(ses, settings))).rejects.toThrow("Browser network settings are unavailable");
    expect(ses.calls.proxy).toEqual([]);
  });
});

describe("review regressions: configuration command", () => {
  it("saves stdin settings through the production command, then applies them", async () => {
    const output = [];
    const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    const hook = main.match(/const browserNetworkConfiguration = runBrowserNetworkCommand\(\{[\s\S]*?\n\}\);/)?.[0] ?? "const browserNetworkConfiguration = Promise.resolve(false);";
    await runInNewContext(`(() => { ${hook} return browserNetworkConfiguration; })()`, {
      runBrowserNetworkCommand: proxySettings.runBrowserNetworkCommand,
      process: { argv: ["app", "--browser-network-config"], stdin: Readable.from([JSON.stringify({ proxyUrl: URL_WITH_CREDS, locale: "fr-FR" })]), stdout: { write: line => output.push(line) } },
      browserProxyStore: () => store(), app: { whenReady: async () => {}, exit: code => output.push(code) },
    });
    expect((await store().read()).proxy).toEqual(parseSocks5Url(URL_WITH_CREDS));
    expect(output).toEqual(["Browser network settings saved. Restart Murage to apply them.\n", 0]);
    expect(readFileSync(join(dir, "browser-network.json"), "utf8")).not.toContain("secret");
    expect(main).toContain('if (process.argv.includes("--browser-network-config")) { await browserNetworkConfiguration; return; }');
    expect(main.indexOf("const browserNetworkConfiguration =")).toBeLessThan(main.indexOf("const desktopStartup ="));
  });
  it("closes a relay when applying the session proxy fails", async () => {
    let closed = 0;
    const ses = { setProxy: async () => { throw new Error("fixture failure"); } };
    await expect(applyBrowserNetwork(ses, { proxy: parseSocks5Url(URL_WITH_CREDS) }, { startRelay: async () => ({ port: 1, close: () => closed++ }) })).rejects.toThrow();
    expect(closed).toBe(1);
  });
});

// A fake SOCKS server deliberately holds authentication while the browser
// sends the rest of CONNECT. No destination is contacted and no DNS is used.
describe("review regressions: fragmented relay", () => {
  async function fixture(run, options = {}) {
    const peers = new Set();
    let acceptAuth, observedAuth;
    const authSeen = new Promise(r => { observedAuth = r; });
    const request = Buffer.concat([Buffer.from([5, 1, 0, 3, 11]), Buffer.from("example.com"), Buffer.from([0, 80])]);
    let received = Buffer.alloc(0);
    const upstream = createServer(c => {
      peers.add(c); c.on("close", () => peers.delete(c));
      let stage = 0;
      c.on("data", d => {
        if (stage === 0) { stage = 1; c.write(Buffer.from([5, 2])); }
        else if (stage === 1) { stage = 2; acceptAuth = () => c.write(Buffer.from([1, 0])); observedAuth(c); }
        else { received = Buffer.concat([received, d]); if (received.length >= 10) c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); }
      });
    });
    await new Promise(r => upstream.listen(0, "127.0.0.1", r));
    const relay = await createSocks5AuthRelay({ host: "127.0.0.1", port: upstream.address().port, username: "u", password: "p" }, { resolveHost: async () => ({ endpoints: [{ address: "93.184.216.34" }] }), ...options });
    const client = connect(relay.port, "127.0.0.1");
    client.on("error", () => {});
    const next = () => new Promise(r => client.once("data", r));
    try {
      const greeting = next(); client.write(Buffer.from([5, 1, 0])); await greeting;
      client.write(request.subarray(0, 5));
      const peer = await authSeen;
      await run({ client, peer, request, next, acceptAuth, received: () => received });
    } finally { client.destroy(); relay.close(); for (const c of peers) c.destroy(); await new Promise(r => upstream.close(r)); }
  }
  it("preserves CONNECT fragments sent during delayed upstream authentication", async () => {
    await fixture(async ({ client, request, next, acceptAuth, received }) => {
      client.write(request.subarray(5, 10));
      await new Promise(r => setTimeout(r, 30));
      client.write(request.subarray(10));
      await new Promise(r => setTimeout(r, 30));
      const reply = next(); acceptAuth();
      const result = await Promise.race([reply, new Promise(r => setTimeout(() => r(null), 300))]);
      expect(received()).toEqual(Buffer.from([5, 1, 0, 1, 93, 184, 216, 34, 0, 80]));
      expect(result?.[1]).toBe(0);
    });
  });
  it("closes the upstream when the client disconnects during authentication", async () => {
    await fixture(async ({ client, peer }) => {
      const closed = new Promise(r => peer.once("close", () => r(true)));
      client.destroy();
      expect(await Promise.race([closed, new Promise(r => setTimeout(() => r(false), 300))])).toBe(true);
    });
  });
  it("bounds stalled authentication with a timeout", async () => {
    await fixture(async ({ peer }) => {
      const closed = new Promise(r => peer.once("close", () => r(true)));
      expect(await Promise.race([closed, new Promise(r => setTimeout(() => r(false), 300))])).toBe(true);
    }, { handshakeTimeoutMs: 60 });
  });
});


describe("configuration command boundaries", () => {
  it("leaves stdin and storage untouched on an ordinary launch", async () => {
    const input = Readable.from(["unused"]);
    const result = await proxySettings.runBrowserNetworkCommand({ argv: ["app"], input, store: { save() { throw new Error("Unexpected save"); } } });
    expect(result).toBe(false);
    expect(input.readableFlowing).toBeNull();
  });
  it.each(["not-json", JSON.stringify({ proxyUrl: URL_WITH_CREDS, extra: "refuse" }), JSON.stringify({ proxyUrl: 5 }), "x".repeat(16385)])("refuses invalid input without disclosing it (%#)", async text => {
    const output = [];
    await proxySettings.runBrowserNetworkCommand({ argv: ["--browser-network-config"], input: Readable.from([text]), store: store(), ready: async () => {}, exit: code => output.push(code), write: line => output.push(line) });
    expect(output).toEqual(["Browser network settings could not be saved.\n", 1]);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("can explicitly reset a damaged configuration through stdin", async () => {
    await store().save({ proxyUrl: URL_WITH_CREDS });
    writeFileSync(join(dir, "browser-network.json"), "{");
    const output = [];
    await proxySettings.runBrowserNetworkCommand({ argv: ["--browser-network-config"], input: Readable.from(['{"proxyUrl":null,"locale":null}']), store: store(), ready: async () => {}, exit: code => output.push(code), write: line => output.push(line) });
    expect(output.at(-1)).toBe(0);
    expect(await store().read()).toEqual({ proxy: null, locale: null });
  });
});


describe("configuration command readiness", () => {
  it("waits for ready without blocking main module evaluation", async () => {
    const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    const hook = main.match(/(?:await|const browserNetworkConfiguration =) runBrowserNetworkCommand\(\{[\s\S]*?\n\}\);/)?.[0] ?? "";
    let evaluated = false, task, releaseReady;
    const ready = new Promise(r => { releaseReady = r; });
    const evaluation = runInNewContext(`(async () => { ${hook} if (typeof browserNetworkConfiguration !== "undefined") track(browserNetworkConfiguration); markEvaluated(); })()`, {
      runBrowserNetworkCommand: proxySettings.runBrowserNetworkCommand,
      process: { argv: ["app", "--browser-network-config"], stdin: Readable.from(['{"locale":"fr-FR"}']), stdout: { write() {} } },
      browserProxyStore: () => store(), app: { whenReady: () => ready, exit() {} },
      track: pending => { task = pending; }, markEvaluated: () => { evaluated = true; },
    });
    try {
      // Electron emits ready after evaluating the main module. A top-level
      // await of this command would prevent that event and deadlock saving.
      await new Promise(r => setImmediate(r));
      expect(evaluated).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
    } finally { releaseReady(); await evaluation; await task; }
    expect((await store().read()).locale).toBe("fr-FR");
  });
});


describe("ordinary startup stays independent of configuration mode", () => {
  const gateSource = () => readFileSync(new URL("./main.mjs", import.meta.url), "utf8").match(/if \(process.argv.includes\("--browser-network-config"\)\) \{ await browserNetworkConfiguration; return; \}/)?.[0] ?? "if (await browserNetworkConfiguration) return;";
  it("structural: ordinary startup gates the command await on its explicit flag", () => {
    // Source placement constraint only; this is not a behavioral mutant kill.
    expect(gateSource()).toBe('if (process.argv.includes("--browser-network-config")) { await browserNetworkConfiguration; return; }');
  });
  it("configuration mode waits and exits the startup callback before ordinary work", async () => {
    let finish;
    const pending = new Promise(r => { finish = r; });
    const ordinary = [];
    const boot = runInNewContext(`(async () => { ${gateSource()} ordinary.push("started"); })()`, { process: { argv: ["--browser-network-config"] }, browserNetworkConfiguration: pending, ordinary });
    await new Promise(r => setImmediate(r)); expect(ordinary).toEqual([]);
    finish(true); await boot; expect(ordinary).toEqual([]);
  });
});


it("structural: configuration stays outside the single-instance election", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const first = main.indexOf("if (!app.requestSingleInstanceLock()) {");
  const last = main.indexOf("function deliverPackageInstall", first);
  expect(first).toBeGreaterThan(0); expect(last).toBeGreaterThan(first);
  // Source placement constraint only; dependencies omitted from a snippet
  // cannot establish a broken production startup.
  expect(main.slice(first, last)).not.toContain("browserNetworkConfiguration");
  expect(main.slice(first, last)).not.toContain("runBrowserNetworkCommand");
});

// Fake upstream SOCKS server: DNS-over-HTTPS replies and destination CONNECTs
// stay on loopback. secureConnect is replaced only at this fixture boundary.
describe("proxy-resolved relay boundary", () => {
  async function fixture(run, dnsAddress = "93.184.216.34") {
    const sockets = new Set(), targets = [], queries = [], tlsOptions = [];
    const server = createServer(socket => {
      sockets.add(socket); socket.on("close", () => sockets.delete(socket));
      let stage = "greeting", buffer = Buffer.alloc(0);
      socket.on("data", chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === "greeting" && buffer.length >= 2 + buffer[1]) {
          buffer = buffer.subarray(2 + buffer[1]); stage = "connect"; socket.write(Buffer.from([5, 0]));
        }
        const size = buffer[3] === 3 ? 7 + buffer[4] : buffer[3] === 4 ? 22 : 10;
        if (stage === "connect" && buffer.length >= size) {
          const request = buffer.subarray(0, size); buffer = buffer.subarray(size);
          const address = request[3] === 3 ? request.subarray(5, size - 2).toString() : request[3] === 4 ? Array.from({ length: 8 }, (_, i) => request.readUInt16BE(4 + 2 * i).toString(16)).join(":") : [...request.subarray(4, 8)].join(".");
          const port = request.readUInt16BE(size - 2);
          targets.push({ address, port, atyp: request[3] });
          stage = port === 443 && address === "1.1.1.1" ? "dns" : "destination";
          socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        }
        if (stage === "dns" && buffer.includes("\r\n\r\n")) {
          const request = buffer.toString(); buffer = Buffer.alloc(0);
          const url = new URL(request.split(" ")[1], "https://resolver.example");
          queries.push(url.searchParams.get("name"));
          const type = Number(url.searchParams.get("type"));
          const body = JSON.stringify({ Status: 0, Answer: type === 1 ? [{ type, data: dnsAddress }] : [] });
          socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/dns-json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        }
        if (stage === "destination" && buffer.length) { socket.write(buffer); buffer = Buffer.alloc(0); }
      });
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const proxy = { host: "127.0.0.1", port: server.address().port, username: "", password: "" };
    const resolveHost = proxySettings.createProxyHostResolver?.(proxy, { secureConnect: options => { tlsOptions.push(options); return options.socket; } });
    const relay = await createSocks5AuthRelay(proxy, { resolveHost });
    const client = connect(relay.port, "127.0.0.1"); client.on("error", () => {});
    const next = () => new Promise(r => { const done = value => { client.off("data", data); client.off("close", closed); r(value); }; const data = d => done(d); const closed = () => done(null); client.once("data", data); client.once("close", closed); });
    try {
      const greeting = next(); client.write(Buffer.from([5, 1, 0])); expect(await greeting).toEqual(Buffer.from([5, 0]));
      await run({ relay, client, next, targets, queries, tlsOptions, setDnsAddress: address => { dnsAddress = address; } });
    } finally { client.destroy(); relay.close(); for (const socket of sockets) socket.destroy(); await new Promise(r => server.close(r)); }
  }
  const domainRequest = () => Buffer.concat([Buffer.from([5, 1, 0, 3, 15]), Buffer.from("private.example"), Buffer.from([0, 80])]);
  it("resolves through SOCKS with verified TLS and pins a public numeric CONNECT", async () => {
    await fixture(async ({ client, next, targets, queries, tlsOptions }) => {
      const reply = next(); client.write(domainRequest()); expect((await reply)?.[1]).toBe(0);
      expect(queries).toEqual(["private.example", "private.example"]);
      expect(tlsOptions).toHaveLength(2);
      expect(tlsOptions.every(options => options.servername === "cloudflare-dns.com" && options.rejectUnauthorized === true)).toBe(true);
      expect(targets.filter(target => target.port === 80)).toEqual([{ address: "93.184.216.34", port: 80, atyp: 1 }]);
      const echo = next(); client.write("ping"); expect((await echo).toString()).toBe("ping");
    });
  });
  it("refuses a hostname privately resolved by the fake SOCKS DNS service before destination CONNECT", async () => {
    await fixture(async ({ relay, client, next, targets, queries }) => {
      await expect(relay.resolveHost("private.example")).rejects.toThrow(/private-network/);
      const reply = next(); client.write(domainRequest()); expect(await reply).toBeNull();
      expect(queries).toHaveLength(4);
      expect(targets.filter(target => target.port === 80)).toEqual([]);
    }, "127.0.0.1");
  });
  it("blocks a private literal even when Chromium skips the surface gate", async () => {
    await fixture(async ({ client, next, targets }) => {
      const reply = next(); client.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 80])); expect(await reply).toBeNull();
      expect(targets.filter(target => target.port === 80)).toEqual([]);
    });
  });
  it("rechecks changed DNS at CONNECT even after a public navigation decision", async () => {
    await fixture(async ({ relay, client, next, targets, setDnsAddress }) => {
      expect((await relay.resolveHost("private.example")).endpoints[0].address).toBe("93.184.216.34");
      setDnsAddress("10.0.0.7");
      const reply = next(); client.write(domainRequest()); expect(await reply).toBeNull();
      expect(targets.filter(target => target.port === 80)).toEqual([]);
    });
  });
});
