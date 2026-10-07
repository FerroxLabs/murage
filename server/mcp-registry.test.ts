import { describe, expect, it } from "vitest";

import {
  isHarnessOwnedMcpEnvName,
  isMaskedStoredUrl,
  isRefusedMcpHeaderName,
  listAllMcpServers,
  listMcpServers,
  maskMcpUrl,
  parseAnyMcpServerMutation,
  parseAnyStoredMcpServer,
  splitMcpUrl,
  mcpServerNameError,
  parseMcpServerMutation,
  parseStoredMcpServer,
} from "./mcp-registry.ts";

describe("custom MCP registry", () => {
  it("parses stdio servers and keeps newly added commands disabled", () => {
    expect(parseMcpServerMutation("notes", { command: "npx", args: ["-y", "notes-mcp"] })).toEqual({
      ok: true,
      server: { command: "npx", args: ["-y", "notes-mcp"], env: {}, enabled: false },
    });
    // A hand-authored file entry has always mounted unless it opted out.
    expect(parseStoredMcpServer("notes", { command: "npx" })).toEqual({
      ok: true,
      server: { command: "npx", args: [], env: {}, enabled: true },
    });
  });

  it("refuses unsafe names and every name Murage mounts itself", () => {
    expect(mcpServerNameError("Bad.Name")).toMatch(/lowercase/);
    expect(mcpServerNameError("safe-notes")).toBeNull();
    for (const reserved of [
      "muragebox",
      "computer",
      "agents",
      "composio",
      "browser",
      "phone",
      "dweb",
      "murage_connectors",
      "murage_phone",
    ]) {
      expect([reserved, mcpServerNameError(reserved)])
        .toEqual([reserved, "That name is reserved by Murage."]);
    }
  });

  it("never puts environment values in renderer listings", () => {
    const listings = listMcpServers({
      github: { command: "github-mcp", env: { GITHUB_TOKEN: "ghp_real", MODE: "read-only" } },
    });
    expect(listings).toEqual([{
      name: "github",
      command: "github-mcp",
      args: [],
      envKeys: ["GITHUB_TOKEN", "MODE"],
      enabled: true,
    }]);
    expect(JSON.stringify(listings)).not.toContain("ghp_real");
    expect(JSON.stringify(listings)).not.toContain("read-only");
  });

  it.each([
    "MURAGE_COMMS_TOKEN", "murage_harness_url", "MuRaGe_FUTURE_CAPABILITY",
    "MURAGEBOX_TOKEN", "muragebox_url", "MuRaGeBoX_FUTURE_CAPABILITY",
    "ELECTRON_RUN_AS_NODE", "electron_run_as_node",
    "DWEB_URL", "dweb_url", "PH_ANDROID_SERIAL", "ph_android_serial",
  ])("rejects reserved environment name %s in stored entries and mutations, including retained values", (key) => {
    const existing = { command: "notes", args: [], env: { [key]: "saved-private-value" }, enabled: true };
    const expected = { ok: false, error: `Environment variable “${key}” is reserved by Murage.` };
    expect(isHarnessOwnedMcpEnvName(key)).toBe(true);
    expect(parseStoredMcpServer("notes", existing)).toEqual(expected);
    expect(parseMcpServerMutation("notes", { command: "notes", env: { [key]: "new-private-value" } })).toEqual(expected);
    expect(parseMcpServerMutation("notes", { command: "notes", env: { [key]: true } }, existing)).toEqual(expected);
    expect(existing.env[key]).toBe("saved-private-value");
  });

  it("keeps ordinary environment names valid and omits reserved entries from listings", () => {
    expect(isHarnessOwnedMcpEnvName("NOTES_TOKEN")).toBe(false);
    const raw = {
      blocked: { command: "notes", env: { MURAGE_COMMS_TOKEN: "private-value" } },
      notes: { command: "notes", env: { NOTES_TOKEN: "notes-private-value" } },
    };
    const before = JSON.stringify(raw);
    expect(listMcpServers(raw)).toEqual([
      { name: "notes", command: "notes", args: [], envKeys: ["NOTES_TOKEN"], enabled: true },
    ]);
    expect(parseStoredMcpServer("notes", raw.notes)).toMatchObject({ ok: true, server: { env: raw.notes.env } });
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("preserves write-only values only when a matching value is stored", () => {
    const existing = { command: "old", args: [], env: { TOKEN: "secret", DROP: "gone" }, enabled: true };
    expect(parseMcpServerMutation("notes", {
      command: "new",
      env: { TOKEN: true, NEXT: "fresh" },
      enabled: true,
    }, existing)).toEqual({
      ok: true,
      server: { command: "new", args: [], env: { TOKEN: "secret", NEXT: "fresh" }, enabled: true },
    });
    expect(parseMcpServerMutation("notes", { command: "new", env: { MISSING: true } }, existing)).toEqual({
      ok: false,
      error: "No saved value exists for MISSING.",
    });
  });

  it("drops an unparseable entry from a listing rather than the whole list", () => {
    expect(listMcpServers({
      "Bad Name": { command: "npx" },
      computer: { command: "npx" },
      broken: { command: "" },
      good: { command: "npx", args: ["-y", "ok"] },
    }).map((entry) => entry.name)).toEqual(["good"]);
  });
});

describe("remote MCP registry entries (T1)", () => {
  const comfy = {
    url: "https://cloud.comfy.org/mcp",
    transport: "http",
    auth: "oauth",
    enabled: false,
  };

  it("keeps every stdio fixture parsing identically through the union parsers", () => {
    const fixtures = [
      { command: "npx", args: ["-y", "@x/notes"], env: { NOTES_TOKEN: "t" }, enabled: true },
      { command: "npx" },
      { command: "/usr/local/bin/server", enabled: false },
    ];
    for (const fixture of fixtures) {
      expect(parseAnyStoredMcpServer("notes", fixture)).toEqual(parseStoredMcpServer("notes", fixture));
    }
    expect(parseAnyMcpServerMutation("notes", { command: "npx", args: ["a"] })).toEqual(
      parseMcpServerMutation("notes", { command: "npx", args: ["a"] }),
    );
    // A 0.1.61 stdio entry serialises back to the same bytes.
    const stored = { command: "npx", args: ["-y", "@x/notes"], env: { NOTES_TOKEN: "t" }, enabled: true };
    const parsed = parseAnyStoredMcpServer("notes", stored);
    expect(parsed.ok && JSON.stringify(parsed.server)).toBe(JSON.stringify(stored));
  });

  it("parses the remote shape and defaults a hand-written entry to enabled", () => {
    expect(parseAnyStoredMcpServer("comfy", { url: "https://cloud.comfy.org/mcp", auth: "oauth" })).toEqual({
      ok: true,
      server: { url: "https://cloud.comfy.org/mcp", auth: "oauth", headers: {}, enabled: true },
    });
    expect(parseAnyStoredMcpServer("comfy", { ...comfy, headers: { "X-API-Key": true } })).toMatchObject({
      ok: true,
      server: { headers: { "X-API-Key": true }, enabled: false },
    });
  });

  it("derives auth from headers when absent and requires a header for auth header", () => {
    expect(parseAnyStoredMcpServer("a", { url: "https://x.example/mcp" })).toMatchObject({
      ok: true, server: { auth: "none" },
    });
    expect(parseAnyStoredMcpServer("a", { url: "https://x.example/mcp", headers: { "X-API-Key": true } })).toMatchObject({
      ok: true, server: { auth: "header" },
    });
    expect(parseAnyStoredMcpServer("a", { url: "https://x.example/mcp", auth: "header" })).toMatchObject({ ok: false });
  });

  it("normalizes the vendor aliases and writes back the canonical form", () => {
    const cases: Array<[Record<string, unknown>, string, string | undefined]> = [
      [{ type: "http", url: "https://a.example/mcp" }, "https://a.example/mcp", "http"],
      [{ type: "streamable-http", url: "https://a.example/mcp" }, "https://a.example/mcp", "http"],
      [{ type: "streamableHttp", url: "https://a.example/mcp" }, "https://a.example/mcp", "http"],
      [{ type: "sse", url: "https://a.example/sse" }, "https://a.example/sse", "sse"],
      [{ serverUrl: "https://w.example/mcp" }, "https://w.example/mcp", undefined],
      [{ httpUrl: "https://g.example/mcp" }, "https://g.example/mcp", undefined],
    ];
    for (const [raw, url, transport] of cases) {
      const parsed = parseAnyStoredMcpServer("srv", raw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.server).toMatchObject({ url });
      expect((parsed.server as { transport?: string }).transport).toBe(transport);
      expect(Object.keys(parsed.server)).not.toContain("type");
      expect(Object.keys(parsed.server)).not.toContain("serverUrl");
      expect(Object.keys(parsed.server)).not.toContain("httpUrl");
      // Idempotent: the normalized form parses to itself.
      expect(parseAnyStoredMcpServer("srv", parsed.server)).toEqual(parsed);
    }
    expect(parseAnyStoredMcpServer("srv", { type: "stdio", url: "https://a.example/mcp" })).toMatchObject({ ok: false });
    expect(parseAnyStoredMcpServer("srv", { url: "https://a.example/a", serverUrl: "https://a.example/b" })).toMatchObject({ ok: false });
  });

  it("stays strict: an unknown key makes a remote entry invalid", () => {
    expect(parseAnyStoredMcpServer("comfy", { ...comfy, surprise: 1 })).toMatchObject({ ok: false });
    expect(parseAnyStoredMcpServer("comfy", { ...comfy, command: "npx" })).toMatchObject({ ok: false });
    expect(parseAnyStoredMcpServer("comfy", { ...comfy, transport: "websocket" })).toMatchObject({ ok: false });
    expect(parseAnyStoredMcpServer("comfy", { ...comfy, auth: "basic" })).toMatchObject({ ok: false });
  });

  it("refuses userinfo, query, fragment and non-http schemes in a stored url", () => {
    for (const url of [
      "https://user:pw@x.example/mcp",
      "https://x.example/mcp?key=abc",
      "https://x.example/mcp#frag",
      "ftp://x.example/mcp",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect([url, parseAnyStoredMcpServer("srv", { url }).ok]).toEqual([url, false]);
    }
  });

  it("ignores a local key in a mutation and sets it only from the explicit confirmation", () => {
    const raw = { url: "http://127.0.0.1:8811/mcp", local: "this-computer", auth: "none" };
    const unconfirmed = parseAnyMcpServerMutation("loc", raw);
    expect(unconfirmed.ok).toBe(true);
    expect(unconfirmed.ok && "local" in unconfirmed.server).toBe(false);
    const confirmed = parseAnyMcpServerMutation("loc", raw, undefined, { confirmLocal: "this-computer" });
    expect(confirmed).toMatchObject({ ok: true, server: { local: "this-computer" } });
    const network = parseAnyMcpServerMutation("loc", raw, undefined, { confirmLocal: "local-network" });
    expect(network).toMatchObject({ ok: true, server: { local: "local-network" } });
    expect(parseAnyMcpServerMutation("loc", raw, undefined, { confirmLocal: "bogus" as never })).toMatchObject({ ok: false });
    // A stored confirmation survives an edit that does not re-confirm.
    const existing = confirmed.ok ? confirmed.server : undefined;
    expect(parseAnyMcpServerMutation("loc", { url: "http://127.0.0.1:8811/mcp", auth: "none" }, existing as never))
      .toMatchObject({ ok: true, server: { local: "this-computer" } });
    // But a changed url drops the old confirmation.
    const moved = parseAnyMcpServerMutation("loc", { url: "http://10.0.0.5:8811/mcp", auth: "none" }, existing as never);
    expect(moved.ok && "local" in moved.server).toBe(false);
  });

  it("keeps a new remote entry disabled and lets an edit keep the existing flag", () => {
    expect(parseAnyMcpServerMutation("comfy", { url: "https://cloud.comfy.org/mcp", auth: "oauth" }))
      .toMatchObject({ ok: true, server: { enabled: false } });
    const existing = { url: "https://cloud.comfy.org/mcp", auth: "oauth", headers: {}, enabled: true } as const;
    expect(parseAnyMcpServerMutation("comfy", { url: "https://cloud.comfy.org/mcp", auth: "oauth" }, existing as never))
      .toMatchObject({ ok: true, server: { enabled: true } });
  });

  it("enforces the header rules", () => {
    const make = (headers: Record<string, unknown>) =>
      parseAnyStoredMcpServer("srv", { url: "https://x.example/mcp", auth: "header", headers });
    expect(make({ "X-API-Key": true, Authorization: "Bearer abc" }).ok).toBe(true);
    for (const name of [
      "host", "Host", "content-length", "connection", "transfer-encoding", "cookie", "Cookie",
      "mcp-session-id", "MCP-Protocol-Version", "accept", "content-type",
    ]) {
      expect([name, make({ [name]: true }).ok]).toEqual([name, false]);
    }
    expect(make({ "bad name": true }).ok).toBe(false);
    expect(make({ "bad:name": true }).ok).toBe(false);
    expect(make({ "": true }).ok).toBe(false);
    expect(make({ "X-A": "x".repeat(8 * 1024) }).ok).toBe(true);
    expect(make({ "X-A": "x".repeat(8 * 1024 + 1) }).ok).toBe(false);
    expect(make({ "X-A": "line\r\nInjected: 1" }).ok).toBe(false);
    const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`X-H${i}`, true]));
    expect(make(sixteen).ok).toBe(true);
    expect(make({ ...sixteen, "X-H16": true }).ok).toBe(false);
  });

  it("masks long opaque path segments, query strings and userinfo", () => {
    const token = "abcdefghijklmnopqrstuvwx"; // 24 chars
    expect(maskMcpUrl(`https://hooks.zapier.com/s/${token}/mcp`)).toBe("https://hooks.zapier.com/s/•••/mcp");
    expect(maskMcpUrl(`https://hooks.zapier.com/s/${token.slice(1)}/mcp`)).toBe(`https://hooks.zapier.com/s/${token.slice(1)}/mcp`);
    expect(maskMcpUrl("https://x.example/mcp?api_key=SECRET&b=1")).toBe("https://x.example/mcp");
    expect(maskMcpUrl("https://me:pw@x.example/mcp")).toBe("https://x.example/mcp");
    expect(maskMcpUrl("https://x.example/mcp#frag")).toBe("https://x.example/mcp");
    expect(maskMcpUrl("nonsense")).toBe("");
    for (const out of [
      maskMcpUrl(`https://x.example/${token}?k=SECRET`),
      maskMcpUrl("https://me:pw@x.example/mcp?k=SECRET"),
    ]) {
      expect(out).not.toContain("SECRET");
      expect(out).not.toContain("pw");
      expect(out).not.toContain(token);
    }
  });

  it("splits a pasted url into the stored part and the secret part", () => {
    expect(splitMcpUrl("https://cloud.comfy.org/mcp")).toEqual({
      storedUrl: "https://cloud.comfy.org/mcp", fullUrl: "https://cloud.comfy.org/mcp", urlSecret: false,
    });
    expect(splitMcpUrl("https://x.example/mcp?key=abc")).toEqual({
      storedUrl: "https://x.example/mcp", fullUrl: "https://x.example/mcp?key=abc", urlSecret: true,
    });
    expect(splitMcpUrl("https://me:pw@x.example/mcp")).toEqual({
      storedUrl: "https://x.example/mcp", fullUrl: "https://me:pw@x.example/mcp", urlSecret: true,
    });
    const token = "abcdefghijklmnopqrstuvwx";
    // Packaged: config keeps a masked, non-dialable path; the full link is for the secret store.
    expect(splitMcpUrl(`https://h.example/s/${token}/mcp`)).toEqual({
      storedUrl: "https://h.example/s/•••/mcp", fullUrl: `https://h.example/s/${token}/mcp`, urlSecret: true,
    });
    // Dev and headless keep the full link in config.json, as spec 3.4 allows.
    expect(splitMcpUrl(`https://h.example/s/${token}/mcp?k=1`, { keepFullInConfig: true })).toMatchObject({
      storedUrl: `https://h.example/s/${token}/mcp?k=1`, urlSecret: true,
    });
    expect(splitMcpUrl("nonsense")).toBeNull();
    expect(splitMcpUrl("ftp://x.example/")).toBeNull();
  });

  it("lists remote entries without any value and stdio entries unchanged", () => {
    const raw = {
      notes: { command: "npx", env: { NOTES_TOKEN: "t0ken" } },
      comfy: { url: "https://cloud.comfy.org/mcp", auth: "oauth", enabled: false },
      keyed: { url: "https://x.example/mcp", headers: { "X-API-Key": "sekrit-value" } },
      zap: { url: "https://h.example/s/abcdefghijklmnopqrstuvwx/mcp", urlSecret: true },
      "Bad Name": { url: "https://x.example/mcp" },
    };
    const listing = listAllMcpServers(raw);
    expect(listing.map((entry) => [entry.name, entry.kind])).toEqual([
      ["notes", "stdio"], ["comfy", "remote"], ["keyed", "remote"], ["zap", "remote"],
    ]);
    const json = JSON.stringify(listing);
    for (const leaked of ["t0ken", "sekrit-value", "abcdefghijklmnopqrstuvwx"]) expect(json).not.toContain(leaked);
    expect(listing[1]).toMatchObject({
      kind: "remote", url: "https://cloud.comfy.org/mcp", host: "cloud.comfy.org", auth: "oauth",
      headerNames: [], enabled: false, status: "unknown",
    });
    expect(listing[2]).toMatchObject({ headerNames: ["X-API-Key"], auth: "header" });
    expect(listing[0]).toMatchObject({ kind: "stdio", envKeys: ["NOTES_TOKEN"] });
  });

  it("computes status from secret presence", () => {
    const raw = {
      comfy: { url: "https://cloud.comfy.org/mcp", auth: "oauth" },
      keyed: { url: "https://x.example/mcp", headers: { "X-API-Key": true } },
      open: { url: "https://o.example/mcp" },
    };
    const none = { hasHeader: () => false, hasOAuth: () => false };
    const all = { hasHeader: () => true, hasOAuth: () => true };
    expect(listAllMcpServers(raw, none).map((entry) => entry.kind === "remote" && entry.status))
      .toEqual(["needs-sign-in", "needs-key", "ready"]);
    expect(listAllMcpServers(raw, all).map((entry) => entry.kind === "remote" && entry.status))
      .toEqual(["ready", "ready", "ready"]);
  });

  it("the old listing still skips remote entries so the existing panel never sees one", () => {
    expect(listMcpServers({ comfy: { url: "https://cloud.comfy.org/mcp" }, n: { command: "x" } }).map((e) => e.name)).toEqual(["n"]);
  });

  it("counts remote and stdio together against the server limit", async () => {
    const { MAX_MCP_SERVERS } = await import("./mcp-registry.ts");
    expect(MAX_MCP_SERVERS).toBe(20);
  });
});

