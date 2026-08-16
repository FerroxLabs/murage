import { createServer } from "node:http";
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
function json(res, status, body) {
    res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify(body));
}
function readRawBody(req) {
    return new Promise((resolve, reject) => {
        let raw = "";
        let bytes = 0;
        let done = false;
        const fail = (status, message) => {
            if (done)
                return;
            done = true;
            reject(Object.assign(new Error(message), { status }));
        };
        req.on("data", (chunk) => {
            if (done)
                return;
            bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
            if (bytes > MAX_WEBHOOK_BODY_BYTES)
                return fail(413, "Webhook body is too large");
            raw += chunk;
        });
        req.on("end", () => {
            if (done)
                return;
            done = true;
            resolve(raw);
        });
        req.on("error", () => fail(400, "Could not read webhook body"));
    });
}
function parsePayload(raw, contentType) {
    if (!raw)
        return {};
    if (contentType.includes("application/json") || contentType.includes("+json")) {
        try {
            return JSON.parse(raw);
        }
        catch {
            throw Object.assign(new Error("Invalid JSON webhook body"), { status: 400 });
        }
    }
    if (contentType.includes("application/x-www-form-urlencoded")) {
        return Object.fromEntries(new URLSearchParams(raw));
    }
    return raw;
}
function header(req, name) {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
}
function bearerSecret(req) {
    const authorization = header(req, "authorization") ?? "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || header(req, "x-openmaus-secret")?.trim() || "";
}
function deliveryId(req) {
    return (header(req, "idempotency-key") ??
        header(req, "x-webhook-id") ??
        header(req, "x-github-delivery") ??
        header(req, "webhook-id"))?.trim() || undefined;
}
function eventName(req) {
    return (header(req, "x-github-event") ??
        header(req, "x-webhook-event") ??
        header(req, "x-event-type") ??
        header(req, "ce-type"))?.trim() || undefined;
}
export function createWebhookIngressHandler(manager) {
    return async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "GET" && url.pathname === "/health") {
            return json(res, 200, { app: "openmausbot-webhooks", ready: true });
        }
        const match = url.pathname.match(/^\/hooks\/(wh_[A-Za-z0-9_-]+)(?:\/([^/]+))?$/);
        if (!match)
            return json(res, 404, { error: "Unknown webhook endpoint" });
        if (req.method !== "POST")
            return json(res, 405, { error: "Webhooks accept POST requests" });
        try {
            const pathSecret = match[2] ? decodeURIComponent(match[2]) : "";
            const secret = pathSecret || bearerSecret(req);
            // Reject bad capability URLs before buffering or parsing attacker input.
            if (!manager.authorize(match[1], secret)) {
                manager.recordRejected(match[1], 401, "Invalid webhook URL or secret", {
                    contentType: header(req, "content-type"),
                    eventName: eventName(req),
                    deliveryId: deliveryId(req),
                });
                return json(res, 401, { error: "Invalid webhook URL or secret" });
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
        }
        catch (error) {
            const status = Number(error?.status) || 500;
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
export async function listenWebhookIngress(manager, options) {
    const host = options.host ?? "127.0.0.1";
    const server = createServer(createWebhookIngressHandler(manager));
    await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen(options.port, host, () => {
            server.off("error", onError);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        server.close();
        throw new Error("Webhook receiver did not get a TCP address");
    }
    return { server, host, port: address.port, baseUrl: `http://${host}:${address.port}` };
}
export function webhookCredential(baseUrl, endpointId, secret) {
    const endpointUrl = `${baseUrl.replace(/\/$/, "")}/hooks/${endpointId}`;
    return {
        endpointUrl,
        secret,
        url: `${endpointUrl}/${encodeURIComponent(secret)}`,
    };
}
