// SPDX-License-Identifier: AGPL-3.0-or-later
// WIN-NOROUTE-1019: the server never answers a page load with JSON. When the packaged server cannot read the app page
// (an update still copying files, antivirus holding or refusing index.html), a request that is a page navigation gets a
// self-contained HTML setup page (503) built from constants in this file, with no file read. The page refreshes itself, so
// the app opens by itself the moment index.html is readable again. Every other request (scripts, assets, fetches, /api)
// keeps the JSON 404 byte for byte.
//
// The request headers only classify the request; they grant no trust. Nothing request-derived goes into the page.

import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createStaticUiLogger, staticUiReason } from "./static-ui-reason.ts";

type HeaderBag = Record<string, string | string[] | undefined>;

/** The page's own policy. No script at all: the refresh is a meta tag and Retry is a plain link. */
export const SETUP_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** The private address the "Show the log" link points at; the desktop's window-open handler turns it into opening server.log. */
export const OPEN_LOG_HREF = "murage-open-log:now";
/** 3 s until two minutes after the first unservable request, then 10 s. It has no end: the page says Murage opens on its own. */
const REFRESH_FAST_S = 3;
const REFRESH_SLOW_S = 10;
const SLOW_AFTER_MS = 2 * 60_000;
const INSTALLER_EVERY_MS = 10_000;
const INSTALLER_TIMEOUT_MS = 4_000;

// The words, in the eight shipped languages. Plain, no blame: the screen says setup is finishing.
export const UI_GATE_TEXT = Object.freeze({
  en: { title: "Murage is finishing setting up", body: "This takes a moment. Murage opens on its own as soon as it is ready.", updating: "An update is finishing. Murage opens on its own when it is done.", retry: "Retry", log: "Show the log" },
  de: { title: "Murage schließt die Einrichtung ab", body: "Das dauert einen Moment. Murage öffnet sich von selbst, sobald alles bereit ist.", updating: "Ein Update wird abgeschlossen. Murage öffnet sich von selbst, sobald es fertig ist.", retry: "Erneut versuchen", log: "Protokoll anzeigen" },
  es: { title: "Murage está terminando de configurarse", body: "Esto tarda un momento. Murage se abre solo en cuanto esté listo.", updating: "Se está terminando una actualización. Murage se abre solo cuando termine.", retry: "Reintentar", log: "Mostrar el registro" },
  fr: { title: "Murage termine sa configuration", body: "Cela prend un instant. Murage s'ouvre tout seul dès qu'il est prêt.", updating: "Une mise à jour se termine. Murage s'ouvre tout seul dès qu'elle est finie.", retry: "Réessayer", log: "Afficher le journal" },
  hi: { title: "Murage सेटअप पूरा कर रहा है", body: "इसमें थोड़ा समय लगता है। तैयार होते ही Murage अपने आप खुल जाता है।", updating: "एक अपडेट पूरा हो रहा है। पूरा होते ही Murage अपने आप खुल जाता है।", retry: "फिर से कोशिश करें", log: "लॉग दिखाएँ" },
  ja: { title: "Murage はセットアップを仕上げています", body: "少しお待ちください。準備ができ次第、Murage が自動で開きます。", updating: "アップデートを仕上げています。完了すると Murage が自動で開きます。", retry: "再試行", log: "ログを表示" },
  pt: { title: "O Murage está concluindo a configuração", body: "Isso leva um instante. O Murage abre sozinho assim que estiver pronto.", updating: "Uma atualização está sendo concluída. O Murage abre sozinho quando terminar.", retry: "Tentar de novo", log: "Mostrar o registro" },
  zh: { title: "Murage 正在完成设置", body: "这需要片刻。准备好后，Murage 会自动打开。", updating: "更新即将完成。完成后，Murage 会自动打开。", retry: "重试", log: "显示日志" },
});
type Lang = keyof typeof UI_GATE_TEXT;
const isLang = (value: string): value is Lang => Object.hasOwn(UI_GATE_TEXT, value);

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** The first supported primary subtag in Accept-Language order (a range with q=0 is skipped), else English. */
export function pickLanguage(acceptLanguage: string | string[] | undefined): Lang {
  const header = Array.isArray(acceptLanguage) ? acceptLanguage.join(",") : acceptLanguage;
  if (typeof header !== "string" || header.length > 1024) return "en";
  const ranges = header.split(",").map((part, index) => {
    const [tag = "", ...params] = part.trim().split(";");
    const qParam = params.map((p) => p.trim()).find((p) => /^q=/i.test(p));
    const q = qParam === undefined ? 1 : Number(qParam.slice(2));
    return { primary: tag.trim().toLowerCase().split("-")[0] ?? "", q: Number.isFinite(q) ? q : 0, index };
  }).filter((r) => r.q > 0 && r.primary);
  for (const range of ranges) if (isLang(range.primary)) return range.primary;
  return "en";
}

