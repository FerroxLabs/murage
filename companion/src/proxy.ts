// The forwarding half of the sidecar.
//
// A device's request arrives here, is checked against the allowlist, and is
// replayed to the harness on 127.0.0.1 as a request from this machine. The
// response comes back scrubbed.
//
// The reason this works with an unmodified harness is worth stating plainly,
// because it is the whole basis of the design: the harness rejects any
// request whose Host is not loopback — a DNS-rebinding defence — and a
// request this process makes to 127.0.0.1 satisfies that by construction. So
// the sidecar does NOT forward the device's Host or Origin. It speaks to the
// harness as itself, from the machine the harness is already willing to
// serve. Nothing upstream has to change, or even know this exists.
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

import { bearerToken } from "./devices.ts";
import { denyReason } from "./routes.ts";
import { createSseScrubber, isJson, scrub } from "./wire.ts";

/** How long a non-streaming harness call may take before we give up on it.
 * Generous: some harness routes probe local CLIs, which is slow but real
 * work. Short enough that a phone gets an answer rather than a spinner. */
const UPSTREAM_TIMEOUT_MS = 30_000;

/** Distinguishes "the harness never answered" from "there was nothing to
 * answer" at the point where the only thing left is an error object. */
class UpstreamTimeout extends Error {
  constructor() {
    super("upstream timed out");
    this.name = "UpstreamTimeout";
  }
}

export interface ProxyOptions {
  /** Where the harness is listening on loopback. */
  harnessPort: number;
  /** Does this bearer token belong to a paired device? */
  authenticate: (token: string | null) => boolean;
  /** Redeem a pairing code. Handled here and never forwarded: the harness
   * has no such route and no idea devices exist — pairing is the sidecar's
   * own concern, and the one thing a device does before it has a token. */
  redeem: (
    code: string,
    deviceName: unknown,
  ) => { token: string; device: unknown } | { error: string };
  /** What the phone should call this computer in its connection list. */
  serverName: () => string;
}

/** Read a JSON body, bounded. An unbounded read on an unauthenticated route
 * is a way to be memory-exhausted by anyone who can reach the port. */
const readJson = (req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        const parsed: unknown = JSON.parse(text);
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
  });

/** One parser, shared with the registry that checks what it returns. Two of
 * them is how a header authenticates on one code path and not the other. */
const bearer = (header: string | undefined): string | null => bearerToken(header) ?? null;

/**
 * Answer with JSON, unless the response has already begun.
 *
 * Once a byte is on the wire the status line is spent, and writeHead throws
 * ERR_HTTP_HEADERS_SENT. That matters most on the failure paths: an upstream
 * that dies mid-stream fires `error` long after the SSE headers were flushed,
 * and turning that into a second, fatal error inside an error handler would
 * take the whole sidecar down. Destroying the socket is the only honest
 * ending available at that point — the device sees a truncated response and
 * reconnects, which is what it already does for a dropped connection.
 */
const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
};

/** Headers worth carrying to the harness. An allowlist rather than a
 * blocklist: `host` and `origin` must not travel (see above), `authorization`
 * is the sidecar's credential and means nothing to the harness, and hop-by-hop
 * headers are by definition not ours to relay. */
const forwardHeaders = (req: IncomingMessage): Record<string, string> => {
  const out: Record<string, string> = { accept: String(req.headers.accept ?? "*/*") };
  const contentType = req.headers["content-type"];
  if (contentType) out["content-type"] = String(contentType);
  // Last-Event-ID is how a reconnecting client asks for the gap. Dropping it
  // would turn every resume into a full re-hydration, silently.
  const lastEventId = req.headers["last-event-id"];
  if (lastEventId) out["last-event-id"] = String(lastEventId);
  return out;
};

/** The request handler a paired device talks to.
 *
 * Checks the allowlist, answers pairing itself, and replays everything else
 * to the harness on loopback as a request from this machine — which is what
 * satisfies the harness's Host check without the harness knowing this exists. */
