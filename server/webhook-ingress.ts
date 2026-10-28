import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";

import { parseJson, type JsonValue } from "./schema.ts";
import type { WebhookManager } from "./webhooks.ts";

export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const statusErrorSchema = z.object({ status: z.number().int().optional() });
const serverAddressSchema = z.object({ port: z.number().int().min(1).max(65_535) });

export interface WebhookIngress {
  server: Server;
  host: string;
  port: number;
  baseUrl: string;
}

function json(res: ServerResponse, status: number, body: JsonValue): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_WEBHOOK_BODY_BYTES) {
        throw Object.assign(new Error("Webhook body is too large"), { status: 413 });
      }
      chunks.push(buffer);
    }
  } catch (error) {
    const parsed = statusErrorSchema.safeParse(error);
    if (parsed.success && parsed.data.status === 413) throw error;
    throw Object.assign(new Error("Could not read webhook body"), { status: 400 });
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function parsePayload(raw: string, contentType: string): JsonValue {
  if (!raw) return {};
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    try {
      return parseJson(raw);
    } catch {
      throw Object.assign(new Error("Invalid JSON webhook body"), { status: 400 });
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return raw;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function bearerSecret(req: IncomingMessage): string {
  const authorization = header(req, "authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || header(req, "x-murage-secret")?.trim() || "";
}

function deliveryId(req: IncomingMessage): string | undefined {
  return (
    header(req, "idempotency-key") ??
    header(req, "x-webhook-id") ??
    header(req, "x-github-delivery") ??
    header(req, "webhook-id")
  )?.trim() || undefined;
}

function eventName(req: IncomingMessage): string | undefined {
  return (
    header(req, "x-github-event") ??
    header(req, "x-webhook-event") ??
    header(req, "x-event-type") ??
    header(req, "ce-type")
  )?.trim() || undefined;
}

/** What the server log keeps of a failure nobody planned for: its kind and
 *  code, never its message, which can carry payload or path text. */
function failureLabel(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? `${error.name} ${code}` : error.name;
}

/** The answer for a failure nobody planned for. Its own words stay on the server. */
function receiverFailed(res: ServerResponse, error: unknown): void {
  console.error(`webhooks: receiver failed (${failureLabel(error)})`);
  if (res.headersSent) res.destroy();
  else json(res, 500, { error: "Webhook receiver failed" });
}

export function createWebhookIngressHandler(manager: WebhookManager) {
  const handle = createWebhookRequestHandler(manager);
  // THE LAST-RESORT CATCH. The handler is async and node's HTTP server never
  // looks at the promise it returns, so anything thrown outside its own
  // try (the rejection log in its catch, a write after the client left)
  // was an unhandled rejection. It now ends as a 500 for this request only.
  return (req: IncomingMessage, res: ServerResponse): Promise<void> =>
    handle(req, res).catch((error: unknown) => {
      try { receiverFailed(res, error); } catch { res.destroy(); }
    });
}

function createWebhookRequestHandler(manager: WebhookManager) {
  const home = process.env.MURAGE_CLOUD_ROLE === "home";
  const buckets = new Map<string, { at: number; count: number }>();
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return json(res, 400, { error: "Invalid request target" });
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { app: "murage-webhooks", ready: true });
    }
    const match = url.pathname.match(/^\/hooks\/(wh_[A-Za-z0-9_-]+)(?:\/([^/]+))?$/);
    if (!match) return json(res, 404, { error: "Unknown webhook endpoint" });
    if (req.method !== "POST") return json(res, 405, { error: "Webhooks accept POST requests" });

    try {
      let secret = "";
      try {
        secret = (match[2] ? decodeURIComponent(match[2]) : "") || bearerSecret(req);
      } catch {
        // A malformed escape is not a secret this server issued.
      }
      // Reject bad capability URLs before buffering or parsing attacker input.
      if (!manager.authorize(match[1], secret)) {
        manager.recordUnauthorized(match[1], {
          contentType: header(req, "content-type"),
          eventName: eventName(req),
          deliveryId: deliveryId(req),
        });
        return json(res, 401, { error: "Invalid webhook URL or secret" });
      }
      if (home) {
        const now = Date.now();
        for (const [id, bucket] of buckets) if (now - bucket.at >= 60_000) buckets.delete(id);
        const bucket = buckets.get(match[1]) ?? { at: now, count: 0 };
        if (bucket.count >= 60) { res.setHeader("retry-after", String(Math.ceil((60_000 - (now - bucket.at)) / 1000))); return json(res, 429, { error: "Webhook request limit reached. Try again in a minute." }); }
        bucket.count += 1; buckets.set(match[1], bucket);
      }
      const raw = await readRawBody(req);
      const contentType = header(req, "content-type")?.split(";")[0]?.trim().toLowerCase() ?? "text/plain";
      const payload = parsePayload(raw, contentType);
      const result = manager.receive(match[1], secret, {
        payload,
        contentType,
        eventName: eventName(req),
        userAgent: header(req, "user-agent"),
        deliveryId: deliveryId(req),
      });
      return json(res, 202, { accepted: true, ...result });
    } catch (error) {
      const parsedError = statusErrorSchema.safeParse(error);
      const status = parsedError.success ? parsedError.data.status ?? 500 : 500;
      // A status-carrying error is one of ours, worded for the sender. Any
      // other failure answers with fixed words; its own stay on the server.
      if (status >= 500) return receiverFailed(res, error);
      const message = error instanceof Error ? error.message : String(error);
      // Manager-level validation records its own rejection with the parsed
      // payload. Receiver-level failures happen earlier, so record metadata
      // here without buffering untrusted data a second time.
      if (status === 400 || status === 413) {
        manager.recordRejected(match[1], status, message, {
          contentType: header(req, "content-type"),
          eventName: eventName(req),
          deliveryId: deliveryId(req),
        });
      }
      return json(res, status, { error: message });
    }
  };
}

export async function listenWebhookIngress(
  manager: WebhookManager,
  options: { host?: string; port: number },
): Promise<WebhookIngress> {
  const host = options.host ?? "127.0.0.1";
  const server = createServer(createWebhookIngressHandler(manager));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = serverAddressSchema.safeParse(server.address());
  if (!address.success) {
    server.close();
    throw new Error("Webhook receiver did not get a TCP address");
  }
  return { server, host, port: address.data.port, baseUrl: `http://${host}:${address.data.port}` };
}

export function webhookCredential(baseUrl: string, endpointId: string, secret: string) {
  const endpointUrl = `${baseUrl.replace(/\/$/, "")}/hooks/${endpointId}`;
  return {
    endpointUrl,
    secret,
    url: `${endpointUrl}/${encodeURIComponent(secret)}`,
  };
}