/** Accept parsed as media ranges: true only for an explicit text/html with q > 0. */
function acceptsHtml(accept: string | undefined): boolean {
  if (typeof accept !== "string" || accept.length > 2048) return false;
  return accept.split(",").some((part) => {
    const [type = "", ...params] = part.trim().split(";");
    if (type.trim().toLowerCase() !== "text/html") return false;
    const qParam = params.map((p) => p.trim()).find((p) => /^q=/i.test(p));
    const q = qParam === undefined ? 1 : Number(qParam.slice(2));
    return Number.isFinite(q) && q > 0;
  });
}

/**
 * Is this request a page navigation (the browser window asking for a document)? GET or HEAD, not /api/.
 * When any sec-fetch header is present they decide alone: a navigation only when `sec-fetch-dest` is exactly `document`
 * (Chromium always sends it on a top-level navigation) and `sec-fetch-mode`, if sent, is `navigate`. Only when every
 * sec-fetch header is absent does Accept decide: an explicit text/html with q > 0 (a bare wildcard range does not count).
 */
export function isPageNavigation(method: string | undefined, path: string, headers: HeaderBag): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (path.startsWith("/api/")) return false;
  const dest = first(headers["sec-fetch-dest"]);
  const mode = first(headers["sec-fetch-mode"]);
  const site = first(headers["sec-fetch-site"]);
  const user = first(headers["sec-fetch-user"]);
  if (dest !== undefined || mode !== undefined || site !== undefined || user !== undefined) {
    if (dest?.trim().toLowerCase() !== "document") return false;
    return mode === undefined || mode.trim().toLowerCase() === "navigate";
  }
  return acceptsHtml(first(headers.accept));
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The setup page. Retry is `href=""`, a reload of the same document URL, so nothing request-derived is in the page.
 * Show the log is the private murage-open-log link, present only for the desktop child. No script anywhere.
 * Colors follow prefers-color-scheme.
 */
export function setupPageHtml({ lang, updating, refreshS, logLink }: { lang: string; updating: boolean; refreshS: number; logLink: boolean }): string {
  const code = isLang(lang) ? lang : "en";
  const words = UI_GATE_TEXT[code];
  return `<!doctype html><html lang="${code}"><meta charset="utf-8"><title>Murage</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">` +
    `<meta http-equiv="refresh" content="${Math.max(1, Math.floor(refreshS))}">` +
    `<style>:root{--bg:#f7f7f8;--fg:#1b1b1f;--chip:#1b1b1f14;--chipb:#1b1b1f33;--chiph:#1b1b1f26}` +
    `@media (prefers-color-scheme:dark){:root{--bg:#16171a;--fg:#e8e8ea;--chip:#e8e8ea14;--chipb:#e8e8ea33;--chiph:#e8e8ea26}}` +
    `html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:15px -apple-system,Segoe UI,sans-serif}` +
    `body{box-sizing:border-box;padding:0 28px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center}` +
    `.m{color:#e8541a}h1{font-size:18px;font-weight:600;margin:0}p{margin:0;max-width:380px;line-height:1.5;opacity:.8}` +
    `.row{display:flex;gap:10px;margin-top:6px;flex-wrap:wrap;justify-content:center}` +
    `a.b{font-size:13px;color:inherit;text-decoration:none;background:var(--chip);border:1px solid var(--chipb);border-radius:6px;padding:6px 14px}` +
    `a.b:hover{background:var(--chiph)}a.b:focus-visible{outline:2px solid #ff6b35;outline-offset:2px}` +
    `a.p{background:#ff6b35;border-color:#ff6b35;color:#16171a;font-weight:600}</style>` +
    `<body><svg class="m" width="56" height="56" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M16.005 15.108a5.041 6.52 28.25 00-8.008-6.217 5.041 6.52 28.25 008.008 6.217A11.884 7.288-60.76 014.029 7.001"/><path d="M17 21h.01"/><path d="M7 3h.01"/><path d="M7.997 8.891a11.885 7.288-60.756 0111.977 8.107"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg>` +
    `<h1 id="t">${escapeHtml(words.title)}</h1><p id="d" role="status">${escapeHtml(updating ? words.updating : words.body)}</p>` +
    `<div class="row"><a class="b p" id="retry" href="">${escapeHtml(words.retry)}</a>` +
    (logLink ? `<a class="b" id="log" target="_blank" rel="noopener" href="${OPEN_LOG_HREF}">${escapeHtml(words.log)}</a>` : "") +
    `</div></body></html>`;
}

