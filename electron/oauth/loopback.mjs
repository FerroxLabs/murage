// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one-shot loopback listener a browser sign-in returns to (RFC 8252 7.3),
// shared by plan sign-in (model-signin.mjs) and MCP server sign-in
// (mcp-signin/flow.mjs).
//
// Rules, each tested in electron/oauth-loopback.node-test.mjs:
//  - binds 127.0.0.1 only, never the localhost name or every interface;
//  - answers one path; anything else is 404 and the flow keeps waiting;
//  - only a request carrying this flow's `state` can end it (anything else is a
//    web page poking the port: 400, keep waiting);
//  - one-shot: the first matching answer ends the flow and the listener closes;
//  - closes on success, on an error answer, on timeout, on cancel and when the
//    browser cannot be opened;
//  - the page it shows carries no code, state or token.

export const LOOPBACK_HOST = "127.0.0.1";

export function callbackPage(ok) {
  const heading = ok ? "You're signed in" : "Sign-in did not finish";
  const body = ok ? "You can close this tab and go back to Murage." : "Go back to Murage and try again.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${heading}</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#111;color:#eee;font-family:system-ui,sans-serif;padding:24px}h1{font-size:18px;margin:0}p{margin-top:10px;font-size:14px;color:#aaa}</style></head><body><div><h1>${heading}</h1><p>${body}</p></div></body></html>`;
}

function listen(server, port) {
  return new Promise((resolve) => {
    const onError = () => { server.removeListener("error", onError); resolve(false); };
    server.once("error", onError);
    server.listen(port, LOOPBACK_HOST, () => { server.removeListener("error", onError); resolve(true); });
  });
}

/**
 * Listen, open the browser, wait for the one answer.
 *
 * @param {object} options
 * @param {() => import("node:http").Server} options.createServer
 * @param {string} options.path  the only path answered, e.g. "/callback"
 * @param {number[]} [options.ports]  tried in order; 0 means any free port
 * @param {string} options.state  the state this flow sent
 * @param {number} options.timeoutMs
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimeout]
 * @param {(timer: unknown) => void} [options.clearTimeout]
 * @param {(params: URLSearchParams) => boolean} [options.accept]  an extra check on an
 *   answer whose state matched (the RFC 9207 `iss`); false ends the flow as "rejected"
 * @param {(controls: { finish: (outcome: object) => void }) => void} [options.register]
 *   receives the flow's finish function at once, for cancel and a pasted code
 * @param {() => void} [options.onSettled]  called synchronously the moment the flow ends, before the listener closes
 * @param {(port: number) => Promise<void>} options.onListening  open the browser; a throw ends the flow as "browser"
 * @returns {Promise<{ code: string, params: URLSearchParams, port: number } | { error: string, port: number, providerError?: string }>}
 */
export function runLoopback(options) {
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const ports = options.ports?.length ? options.ports : [0];
  return new Promise((resolve) => {
    const server = options.createServer();
    let settled = false, timer = null, port = 0;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      options.onSettled?.();
      if (timer) clearTimer(timer);
      try { server.close(); } catch { /* never listened */ }
      // A kept-alive socket from the browser must not outlive the flow: the
      // next sign-in may listen on the same port, and a stale socket would
      // carry its callback to this closed listener.
      try { server.closeIdleConnections?.(); } catch { /* not a node:http server */ }
      resolve({ ...outcome, port });
    };
    options.register?.({ finish });
    server.on("request", (req, res) => {
      // One-shot: a request that arrives on a kept-alive socket after the
      // flow ended is not served.
      if (settled) { res.writeHead(404, { connection: "close" }).end(); return; }
      let url;
      try { url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`); } catch { res.writeHead(400, { connection: "close" }).end(); return; }
      if (url.pathname !== options.path) { res.writeHead(404, { connection: "close" }).end(); return; }
      const code = url.searchParams.get("code") ?? "", state = url.searchParams.get("state") ?? "";
      const page = (ok, status = 200) => res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close" }).end(callbackPage(ok));
      // Only the browser that carries this flow's state can end it. Any
      // other request (a web page poking the port) is refused and the flow
      // keeps waiting.
      if (state !== options.state) { page(false, 400); return; }
      const providerError = url.searchParams.get("error");
      if (providerError || !code) {
        page(false);
        finish({ error: "cancelled", ...(providerError ? { providerError: providerError.slice(0, 64) } : {}) });
        return;
      }
      if (options.accept && !options.accept(url.searchParams)) { page(false, 400); finish({ error: "rejected" }); return; }
      page(true);
      finish({ code, params: url.searchParams });
    });
    void (async () => {
      let bound = false;
      for (const candidate of ports) {
        if (settled) break;
        if (await listen(server, candidate)) { bound = true; break; }
      }
      if (!bound) { finish({ error: "port" }); return; }
      port = server.address()?.port ?? 0;
      if (settled) { try { server.close(); } catch { /* closed */ } return; }
      timer = setTimer(() => finish({ error: "timeout" }), options.timeoutMs);
      try { await options.onListening(port); }
      catch { finish({ error: "browser" }); }
    })();
  });
}
