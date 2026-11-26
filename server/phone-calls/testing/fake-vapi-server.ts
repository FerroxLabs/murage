// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Owners: C0 provides the loopback vendor. F1–F6 and J use it in their fixtures.
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { PHONE_KEY_ORIGIN } from "../phone-secrets.ts";
import { CREATE_CALL_RESPONSE, PINNED } from "../fixtures/vapi-pinned.ts";
import type { FetchLike } from "../vapi-adapter.ts";

type FakeCall = Record<string, unknown> & { id: string; createdAt: string; status: string };
type FakeRequest = { method: string; path: string; query: URLSearchParams };
interface FakeVapiOptions {
  now?: () => number;
  numbers?: readonly unknown[];
  orderCalls?: (calls: FakeCall[]) => FakeCall[];
  beforeBody?: (request: FakeRequest) => number | void | Promise<number | void>;
  beforeReply?: (request: FakeRequest) => void | Promise<void>;
}

export async function startFakeVapi(options: FakeVapiOptions = {}) {
  const requests: (FakeRequest & { body?: Record<string, unknown> })[] = [];
  const calls = new Map<string, FakeCall>();
  const assistants = new Map<string, Record<string, unknown>>();
  let creates = 0;
  let assistantSequence = 0;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const entry = { method: req.method ?? "", path: url.pathname, query: url.searchParams };
    const reply = async (status: number, body: unknown) => {
      await options.beforeReply?.(entry);
      if (!res.destroyed) res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    const failure = await options.beforeBody?.(entry);
    if (failure !== undefined) {
      requests.push(entry);
      return reply(failure, {});
    }
    if (req.destroyed) return;
    let body: Record<string, unknown> | undefined;
    if (entry.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reply(400, {});
      body = parsed as Record<string, unknown>;
    }
    requests.push({ ...entry, body });
    if (entry.path === "/phone-number" && entry.method === "GET") {
      return reply(200, options.numbers ?? [{ id: "number-1", number: "+12025550100" }]);
    }
    if (entry.path === "/assistant" && entry.method === "POST" && body) {
      const id = `assistant-${++assistantSequence}`;
      assistants.set(id, body);
      return reply(201, { id });
    }
    const assistant = entry.path.match(/^\/assistant\/([\w-]+)$/);
    if (assistant && entry.method === "DELETE") return reply(assistants.delete(assistant[1]!) ? 200 : 404, {});
    if (entry.path === "/call" && entry.method === "POST" && body) {
      const id = `fixture-call-${++creates}`;
      const call = { ...CREATE_CALL_RESPONSE, id, name: body.name, createdAt: new Date((options.now ?? Date.now)()).toISOString(),
        status: body.schedulePlan ? "scheduled" : "queued" };
      calls.set(id, call);
      return reply(201, call);
    }
    if (entry.path === "/call" && entry.method === "GET") {
      const keys = [...entry.query.keys()];
      const { limit: defaultLimit, maxLimit, filters } = PINNED.callList;
      if (new Set(keys).size !== keys.length || keys.some(key => !(filters as readonly string[]).includes(key))) return reply(400, {});
      const rawLimit = entry.query.get("limit");
      const limit = rawLimit === null ? defaultLimit : /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
      const from = entry.query.has("createdAtGe") ? Date.parse(entry.query.get("createdAtGe")!) : -Infinity;
      const to = entry.query.has("createdAtLe") ? Date.parse(entry.query.get("createdAtLe")!) : Infinity;
      if (!Number.isInteger(limit) || limit < 0 || limit > maxLimit || !(from <= to)) return reply(400, {});
      const matching = [...calls.values()].filter(call => {
        const time = Date.parse(call.createdAt);
        return from <= time && time <= to;
      });
      return reply(200, (options.orderCalls?.(matching) ?? matching).slice(0, limit));
    }
    const found = entry.path.match(/^\/call\/([\w-]+)$/);
    const call = found && calls.get(found[1]!);
    if (call && entry.method === "GET") return reply(200, call);
    if (call && entry.method === "DELETE") {
      if (call.status === "ended") return reply(409, {});
      calls.set(call.id, { ...call, status: "ended", endedReason: PINNED.rest.cancelEndedReason });
      return reply(200, {});
    }
    return reply(404, {});
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) res.writeHead(400).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject).listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback TCP address");
  const origin = `http://127.0.0.1:${address.port}`;

  const fetchImpl: FetchLike = async (target, init) => {
    const upstream = new URL(target);
    if (upstream.origin !== PHONE_KEY_ORIGIN) throw new Error("Unexpected vendor origin");
    return new Promise((resolve, reject) => {
      const outgoing = request({
        hostname: "127.0.0.1", port: address.port, path: upstream.pathname + upstream.search,
        method: init.method, headers: init.headers, agent: false,
      }, response => {
        const chunks: Buffer[] = [];
        response.once("error", reject);
        response.on("data", chunk => chunks.push(chunk));
        response.once("end", () => resolve({ status: response.statusCode!, json: async () => JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      outgoing.once("error", reject);
      outgoing.end(init.body);
    });
  };
  return {
    origin, fetchImpl, requests, calls, assistants,
    get creates() { return creates; },
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