// The Windows installer and uninstaller processes an update runs. electron-builder names the setup
// Murage-<version>-setup.exe (electron-builder.yml nsis artifactName); the NSIS uninstaller copies itself
// to a temp folder as Un_A.exe while it removes the old files.
const INSTALLER_IMAGE = /^(murage-[\w.+-]+-setup\.exe|uninstall murage\.exe|un_a\.exe)$/i;

/** Image names out of `tasklist /FO CSV /NH` output. */
export function parseTasklistNames(text: string): string[] {
  const names: string[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = /^"([^"]+)"/.exec(line.trim());
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

/** True when `names` includes the Murage installer or uninstaller. */
export function hasInstallerProcess(names: string[]): boolean {
  return names.some((name) => INSTALLER_IMAGE.test(name));
}

function runTasklist(): Promise<string> {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, timeout: INSTALLER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? "" : String(stdout)));
  });
}

export interface SetupPageResponderOptions {
  now?: () => number;
  platform?: string;
  listProcesses?: () => Promise<string>;
  log?: (line: string) => void;
  /** Include the "Show the log" link: true for the desktop child, false for a Cloud home. */
  logLink?: boolean;
}

/**
 * One responder per packaged server. `respond` answers an unservable page navigation with the setup page and returns true,
 * or returns false and writes nothing (the caller then sends its JSON 404). `served` is called on a good index read and
 * restarts the refresh timer. `trace` is the repro box's debug line, one per document response.
 */
export function createSetupPageResponder({ now = Date.now, platform = process.platform, listProcesses = runTasklist, log = (line) => console.log(line), logLink = true }: SetupPageResponderOptions = {}) {
  const say = createStaticUiLogger(log, now);
  let firstUnservableAt: number | null = null;
  // The installer check: single-flight, started only by a setup-page response, never awaited. A response reads the last answer.
  let installerSeen = false;
  let installerCheckedAt = Number.NEGATIVE_INFINITY;
  let installerInFlight = false;
  const checkInstaller = () => {
    if (platform !== "win32" || installerInFlight || now() - installerCheckedAt < INSTALLER_EVERY_MS) return;
    installerInFlight = true;
    installerCheckedAt = now();
    let settled = false;
    const settle = (value: boolean) => { if (settled) return; settled = true; clearTimeout(timer); installerInFlight = false; installerSeen = value; };
    const timer = setTimeout(() => settle(false), INSTALLER_TIMEOUT_MS);
    timer.unref?.();
    try {
      Promise.resolve(listProcesses()).then((text) => settle(hasInstallerProcess(parseTasklistNames(text))), () => settle(false));
    } catch { settle(false); }
  };

  return {
    respond(req: Pick<IncomingMessage, "method" | "url" | "headers">, res: Pick<ServerResponse, "writeHead" | "end">, err: unknown): boolean {
      let path: string;
      try { path = new URL(req.url ?? "/", "http://localhost").pathname; } catch { return false; }
      if (!isPageNavigation(req.method, path, req.headers)) return false;
      const at = now();
      if (firstUnservableAt === null) firstUnservableAt = at;
      const refreshS = at - firstUnservableAt < SLOW_AFTER_MS ? REFRESH_FAST_S : REFRESH_SLOW_S;
      checkInstaller();
      const updating = installerSeen;
      const body = Buffer.from(setupPageHtml({ lang: pickLanguage(req.headers["accept-language"]), updating, refreshS, logLink }), "utf8");
      res.writeHead(503, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": String(refreshS),
        "content-security-policy": SETUP_PAGE_CSP,
        "content-length": String(body.length),
      });
      res.end(req.method === "HEAD" ? undefined : body);
      const { kind, code } = staticUiReason(err);
      say(`static ui: served the setup page (${kind} ${code}); an update installer is ${updating ? "running" : "not seen"}`);
      return true;
    },
    served(): void { firstUnservableAt = null; },
    /** Repro-box debug: one `static ui: page <status> <content-type>` line per main-frame document response. Off unless asked for. */
    trace(req: Pick<IncomingMessage, "method" | "url" | "headers">, res: ServerResponse): void {
      let path: string;
      try { path = new URL(req.url ?? "/", "http://localhost").pathname; } catch { return; }
      if (!isPageNavigation(req.method, path, req.headers)) return;
      // The server passes its headers straight to writeHead, so the content type is read there.
      let type = "";
      const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
      (res as unknown as { writeHead: (...args: unknown[]) => ServerResponse }).writeHead = (...args: unknown[]) => {
        try {
          const headers = args.find((a) => a && typeof a === "object") as Record<string, unknown> | undefined;
          const entry = headers && Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type");
          type = String(entry?.[1] ?? res.getHeader("content-type") ?? "").split(";")[0] ?? "";
        } catch { /* a diagnostic never stops the server */ }
        return writeHead(...args);
      };
      res.on("finish", () => { try { log(`static ui: page ${res.statusCode} ${type}`); } catch { /* same */ } });
    },
  };
}
