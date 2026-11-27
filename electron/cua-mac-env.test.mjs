import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), isPackaged: false }, ipcMain: { handle: () => {} } }));

const KEYS = ["CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_DRIVER_RS_UPDATE_CHECK"];
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
afterEach(() => { for (const key of KEYS) saved[key] === undefined ? delete process.env[key] : (process.env[key] = saved[key]); });

describe("macOS Cua Driver environment", () => {
  it("overrides an inherited telemetry or update-check opt-in once the driver module loads", async () => {
    // A user's shell may export these on; the SDK's embedded child and every
    // spawned driver inherit process.env, so loading the module must win.
    process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = "1";
    process.env.CUA_DRIVER_RS_UPDATE_CHECK = "true";
    vi.resetModules();
    await import("./cua.mjs");
    expect(process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED).toBe("0");
    expect(process.env.CUA_DRIVER_RS_UPDATE_CHECK).toBe("false");
  });
  it("turns both off in the env of every driver descriptor it hands out", () => {
    // The descriptors need a real Mac (driver binary, socket, SDK grants), so
    // the shared constant they all spread is checked instead.
    const source = readFileSync(new URL("./cua.mjs", import.meta.url), "utf8");
    expect(source).toMatch(/const CUA_ENV = \{[^}]*CUA_DRIVER_RS_TELEMETRY_ENABLED: "0"[^}]*\}/);
    expect(source).toMatch(/const CUA_ENV = \{[^}]*CUA_DRIVER_RS_UPDATE_CHECK: "false"[^}]*\}/);
    expect(source.match(/mcpEnv: \{ \.\.\.CUA_ENV/g)).toHaveLength(3);
  });
});