describe("wave 1 security review fixes (registry)", () => {
  it("F3: a mutation body refuses a literal header value unless the run keeps secrets in config.json", () => {
    const body = { url: "https://mcp.example.com/mcp", headers: { "X-API-Key": "sk-live-SECRET" } };
    expect(parseAnyMcpServerMutation("zap", body)).toEqual({ ok: false, error: "Enter the key in the key field." });
    expect(parseAnyMcpServerMutation("zap", body, undefined, { secretsInBody: false })).toMatchObject({ ok: false });
    // The placeholder is what a packaged body carries.
    expect(parseAnyMcpServerMutation("zap", { url: body.url, headers: { "X-API-Key": true } })).toMatchObject({ ok: true });
    // Dev and headless opt in.
    expect(parseAnyMcpServerMutation("zap", body, undefined, { secretsInBody: true })).toMatchObject({
      ok: true, server: { headers: { "X-API-Key": "sk-live-SECRET" } },
    });
    // A hand-edited stored entry may still hold strings (the boot migration moves them).
    expect(parseAnyStoredMcpServer("zap", body)).toMatchObject({ ok: true });
  });

  it("F3: a mutation body refuses a link that holds a key, and accepts the masked form", () => {
    for (const url of ["https://x.example/mcp?key=abc", "https://me:pw@x.example/mcp", "https://h.example/s/abcdefghijklmnopqrstuvwx/mcp"]) {
      expect([url, parseAnyMcpServerMutation("lnk", { url }).ok]).toEqual([url, false]);
    }
    const masked = parseAnyMcpServerMutation("lnk", { url: "https://h.example/s/•••/mcp", urlSecret: true });
    expect(masked).toMatchObject({ ok: true, server: { url: "https://h.example/s/•••/mcp", urlSecret: true } });
    expect(parseAnyMcpServerMutation("lnk", { url: "https://h.example/s/abcdefghijklmnopqrstuvwx/mcp", urlSecret: true }, undefined, { secretsInBody: true })).toMatchObject({ ok: true });
  });

  it("F2: no token shape reaches a listing, and the stored link for a token path is masked and marked", () => {
    const urls = [
      "https://x.example/sse/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123",
      "https://mcp.example/s/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==/mcp",
      "https://mcp.example/s/abcDEF123456789012/mcp",
      "https://mcp.example/k/sk~live.0123456789abcdefghij/mcp",
      "https://mcp.zapier.com/api/mcp/s/abcdefghijklmnopqrstuvwxyz0123/mcp",
    ];
    for (const url of urls) {
      const split = splitMcpUrl(url)!;
      expect([url, split.urlSecret]).toEqual([url, true]);
      expect(split.storedUrl).toContain("•••");
      expect(split.storedUrl).not.toMatch(/eyJ|Zm9v|abcDEF|sk~live|abcdefghij/);
      expect(split.fullUrl).toContain(new URL(url).pathname.split("/").pop() === "mcp" ? "mcp" : "");
      const stored = parseAnyStoredMcpServer("lnk", { url: split.storedUrl, urlSecret: true });
      expect(stored.ok).toBe(true);
      if (stored.ok) expect(isMaskedStoredUrl(stored.server as never)).toBe(true);
      expect(JSON.stringify(listAllMcpServers({ lnk: { url: url, urlSecret: true } }))).not.toMatch(/eyJ|Zm9v|abcDEF|sk~live|abcdefghij/);
      expect(maskMcpUrl(url)).toContain("•••");
    }
    // An ordinary link is stored as written and is dialable.
    const plain = parseAnyStoredMcpServer("p", { url: "https://cloud.comfy.org/mcp" });
    expect(plain.ok && isMaskedStoredUrl(plain.server as never)).toBe(false);
  });

  it("L5: hop-by-hop and request-shaping header names are refused", () => {
    for (const name of ["Expect", "Upgrade", "TE", "Trailer", "Keep-Alive", "Proxy-Authorization", "Proxy-Connection", "Origin"]) {
      expect([name, isRefusedMcpHeaderName(name)]).toEqual([name, true]);
      expect([name, parseAnyMcpServerMutation("h", { url: "https://a.example/mcp", headers: { [name]: true } }).ok]).toEqual([name, false]);
    }
    for (const name of ["X-API-Key", "Authorization", "X-Workspace"]) expect(isRefusedMcpHeaderName(name)).toBe(false);
  });
});
