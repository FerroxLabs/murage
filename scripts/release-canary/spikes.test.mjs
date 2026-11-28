// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterEach, expect, it } from "vitest";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

const scratch = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-canary-spikes-"));
  scratch.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of scratch.splice(0)) safeWipeSync(dir);
});

it("serves only the manifest-checked update surface over TLS and closes unknown proxy routes", async () => {
  const { startFeed } = await import("./feed.mjs");
  const dir = temp();
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  execFileSync("openssl", ["req", "-new", "-newkey", "rsa:2048", "-x509", "-nodes", "-days", "1",
    "-subj", "/CN=github.com", "-addext", "subjectAltName=DNS:github.com,DNS:api.github.com",
    "-out", cert, "-keyout", key], { stdio: "ignore" });
  const contents = { "latest-linux.yml": "version: 1.0.20\n", "candidate.AppImage": "abcdef" };
  const manifest = { schema: "murage-canary-manifest/1", version: "1.0.20", assets: {} };
  for (const [name, bytes] of Object.entries(contents)) {
    writeFileSync(join(dir, name), bytes);
    manifest.assets[name] = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  writeFileSync(join(dir, "private.txt"), "fixture");
  const log = join(dir, "feed.log");
  const options = { dir, manifest, from: "1.0.19", cert, key, log, tlsPort: 0, proxyPort: 0 };
  const feed = await startFeed(options);
  const base = "/FerroxLabs/murage-releases/releases";
  const request = (path, hostname = "github.com", headers = {}) => new Promise((resolve, reject) => {
    https.get({ host: "127.0.0.1", port: feed.tlsPort, path, ca: readFileSync(cert), servername: hostname,
      headers: { Host: hostname, ...headers } }, async response => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve([response.statusCode, Buffer.concat(chunks).toString(), response.headers]);
      } catch (error) { reject(error); }
    }).on("error", reject);
  });

  const connect = (path, tunnel = false) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: feed.proxyPort, method: "CONNECT", path });
    req.on("connect", (response, socket) => {
      if (!tunnel || response.statusCode !== 200) {
        socket.destroy();
        resolve(response.statusCode);
        return;
      }
      const secure = tls.connect({ socket, servername: "github.com", ca: readFileSync(cert) }, () => {
        secure.write(`GET ${base}/latest HTTP/1.1\r\nHost: github.com\r\nConnection: close\r\n\r\n`);
      });
      let reply = "";
      secure.setEncoding("utf8");
      secure.on("data", chunk => { reply += chunk; });
      secure.on("end", () => resolve(reply));
      secure.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });

  try {
    const atom = await request(`${base}.atom`);
    expect(atom[0]).toBe(200);
    expect(atom[1]).toMatch(/v1\.0\.20[\s\S]*v1\.0\.19/);
    expect(JSON.parse((await request(`${base}/latest`))[1]).tag_name).toBe("v1.0.20");
    expect(JSON.parse((await request(`/repos${base}/latest`, "api.github.com"))[1]).tag_name).toBe("v1.0.20");
    expect((await request(`${base}/download/v1.0.20/latest-linux.yml`))[1]).toBe(contents["latest-linux.yml"]);
    const ranged = await request(`${base}/download/v1.0.20/candidate.AppImage`, "github.com", { Range: "bytes=2-4" });
    expect(ranged.slice(0, 2)).toEqual([206, "cde"]);
    expect(ranged[2]["content-range"]).toBe("bytes 2-4/6");
    expect((await request(`${base}/download/v1.0.20/candidate.AppImage`, "github.com", { Range: "bytes=9-" }))[0]).toBe(416);
    expect((await request(`${base}/download/v1.0.20/private.txt?private=fixture`))[0]).toBe(404);
    expect((await request(`/repos${base}/latest`))[0]).toBe(404);
    expect(await connect("example.test:443")).toBe(403);
    expect(await connect("github.com:443", true)).toMatch(/HTTP\/1\.1 200[\s\S]*"tag_name":"v1\.0\.20"/);
    expect(readFileSync(log, "utf8")).not.toContain("private=fixture");
  } finally {
    await feed.close();
  }
  writeFileSync(join(dir, "candidate.AppImage"), "abcdeg");
  await expect(startFeed(options)).rejects.toThrow("ARTIFACT_MISMATCH");
});

it("requires the quit and zero-exit lines after the native process's own boundary", async () => {
  const { markLog, verifyQuit } = await import("./quit.mjs");
  const path = join(temp(), "server.log");
  const stopped = "[timestamp] server stop reason=quit\n[timestamp] exited code=0\n";
  writeFileSync(path, stopped);
  const mark = markLog(path);
  expect(() => verifyQuit(path, mark)).toThrow("NO_GRACEFUL_QUIT");
  appendFileSync(path, "[timestamp] server stop reason=update\n[timestamp] exited code=0\n");
  expect(() => verifyQuit(path, mark)).toThrow("NO_GRACEFUL_QUIT");
  appendFileSync(path, "[timestamp] server stop reason=quit\n");
  expect(() => verifyQuit(path, mark)).toThrow("NO_GRACEFUL_QUIT");
  renameSync(path, `${path}.1`);
  writeFileSync(path, "[timestamp] exited code=0\n");
  expect(verifyQuit(path, mark)).toBe(true);
});