export function createProxyHandler(options: ProxyOptions) {
  return function handle(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? "/").split("?")[0];
    const method = req.method ?? "GET";

    // A native app sends no Origin. Anything that does is a browser that has
    // found this port, and a browser has no business on it — refused before
    // the token is even looked at, and regardless of what the origin says.
    if (req.headers.origin) {
      return sendJson(res, 403, { error: "forbidden: cross-origin request" });
    }

    const denial = denyReason({
      path,
      method,
      authenticated: options.authenticate(bearer(req.headers.authorization)),
    });
    if (denial) return sendJson(res, denial.status, { error: denial.error });

    // Pairing terminates here. Forwarding it would hand the harness a route
    // it does not have, and the 404 would read to a phone as "wrong address".
    if (method === "POST" && path === "/api/pair") {
      readJson(req).then(
        (body) => {
          const result = options.redeem(String(body.code ?? ""), body.deviceName);
          if ("error" in result) return sendJson(res, 401, { error: result.error });
          return sendJson(res, 201, { ...result, serverName: options.serverName() });
        },
        (error: Error) => sendJson(res, 400, { error: error.message }),
      );
      return;
    }

    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: options.harnessPort,
        path: req.url,
        method,
        headers: forwardHeaders(req),
      },
      (harness) => {
        const contentType = harness.headers["content-type"];
        const isStream = String(contentType ?? "").includes("text/event-stream");

        if (isStream) {
          // An idle SSE connection is a healthy one, so the inactivity
          // deadline set below must not apply to it.
          upstream.setTimeout(0);

          // Headers first and flushed, or nothing downstream believes the
          // connection is live. content-length is meaningless here and
          // content-encoding would be a lie once we rewrite the bytes.
          res.writeHead(harness.statusCode ?? 200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            // Nagle would hold a small frame back waiting for company. On a
            // stream whose frames are small and whose whole value is being
            // timely, that is exactly wrong.
            "x-accel-buffering": "no",
          });
          res.flushHeaders?.();
          res.socket?.setNoDelay(true);

          const scrubStream = createSseScrubber();
          harness.setEncoding("utf8");
          harness.on("data", (chunk: string) => {
            const rewritten = scrubStream(chunk);
            if (!rewritten) return;
            // res.write() returning false means the kernel buffer for the
            // device's socket is full. Ignoring it is how a phone that has
            // walked out of wifi — connected, not reading — turns into
            // unbounded memory here: the harness keeps producing, and every
            // unwritten frame stays queued in this process. Pause the
            // upstream until the device catches up, which lets the
            // backpressure reach the harness instead of stopping at us.
            if (!res.write(rewritten)) {
              harness.pause();
              res.once("drain", () => harness.resume());
            }
          });
          harness.on("end", () => res.end());
          harness.on("error", () => res.destroy());
          // A device that hangs up must take the upstream connection with
          // it, or the harness accumulates readers nobody is listening to.
          res.on("close", () => harness.destroy());
          return;
        }

        if (!isJson(String(contentType ?? ""))) {
          // images and anything else: byte-for-byte, no parsing
          res.writeHead(harness.statusCode ?? 200, harness.headers);
          harness.pipe(res);
          return;
        }

        const chunks: Buffer[] = [];
        harness.on("data", (chunk: Buffer) => chunks.push(chunk));
        harness.on("error", () => res.destroy());
        harness.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");

          // Two failures live here and they are not the same failure.
          //
          // A body that does not parse was never JSON — content-type lied,
          // or the harness sent an empty 204. There is nothing to redact in
          // bytes we cannot read as an object, so forwarding them verbatim
          // is correct.
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = undefined;
          }
          if (parsed === undefined) {
            forward(body, harness.headers, harness.statusCode ?? 200);
            return;
          }

          // A body that parses but will not scrub is the opposite case. We
          // know it is structured, and we know `scrub` is the only thing
          // keeping internal fields — resume cursors — off the wire to a
          // device. Falling back to the raw body there, which is what a
          // single try around parse-and-scrub did, sends exactly what the
          // scrubber exists to withhold.
          //
          // Not hypothetical: `scrub` recurses, so a body nested a few
          // thousand deep throws RangeError while JSON.parse handles it
          // fine. See proxy-response.test.ts.
          let text: string;
          try {
            text = JSON.stringify(scrub(parsed));
          } catch {
            sendJson(res, 502, { error: "the response could not be prepared for this device" });
            return;
          }
          forward(text, harness.headers, harness.statusCode ?? 200);
        });

        /** Re-frame and send. The body was re-serialised, so nothing the
         * harness said about its framing survives. `transfer-encoding`
         * matters most: leaving it alongside the content-length set here is
         * a protocol violation, and Node's own parser rejects the response
         * outright rather than tolerating it. */
        function forward(text: string, upstreamHeaders: IncomingMessage["headers"], status: number): void {
          const headers = { ...upstreamHeaders };
          delete headers["content-length"];
          delete headers["content-encoding"];
          delete headers["transfer-encoding"];
          res.writeHead(status, {
            ...headers,
            "content-length": Buffer.byteLength(text),
          });
          res.end(text);
        }
      },
    );

    // A harness that accepts the connection and then says nothing is not the
    // same as one that is down, and only the second has an error to report.
    // Without a deadline the first holds the device's request open forever —
    // the phone shows a spinner with nothing behind it, and the socket is
    // still pinned on both sides. Streams are exempt: an idle SSE connection
    // is the normal, healthy state of one, and this timer would kill it.
    //
    // Set on the request, so it covers connect and first-byte alike.
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstream.destroy(new UpstreamTimeout());
    });

    // Down and wedged are different things to be told, and only one of them
    // is fixed by starting the app.
    upstream.on("error", (err) =>
      sendJson(res, 502, {
        error:
          err instanceof UpstreamTimeout
            ? "OpenMausBot is not answering on this computer"
            : "OpenMausBot is not running on this computer",
      }),
    );
    req.pipe(upstream);
  };
}
