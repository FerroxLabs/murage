import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { browserScreenshot, decodeBrowserDescriptor, readBrowserConnection } from "./browser-connection.ts";

const TOKEN = "a".repeat(64);
const alive = () => true;
const dead = () => false;

describe("browser connection descriptor", () => {
  it("accepts only a live, loopback, well-formed descriptor", () => {
    const good = { version: 1, url: "http://127.0.0.1:52144", token: TOKEN, pid: 4242 };
    expect(decodeBrowserDescriptor(good, alive)).toEqual({ url: "http://127.0.0.1:52144", token: TOKEN });
    expect(decodeBrowserDescriptor({ ...good, url: "http://127.0.0.1:52144/" }, alive)).toEqual({ url: "http://127.0.0.1:52144", token: TOKEN });
    for (const bad of [
      { ...good, url: "http://localhost:52144" },
      { ...good, url: "http://192.168.1.4:52144" },
      { ...good, url: "https://127.0.0.1:52144" },
      { ...good, url: "http://127.0.0.1:52144/v1?x=1" },
      { ...good, url: "http://user:pw@127.0.0.1:52144" },
      { ...good, url: "http://127.0.0.1" },
      { ...good, token: "short" },
      { ...good, token: TOKEN.toUpperCase() },
      { ...good, version: 2 },
      { ...good, pid: 0 },
      { ...good, extra: true },
      null,
      "nope",
    ]) {
      expect(decodeBrowserDescriptor(bad, alive)).toBeNull();
    }
    // a descriptor from a previous Electron boot points at a recycled port
    expect(decodeBrowserDescriptor(good, dead)).toBeNull();
  });

  it("reads the descriptor from an explicit file, userData, or the macOS dev fallback", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-browser-conn-"));
    const userData = join(home, "userData");
    const explicit = join(home, "explicit.json");
    const descriptor = { version: 1, url: "http://127.0.0.1:52144", token: TOKEN, pid: 4242 };
    expect(readBrowserConnection({ userData, home, platform: "darwin", alive })).toBeNull();

    writeFileSync(explicit, JSON.stringify(descriptor));
    expect(readBrowserConnection({ file: explicit, userData, home, platform: "linux", alive })).toEqual({
      url: "http://127.0.0.1:52144",
      token: TOKEN,
    });

    const support = join(home, "Library", "Application Support", "OpenMausBot");
    const { mkdirSync } = require("node:fs");
    mkdirSync(support, { recursive: true });
    writeFileSync(join(support, "browser-connection.json"), JSON.stringify({ ...descriptor, url: "http://127.0.0.1:1" }));
    expect(readBrowserConnection({ home, platform: "darwin", alive })?.url).toBe("http://127.0.0.1:1");
    // not on Linux — there the packaged app always passes userData
    expect(readBrowserConnection({ home, platform: "linux", alive })).toBeNull();

    mkdirSync(userData, { recursive: true });
    writeFileSync(join(userData, "browser-connection.json"), "{ not json");
    expect(readBrowserConnection({ userData, home, platform: "linux", alive })).toBeNull();
    writeFileSync(join(userData, "browser-connection.json"), JSON.stringify({ ...descriptor, url: "http://127.0.0.1:2" }));
    expect(readBrowserConnection({ userData, home, platform: "linux", alive })?.url).toBe("http://127.0.0.1:2");
  });

  it("asks the host for a frame with the bearer token and reads the preview shape", async () => {
    const calls: Array<{ url: string; auth: string | undefined; body: string }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), auth: headers.get("authorization") ?? undefined, body: String(init?.body) });
      return new Response(JSON.stringify({ png: "ZmFrZQ==", format: "jpeg", width: 1024, height: 600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await expect(browserScreenshot({ url: "http://127.0.0.1:52144", token: TOKEN }, "bot 1", fetchImpl, "work")).resolves.toEqual({
      png: "ZmFrZQ==",
      format: "jpeg",
    });
    expect(calls).toEqual([
      { url: "http://127.0.0.1:52144/v1/bots/bot%201/screenshot", auth: `Bearer ${TOKEN}`, body: JSON.stringify({ profile: "work" }) },
    ]);
    const failing = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    await expect(browserScreenshot({ url: "http://127.0.0.1:52144", token: TOKEN }, "bot-1", failing)).rejects.toThrow(/HTTP 500/);
  });
});