it("refuses the wrong Linux account, credential overrides, and unprotected credential files", async () => {
  const { validateCredentialFile } = await import("./linux-credential.mjs");
  const env = { HOME: "/home/fixture" };
  const directory = { uid: 2001, mode: 0o40700, isDirectory: () => true };
  const file = { uid: 2001, mode: 0o100600, nlink: 1, size: 1, isFile: () => true };
  const input = { expectedUid: 2001, uid: 2001, env, directory, file, storeType: 0x01021994 };
  expect(validateCredentialFile(input)).toBe(true);
  for (const invalid of [
    { ...input, uid: 2002 },
    { ...input, env: { ...env, CLAUDE_SECURESTORAGE_CONFIG_DIR: "/tmp/other" } },
    { ...input, env: { ...env, ANTHROPIC_API_KEY: "fixture" } },
    { ...input, storeType: 0 },
    { ...input, directory: { ...directory, isDirectory: () => false } },
    { ...input, file: { ...file, isFile: () => false } },
    { ...input, file: { ...file, mode: 0o100644 } },
    { ...input, file: { ...file, nlink: 2 } },
  ]) expect(() => validateCredentialFile(invalid)).toThrow(/NO_CREDENTIAL|NOT_CANARY_ACCOUNT/);
});

it("requires an ordered updater check and candidate payload traffic before accepting the cached hash", async () => {
  const { feedWitness } = await import("./native-evidence.mjs");
  const channel = "latest.yml";
  const payload = "canary-next.exe";
  const events = [
    { route: "atom", status: 200 },
    { route: "latest", status: 200 },
    { route: "asset", name: channel, status: 200 },
    { route: "asset", name: payload, status: 200 },
  ];
  expect(feedWitness(events, channel, payload)).toBe("full");
  expect(feedWitness([...events.slice(0, 3),
    { route: "asset", name: payload, status: 206 }], channel, payload)).toBe("range");
  expect(() => feedWitness(events.slice(0, 3), channel, payload)).toThrow("FEED");
  expect(() => feedWitness([events[1], events[0], ...events.slice(2)], channel, payload)).toThrow("FEED");
  expect(() => feedWitness([...events, { route: "denied", status: 404 }], channel, payload)).toThrow("FEED");
});

it("keeps the memory clock running across unknown, checking and pending, and refuses holds", async () => {
  const { memoryState, waitForMemory } = await import("./native-evidence.mjs");
  let elapsed = 0;
  const health = (checking, integrityPending, hold = null) => ({
    status: 200, body: { app: "murage", launch: "launch", upgrade: { checking, held: false },
      memoryIntegrity: { integrityPending, replayHeld: false, hold } },
  });
  const samples = [{ status: 503 }, health("unknown", false), health(true, false),
    health(false, true), health(false, false)];
  const read = () => memoryState(samples.shift());
  expect(await waitForMemory(read, () => elapsed, async () => { elapsed += 5; }, 21)).toEqual({
    settled_s: 20, states_seen: ["STARTING", "UNKNOWN", "CHECKING", "PENDING", "SETTLED"],
  });
  expect(memoryState(health(false, false, "integrity hold"))).toBe("HELD");
  expect(memoryState({ status: 200, body: {} })).toBe("UNKNOWN");
  await expect(waitForMemory(async () => "CHECKING", () => elapsed, async () => { elapsed += 5; }, 10))
    .rejects.toThrow("MEMORY_STUCK");
});

it("requires a successful terminal event for the same rendered assistant row", async () => {
  const { turnWitness } = await import("./native-evidence.mjs");
  const row = { id: "answer", role: "bot", kind: "text", text: "CANARY-123-C", turnId: "turn" };
  const done = { type: "turn.completed", turnId: "turn", ok: true };
  expect(turnWitness([row], [done], "CANARY-123-C")).toBe("answer");
  expect(turnWitness([row], [], "CANARY-123-C")).toBeNull();
  expect(turnWitness([row], [{ ...done, turnId: "other" }], "CANARY-123-C")).toBeNull();
  expect(turnWitness([row], [{ ...done, ok: false }], "CANARY-123-C")).toBeNull();
  expect(turnWitness([row], [{ ...done, stopReason: "stopped" }], "CANARY-123-C")).toBeNull();
  expect(turnWitness([row, { ...row, text: "different final answer" }], [done], "CANARY-123-C")).toBeNull();
});
