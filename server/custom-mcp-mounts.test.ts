// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { AppConfig } from "./config.ts";
import { buildRemoteMount, customIntegrations, customMountEntries, harnessEnvAllowed, ownerEnvIsRefused } from "./custom-mcp-mounts.ts";

const cfg = (mcpServers: Record<string, unknown>) => ({ mcpServers }) as unknown as AppConfig;
const context = (token = () => "t".repeat(48)) => ({ execPath: "/usr/bin/node", proxyPath: "/app/remote-mcp-proxy.js", harnessUrl: "http://127.0.0.1:8799", token });

describe("harnessEnvAllowed and ownerEnvIsRefused", () => {
  it("keeps only Murage's own names with text values", () => {
    expect(harnessEnvAllowed({ ELECTRON_RUN_AS_NODE: "1", MURAGE_MCP_TOKEN: "t", MURAGE_HARNESS_URL: "u", PATH: "/evil", HOME: "/x", NODE_OPTIONS: "--require /x", DWEB_URL: "d" }))
      .toEqual({ ELECTRON_RUN_AS_NODE: "1", MURAGE_MCP_TOKEN: "t", MURAGE_HARNESS_URL: "u", DWEB_URL: "d" });
    expect(harnessEnvAllowed(undefined)).toEqual({});
    expect(harnessEnvAllowed({ MURAGE_X: 5 as unknown as string })).toEqual({});
    expect(harnessEnvAllowed(JSON.parse('{"__proto__":"x","MURAGE_A":"1"}'))).toEqual({ MURAGE_A: "1" });
  });
  it("refuses an owner environment that names a Murage variable, in any case", () => {
    for (const name of ["MURAGE_MCP_TOKEN", "murage_harness_url", "MURAGEBOX_TOKEN", "ELECTRON_RUN_AS_NODE", "electron_run_as_node", "DWEB_URL", "PH_ANDROID_SERIAL"]) {
      expect([name, ownerEnvIsRefused({ [name]: "v" })]).toEqual([name, true]);
    }
    expect(ownerEnvIsRefused({ NOTES_TOKEN: "t", MODE: "ro" })).toBe(false);
    expect(ownerEnvIsRefused({})).toBe(false);
  });
});

describe("customMountEntries", () => {
  it("merges the harness's environment AFTER the owner's check, and owner names can never forge it", () => {
    const mounts = customMountEntries({
      svc: { command: "node", args: ["p", "--server", "svc"], env: {}, harnessEnv: { MURAGE_MCP_TOKEN: "t", ELECTRON_RUN_AS_NODE: "1" } },
      forged: { command: "evil", args: [], env: { MURAGE_MCP_TOKEN: "forged" } },
      notes: { command: "npx", args: [], env: { NOTES_TOKEN: "n" } },
    });
    expect(mounts).toEqual([
      { name: "svc", command: "node", args: ["p", "--server", "svc"], env: { MURAGE_MCP_TOKEN: "t", ELECTRON_RUN_AS_NODE: "1" } },
      { name: "notes", command: "npx", args: [], env: { NOTES_TOKEN: "n" } },
    ]);
  });
  it("a harness environment with a name Murage does not own adds nothing", () => {
    const [mount] = customMountEntries({ svc: { command: "node", args: [], env: { A: "1" }, harnessEnv: { NODE_OPTIONS: "--require /x", LD_PRELOAD: "/y", MURAGE_OK: "v" } } });
    expect(mount!.env).toEqual({ A: "1", MURAGE_OK: "v" });
  });
  it("leaves out a name the driver already mounts itself", () => {
    const custom = { "murage-memory": { command: "a", args: [], env: {} }, other: { command: "b", args: [], env: {} } };
    expect(customMountEntries(custom, (name) => name === "murage-memory").map((mount) => mount.name)).toEqual(["other"]);
    expect(customMountEntries(custom).map((mount) => mount.name)).toEqual(["murage-memory", "other"]);
    expect(customMountEntries(undefined)).toEqual([]);
  });
  it("does not change its inputs", () => {
    const custom = { svc: { command: "node", args: ["a"], env: { A: "1" }, harnessEnv: { MURAGE_MCP_TOKEN: "t" } } };
    const before = JSON.stringify(custom);
    customMountEntries(custom);
    expect(JSON.stringify(custom)).toBe(before);
  });
});

