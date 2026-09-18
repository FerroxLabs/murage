import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isUserChromeEndpoint, readUserChromeEndpoint, userChromeDataDir, userChromeEndpointFromPortFile } from "./user-chrome.ts";

const scratch: string[] = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), "murage-user-chrome-")); scratch.push(path); return path; };
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
const ID = "4c1b0f0e-9a2d-4e8f-b1c3-5d6e7f8a9b0c";

describe("the owner's Chrome endpoint", () => {
  it("builds a loopback browser WebSocket from DevToolsActivePort, LF or CRLF", () => {
    expect(userChromeEndpointFromPortFile(`9222\n/devtools/browser/${ID}\n`)).toBe(`ws://127.0.0.1:9222/devtools/browser/${ID}`);
    expect(userChromeEndpointFromPortFile(`61001\r\n/devtools/browser/${ID}`)).toBe(`ws://127.0.0.1:61001/devtools/browser/${ID}`);
  });
  it("refuses a missing, out-of-range or malformed port and any path that is not a browser target", () => {
    for (const text of [
      "", "9222", `0\n/devtools/browser/${ID}`, `65536\n/devtools/browser/${ID}`, `92a2\n/devtools/browser/${ID}`,
      `9222\n/devtools/page/${ID}`, `9222\n/devtools/browser/${ID}?x=1`, `9222\n//evil.example/devtools/browser/${ID}`,
      `9222\n/devtools/browser/@evil.example`, `9222\n/devtools/browser/`,
    ]) expect(userChromeEndpointFromPortFile(text), JSON.stringify(text)).toBeNull();
  });
  it("accepts only the loopback shape it produces as a CDP target", () => {
    expect(isUserChromeEndpoint(`ws://127.0.0.1:9222/devtools/browser/${ID}`)).toBe(true);
    for (const value of [
      "9222", `http://127.0.0.1:9222/devtools/browser/${ID}`, `ws://localhost:9222/devtools/browser/${ID}`,
      `ws://10.0.0.5:9222/devtools/browser/${ID}`, `ws://127.0.0.1:70000/devtools/browser/${ID}`,
      `ws://127.0.0.1:9222/devtools/browser/${ID}/x`, `wss://127.0.0.1:9222/devtools/browser/${ID}`, undefined,
    ]) expect(isUserChromeEndpoint(value), String(value)).toBe(false);
  });
  it("reads the file from Chrome's user-data directory and reports null when remote debugging is off", () => {
    const dir = temporary();
    expect(readUserChromeEndpoint(dir)).toBeNull();
    writeFileSync(join(dir, "DevToolsActivePort"), `9333\n/devtools/browser/${ID}\n`);
    expect(readUserChromeEndpoint(dir)).toBe(`ws://127.0.0.1:9333/devtools/browser/${ID}`);
    writeFileSync(join(dir, "DevToolsActivePort"), `9333\n/devtools/browser/${ID}\n${"x".repeat(600)}`);
    expect(readUserChromeEndpoint(dir)).toBeNull();
  });
  it.skipIf(process.platform === "win32")("does not follow a DevToolsActivePort link", () => {
    const dir = temporary(), elsewhere = join(temporary(), "real");
    writeFileSync(elsewhere, `9333\n/devtools/browser/${ID}\n`);
    symlinkSync(elsewhere, join(dir, "DevToolsActivePort"));
    expect(readUserChromeEndpoint(dir)).toBeNull();
  });
  it("names Google Chrome's default user-data directory on each platform", () => {
    expect(userChromeDataDir("darwin", {}, "/Users/a")).toBe(join("/Users/a", "Library", "Application Support", "Google", "Chrome"));
    expect(userChromeDataDir("win32", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "C:\\Users\\a")).toBe(join("C:\\Users\\a\\AppData\\Local", "Google", "Chrome", "User Data"));
    expect(userChromeDataDir("linux", {}, "/home/a")).toBe(join("/home/a", ".config", "google-chrome"));
    expect(userChromeDataDir("linux", { XDG_CONFIG_HOME: "/xdg" }, "/home/a")).toBe(join("/xdg", "google-chrome"));
  });
});
