import { LEDGER_REFUSAL_LINE } from "../ledger-refusal.ts";
const sealedProxyRefusal = { jsonrpc: "2.0", id: null, error: {
  code: -32099, message: LEDGER_REFUSAL_LINE,
  data: { code: "MEMORY_CONTEXT_REVOKED", terminal: true },
} };
// control migration: real bound proxy ingress; existing assertions retained.
import type { ChildProcess } from "node:child_process";
import { boundProxyState, spawnBoundProxy } from "../testing/bound-proxy-fixture.ts";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { turnSecret, turnSecretWired } from "../turn-credential.ts";
import { bindCredentialPath, createTurnCredentialStore, splitTurnSecrets } from "./turn-credentials.ts";

describe("turn credential reader", () => {
  it("reads the named server's section per call and never falls back to env once a file is wired", () => {
    const store = createTurnCredentialStore();
    try {
      const env = { MURAGE_CRED_FILE: store.path, MURAGE_CRED_SERVER: "agents", MURAGE_COMMS_TOKEN: "stale-env" };
      expect(turnSecret("MURAGE_COMMS_TOKEN", env)).toBe("");
      store.write({ agents: { MURAGE_COMMS_TOKEN: "t1" }, other: { MURAGE_COMMS_TOKEN: "x" } });
      expect(turnSecret("MURAGE_COMMS_TOKEN", env)).toBe("t1");
      store.write({ agents: { MURAGE_COMMS_TOKEN: "t2" } });
      expect(turnSecret("MURAGE_COMMS_TOKEN", env)).toBe("t2");
      store.clear();
      expect(turnSecret("MURAGE_COMMS_TOKEN", env)).toBe("");
      expect(turnSecretWired("MURAGE_COMMS_TOKEN", env)).toBe(true);
    } finally { store.dispose(); }
    expect(turnSecret("MURAGE_COMMS_TOKEN", { MURAGE_COMMS_TOKEN: "env-only" })).toBe("env-only");
  });

  it("splits secrets out of every server's env and leaves a stable, secret-free spawn contract", () => {
    const { stableServers, secrets } = splitTurnSecrets({
      agents: { command: "node", args: ["a"], env: { MURAGE_BOT_ID: "b", MURAGE_COMMS_TOKEN: "t" } },
      notes: { command: "npx", args: [], env: { NOTES_TOKEN: "keep" } },
    });
    expect(secrets).toEqual({ agents: { MURAGE_COMMS_TOKEN: "t" } });
    expect(JSON.stringify(stableServers)).not.toContain('"t"');
    expect((stableServers.notes as { env: unknown }).env).toEqual({ NOTES_TOKEN: "keep" });
    const again = splitTurnSecrets({ agents: { command: "node", args: ["a"], env: { MURAGE_BOT_ID: "b", MURAGE_COMMS_TOKEN: "other-turn" } } });
    expect(JSON.stringify(again.stableServers.agents)).toBe(JSON.stringify(stableServers.agents));
    expect((bindCredentialPath(stableServers, "/x/y.json").agents as { env: Record<string, string> }).env.MURAGE_CRED_FILE).toBe("/x/y.json");
  });

  it("creates a 0600 file in a 0700 directory, empties it, and unlinks it on dispose", () => {
    const store = createTurnCredentialStore();
    // Windows has no POSIX mode bits; there the guarantee is the per-user temp directory's inherited ACL.
    const posix = process.platform !== "win32";
    if (posix) {
      expect(statSync(store.path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(store.path)).mode & 0o777).toBe(0o700);
    }
    store.write({ a: { MURAGE_MCP_TOKEN: "t" } });
    if (posix) expect(statSync(store.path).mode & 0o777).toBe(0o600);
    store.clear();
    expect(readFileSync(store.path, "utf8")).toBe("{}");
    store.dispose();
    expect(existsSync(store.path)).toBe(false);
    expect(existsSync(dirname(store.path))).toBe(false);
    store.write({ a: { MURAGE_MCP_TOKEN: "late" } });
    expect(existsSync(store.path)).toBe(false);
  });
});

describe("memory proxy reads its token from the credential file on every call", () => {
  let stub: Server;
  let child: ChildProcess;
  const store = createTurnCredentialStore();
  const auths: Array<string | undefined> = [];
  const pending = new Map<number, (value: any) => void>();
  let nextId = 1;
  const call = (name: string, args: unknown) => new Promise<any>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });

  beforeAll(async () => {
    stub = createServer((req, res) => {
      req.resume();
      req.on("end", () => { auths.push(req.headers.authorization); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ hits: [] })); });
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const address = stub.address() as { port: number };
    child = await spawnBoundProxy("memory", process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./memory-proxy.ts", import.meta.url))], {
      env: { ...process.env, MURAGE_HARNESS_URL: `http://127.0.0.1:${address.port}`, MURAGE_CRED_FILE: store.path, MURAGE_CRED_SERVER: "murage-memory", MURAGE_MEMORY_TOKEN: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffered = "";
    child.stdout!.on("data", (chunk) => {
      buffered += chunk.toString();
      let end: number;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        pending.get(message.id)?.(message); pending.delete(message.id);
      }
    });
  });
  afterAll(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.stdin!.end();
      await exited;
    }
    await new Promise((resolve) => stub.close(resolve));
    store.dispose();
  });

  it("sends turn N's token, then N+1's, and nothing once the file is emptied", async () => {
    store.write({ "murage-memory": { MURAGE_MEMORY_TOKEN: "turn-1" } });
    await call("memory_search", { query: "a" });
    store.write({ "murage-memory": { MURAGE_MEMORY_TOKEN: "turn-2" } });
    await call("memory_search", { query: "b" });
    expect(auths).toEqual(["Bearer turn-1", "Bearer turn-2"]);
    store.clear();
    // red-at-4df086541; design line 399: missing authority seals the lease
    // instead of returning the old recoverable "not available" tool answer.
    const accepted: string[] = [];
    child.stdout!.on("data", chunk => accepted.push(chunk.toString()));
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    const replied = new Promise<void>(resolve => child.stdout!.once("data", () => resolve()));
    await Promise.race([closed, call("memory_search", { query: "c" }), replied]);
    expect(auths).toHaveLength(2);
    expect(accepted).toEqual([]);
    // MAIN RULING INT-CONFLICT-DEFAULT 0058cec1be9 / 6a9dfe7db86: also require the authenticated fixed terminal receipt.
    expect(boundProxyState(child)).toEqual({ sealed: true, refusals: 1, terminal: sealedProxyRefusal });
    writeFileSync(store.path, "{}");
  });
});