describe("buildRemoteMount and customIntegrations", () => {
  it("the proxy, the name in argv, the owner's environment empty, the harness's part set", () => {
    expect(buildRemoteMount("comfy", context(), "T")).toEqual({
      command: "/usr/bin/node", args: ["/app/remote-mcp-proxy.js", "--server", "comfy"], env: {},
      harnessEnv: { ELECTRON_RUN_AS_NODE: "1", MURAGE_HARNESS_URL: "http://127.0.0.1:8799", MURAGE_MCP_TOKEN: "T" },
    });
  });

  it("mounts enabled command servers as configured and enabled link servers as the proxy", () => {
    let minted = 0;
    const out = customIntegrations(cfg({
      notes: { command: "npx", args: ["-y", "@x/notes"], env: { NOTES_TOKEN: "n" }, enabled: true },
      comfy: { url: "https://cloud.comfy.org/mcp", auth: "oauth", enabled: true },
      keyed: { url: "https://x.example/mcp", auth: "header", headers: { "X-API-Key": "dev-string-value" }, enabled: true },
      off: { url: "https://off.example/mcp", enabled: false },
      offstdio: { command: "x", enabled: false },
      bad: { url: "ftp://nope" },
    }), context(() => { minted += 1; return "tok"; }))!;
    expect(Object.keys(out)).toEqual(["notes", "comfy", "keyed"]);
    expect(out.notes).toEqual({ command: "npx", args: ["-y", "@x/notes"], env: { NOTES_TOKEN: "n" } });
    expect(out.comfy!.args).toEqual(["/app/remote-mcp-proxy.js", "--server", "comfy"]);
    expect(out.keyed!.harnessEnv!.MURAGE_MCP_TOKEN).toBe("tok");
    expect(minted).toBe(1);
  });

  it("never mounts Netlify's own server, even switched on and under any name: publishing goes through the approval card", () => {
    const out = customIntegrations(cfg({
      netlify: { url: "https://netlify-mcp.netlify.app/mcp", auth: "oauth", enabled: true },
      renamed: { url: "https://NETLIFY-MCP.netlify.app./mcp", auth: "oauth", enabled: true },
      comfy: { url: "https://cloud.comfy.org/mcp", auth: "oauth", enabled: true },
      "publish-netlify": { command: "node", args: ["-e", "0"], env: { NETLIFY_AUTH_TOKEN: "nfp_x" }, enabled: true },
    }), context())!;
    expect(Object.keys(out)).toEqual(["comfy"]);
    expect(JSON.stringify(out)).not.toContain("nfp_x");
  });

  it("mints no token when there is no link server, and returns nothing when there is nothing", () => {
    let minted = 0;
    const token = () => { minted += 1; return "tok"; };
    expect(customIntegrations(cfg({ notes: { command: "npx" } }), context(token))).toEqual({ notes: { command: "npx", args: [], env: {} } });
    expect(customIntegrations(cfg({}), context(token))).toBeUndefined();
    expect(customIntegrations({} as AppConfig, context(token))).toBeUndefined();
    expect(minted).toBe(0);
  });

  it("no secret of a link server reaches a mount: not its key, not its link, not a path token", () => {
    const out = customIntegrations(cfg({
      keyed: { url: "https://x.example/mcp", auth: "header", headers: { "X-API-Key": "sk-live-DEV-STRING" }, enabled: true },
      zap: { url: "https://mcp.zapier.com/api/mcp/s/•••/mcp", urlSecret: true, enabled: true },
      tokenised: { url: "https://h.example/s/abcdefghijklmnopqrstuvwx/mcp", urlSecret: true, enabled: true },
    }), context())!;
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/sk-live-DEV-STRING|abcdefghijklmnopqrstuvwx|zapier|x\.example|h\.example/);
    for (const name of ["keyed", "zap", "tokenised"]) {
      expect(out[name]!.args).toEqual(["/app/remote-mcp-proxy.js", "--server", name]);
      expect(Object.keys(out[name]!.harnessEnv!).sort()).toEqual(["ELECTRON_RUN_AS_NODE", "MURAGE_HARNESS_URL", "MURAGE_MCP_TOKEN"]);
    }
  });
});

describe("module hygiene", () => {
  it("carries the license header and the drivers no longer hold their own copy of the filter", () => {
    const source = readFileSync(new URL("./custom-mcp-mounts.ts", import.meta.url), "utf8");
    expect(source).toContain("SPDX-License-Identifier: AGPL-3.0-or-later");
    for (const file of ["drivers/claude.ts", "drivers/codex.ts", "drivers/acp/core.ts"]) {
      const driver = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(driver, file).toContain("customMountEntries(");
      expect(driver, file).not.toContain("isHarnessOwnedMcpEnvName");
    }
  });
});
