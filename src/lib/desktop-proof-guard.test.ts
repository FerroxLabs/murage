// Gate: the harness denies by default (server/route-policy.ts). Every /api
// route except health, media bytes, internal and extension needs a proven
// caller, and the desktop window proves itself with the surface mark plus the
// per-launch secret (desktopCallerHeaders / desktopSurfaceHeaders in
// live-events.ts). A request without it is answered 404 "no such route".
//
// This guard reads every non-test source file under src/ and fails, naming the
// file and line, for any raw fetch, EventSource, WebSocket, sendBeacon or
// XMLHttpRequest that could reach /api/ without carrying the proof. A target
// is judged unproven unless the call clearly goes somewhere else (a literal or
// an in-file constant that is not /api) or it is on the allow list below.
// Requests made through the shared helper `api()` (src/state/store.tsx) carry
// the proof themselves and are not raw requests.
//
// URL-loaded resources (<img src>, new Image().src) cannot set a header, and
// the proof must never ride in a URL, so those sinks load through a single-use
// ticket: <DesktopImg>, useDesktopResourceUrl() or ticketedResourceUrl().
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The markers that mean a request carries (or is built from) the proof. */
const PROOF_WHOLE = /desktopCallerHeaders|callRouteHeaders|desktopHeaders|liveEventsUrl|ticketedResourceUrl|\bticket\b/;
/** The secret alone is not the proof: the harness needs the surface mark with it. */
const carriesProof = (text: string) => PROOF_WHOLE.test(text) || ((/desktopSurfaceHeaders/.test(text) || /\.\.\.surfaceHeaders\b/.test(text)) && /x-murage-surface["']?\s*:|SURFACE_HEADER/.test(text));

/** Raw requests the policy leaves open or that the proof cannot apply to. */
const ALLOW: ReadonlyArray<{ file: string; needle: string; why: string }> = [
  { file: "lib/live-events.ts", needle: "DEV_SECRET_PATH", why: "GET /api/desktop-secret is a health route: it hands the secret over, so it cannot carry it (dev launches only)" },
  { file: "lib/live-events.ts", needle: "NativeEventSource(", why: "the URL comes from liveEventsUrl() and the adapter adds a single-use ticket for it (ticketedResourceUrl), never the proof" },
  { file: "lib/push-enrol.ts", needle: "browserPushDeps", why: "phone and paired-browser path only (SettingsModal shows it when desktop === false); the companion supplies the proof" },
  { file: "lib/save-file.ts", needle: "fetch(url", why: "reads a blob: or data: URL the page itself made, never an /api path" },
  { file: "lib/session-check.ts", needle: "globalThis.fetch(path, init)", why: "delegate whose callers pass the /session routes (SESSION_PATH), which are not under /api" },
  { file: "lib/workspace-pane.ts", needle: "fetchImpl: FetchLike", why: "the default delegate of workspaceApi(), which adds the surface mark and secret to every call before it reaches here" },
  { file: "lib/composer-attachments.ts", needle: "fetch(`/api/attachments", why: "the shared parser takes the proof from its caller; composer-image-upload.ts always supplies it and the test below stops components importing the bare function" },
  { file: "lib/silero-vad.ts", needle: "fetch(modelUrl", why: "fetches the bundled VAD model file, not an /api route" },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "e2e" || name === "__tests__" || name === "node_modules") continue;
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** A source's path under src/ in the allowlists' spelling: posix separators on every OS. */
const srcPath = (path: string) => relative(SRC, path).split(sep).join("/");

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

/** The text inside the parentheses that open at `open`, string aware. */
function callArguments(source: string, open: number): string {
  let depth = 0;
  let quote = "";
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")" && --depth === 0) return source.slice(open + 1, i);
  }
  return source.slice(open + 1, open + 600);
}

function firstArgument(args: string): string {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i]!;
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    else if (ch === "," && depth === 0) return args.slice(0, i);
  }
  return args;
}

/** What the target text says, with in-file constants followed one level. */
function resolveTarget(source: string, target: string): { text: string; resolved: boolean } {
  let text = target;
  let resolved = /["'`]/.test(target);
  for (const id of new Set(target.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
    const declaration = new RegExp(`\\b(?:const|let|var)\\s+${id.replace(/\$/g, "\\$")}\\b[^;]*;`).exec(source);
    if (declaration) {
      text += ` ${declaration[0]}`;
      resolved = true;
    }
  }
  return { text, resolved };
}

const CALLS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: "fetch", re: /\bfetch(?:Impl)?\s*\(/g },
  { kind: "fetch", re: /\(\s*fetchImpl\s*\?\?\s*fetch\s*\)\s*\(/g },
  { kind: "EventSource", re: /\bnew\s+\w*EventSource\s*\(/g },
  { kind: "WebSocket", re: /\bnew\s+(?:\w*WebSocket\w*|Impl)\s*\(/g },
  { kind: "sendBeacon", re: /\bsendBeacon\s*\(/g },
  { kind: "XMLHttpRequest", re: /\bxhr\.open\s*\(|\bnew\s+XMLHttpRequest\b/g },
];

export interface RawRequest {
  file: string;
  line: number;
  kind: string;
  excerpt: string;
}

/** Raw network calls in one file that may reach /api/ with no proof. */
export function findUnprovenApiRequests(source: string, file: string): RawRequest[] {
  const found: RawRequest[] = [];
  const lines = source.split("\n");
  // `const call = opts.fetchImpl ?? fetch;` makes `call(` a fetch.
  const aliases = [...source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*[^;\n]*\bfetch(?:Impl)?\b[^;\n]*;/g)].map((m) => m[1]!).filter((n) => n !== "fetchImpl");
  const patterns = [...CALLS, ...aliases.map((name) => ({ kind: "fetch", re: new RegExp(`\\b${name}\\s*\\(`, "g") }))];
  for (const { kind, re } of patterns) {
    for (const match of source.matchAll(re)) {
      const at = match.index!;
      const lineNo = lineOf(source, at);
      const text = lines[lineNo - 1] ?? "";
      if (/^\s*(\/\/|\*|\/\*)/.test(text)) continue;
      if (/(?:function|async)\s+\w*$/.test(source.slice(Math.max(0, at - 24), at))) continue;
      const paren = match[0].lastIndexOf("(");
      const args = paren < 0 ? source.slice(at, at + 400) : callArguments(source, at + paren);
      const target = resolveTarget(source, firstArgument(args));
      // A call whose target is known and is not /api goes somewhere else.
      if (target.resolved && !/\/api\b/.test(target.text)) continue;
      const window = `${lines.slice(Math.max(0, lineNo - 13), lineNo - 1).join("\n")}\n${match[0]}${args}`;
      if (carriesProof(window)) continue;
      if (ALLOW.some((entry) => file.endsWith(entry.file) && (`${text}\n${match[0]}${args}${window}`.includes(entry.needle)))) continue;
      found.push({ file, line: lineNo, kind, excerpt: text.trim().slice(0, 100) });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

// ---- Resource sinks -------------------------------------------------------
// A URL the browser loads itself cannot carry a header. A harness path there
// (anything under /api/) must load through a ticket (ticketedResourceUrl), or the harness
// answers 404 "no such route". EventSource and WebSocket are covered above.

/** A URL expression that is wrapped, or is a helper that wraps it. */
const RESOURCE_PROOF = /ticketedResourceUrl|useDesktopResourceUrl|resourceNeedsTicket|liveEventsUrl/;
const NOT_HARNESS = /^\s*["'`](?:data:|blob:|https?:\/\/|about:|#)/;

/** Resource sinks that may be loading a harness URL with no proof in the query. */
const RESOURCE_ALLOW: ReadonlyArray<{ file: string; needle: string; why: string }> = [
  { file: "components/AndroidDevicePanel.tsx", needle: "src={frame}", why: "frame is the data: URL of a screenshot the bridge returned, never a harness path" },
  { file: "components/ImageMedia.tsx", needle: "srcSet={srcSet}", why: "srcSet is only built when desktop === false (a phone or paired browser holds no secret and proves itself another way); the desktop src is wrapped" },
  { file: "components/Announcements.tsx", needle: "imageUrl!", why: "imageUrl is a blob: object URL made from bytes fetched with the caller's headers (lib/announcements.ts)" },
  { file: "components/PluginsPanel.tsx", needle: "card.logo", why: "catalogue logos are external https URLs from the app catalogue, never harness paths" },
  { file: "components/ComputerPanel.tsx", needle: "frameSrc", why: "frameSrc is a data: URL (base64 frame or the screenshot image), not an /api path" },
  { file: "components/ArtifactCards.tsx", needle: "audio ref={audio}", why: "url is the signed /api/media/bytes capability the resolver returned, which route-policy leaves open (class media)" },
  { file: "components/MediaPlayer.tsx", needle: "src: source.url", why: "source.url is the signed /api/media/bytes capability the resolver returned (route class media), which carries its own proof in the URL" },
  { file: "components/MediaPlayer.tsx", needle: 'setAttribute("src", source.url)', why: "re-attaches that same signed /api/media/bytes capability after StrictMode's second effect run" },
  { file: "components/MediaPlayer.tsx", needle: "download={asset.name}", why: "url is the same signed /api/media/bytes capability, which carries its own proof in the URL" },
  { file: "components/WhatsNewDialog.tsx", needle: "tile.img", why: "tile.img is a bundled static asset import, not served by the harness" },
  { file: "components/FirstRunChrome.tsx", needle: "window.open(url", why: "openOutside opens a page in the person's real browser, never a harness path" },
  { file: "components/TeamLibraryPanel.tsx", needle: "window.open(url", why: "external link fallback when the desktop bridge is absent; opens another site in a new tab" },
  { file: "components/SkillRecorderPage.tsx", needle: "event.screenshot", why: "screenshot is a canvas toDataURL() string taken in this page, never a harness path" },
  { file: "lib/announcements.ts", needle: "window.open(url", why: "guarded by an https:// test two lines above: only external links reach it" },
  { file: "lib/save-file.ts", needle: "link.href = url", why: "clickDownload is handed a blob: or data: URL, or one its caller already ticketed at the click (saveUrl, ImageMedia)" },
  { file: "lib/image-thumbnail.ts", needle: "probe.src = url", why: "the only caller passes an <img>'s currentSrc, which is already the proven URL" },
];

export interface ResourceSink {
  file: string;
  line: number;
  kind: string;
  excerpt: string;
}

/** The text of the JSX tag that opens at `open` (a `<`), brace and string aware. */
function tagText(source: string, open: number): string {
  let depth = 0;
  let quote = "";
  for (let i = open + 1; i < source.length; i += 1) {
    const ch = source[i]!;
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") i = source.indexOf("\n", i) < 0 ? source.length : source.indexOf("\n", i);
    else if (ch === "/" && source[i + 1] === "*") i = source.indexOf("*/", i) < 0 ? source.length : source.indexOf("*/", i) + 1;
    else if (depth === 0 && (ch === '"' || ch === "'")) quote = ch;
    else if (ch === "`") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0 && source[i - 1] !== "=") return source.slice(open, i + 1);
  }
  return source.slice(open, open + 600);
}

/** The value of a JSX attribute inside one tag's text, or null. */
function attributeValue(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*`).exec(tag);
  if (!m) return null;
  const start = m.index + m[0].length;
  const ch = tag[start];
  if (ch === '"' || ch === "'") return tag.slice(start, tag.indexOf(ch, start + 1) + 1);
  if (ch === "{") {
    let depth = 0;
    let quote = "";
    for (let i = start; i < tag.length; i += 1) {
      const c = tag[i]!;
      if (quote) {
        if (c === "\\") i += 1;
        else if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth += 1;
      else if (c === "}" && --depth === 0) return tag.slice(start + 1, i);
    }
  }
  return null;
}

/** True when this URL expression cannot be a harness path or already carries the proof. */
function resourceUrlIsFine(source: string, expr: string): boolean {
  if (RESOURCE_PROOF.test(expr)) return true;
  if (NOT_HARNESS.test(expr)) return true;
  const target = resolveTarget(source, expr);
  if (RESOURCE_PROOF.test(target.text)) return true;
  // A static asset import (`import hero from "./hero.png"`) is bundled, not served by the harness.
  const bare = expr.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(bare) && new RegExp(`import\\s+${bare}\\s+from\\s+["'][^"']+\\.(?:png|jpe?g|gif|svg|webp|avif|mp3|wav|ogg|mp4|webm)(?:\\?[^"']*)?["']`).test(source)) return true;
  // The target is known and is not an /api path: it starts with a literal, or
  // with an in-file constant whose own declaration holds a literal. A name the
  // file cannot resolve (`api + "/x"`, `item.src`) is unknown, hence unproven.
  const first = /^\s*(?:["'`]|([A-Za-z_$][\w$]*))/.exec(expr);
  // `const url = URL.createObjectURL(...)` and a canvas toDataURL are never harness paths.
  if (first?.[1] && new RegExp(`\\b(?:const|let|var)\\s+${first[1].replace(/\$/g, "\\$")}\\b[^;]*\\b(?:createObjectURL|toDataURL)\\b`).test(source)) return true;
  const known = first !== null && (first[1] === undefined || new RegExp(`\\b(?:const|let|var)\\s+${first[1].replace(/\$/g, "\\$")}\\b[^;]*["'\`][^;]*;`).test(source));
  if (known && !/\/api\b/.test(target.text)) return true;
  return false;
}

/** Browser-loaded resource sinks in one file that may load a harness URL with no proof. */
export function findUnprovenResourceSinks(source: string, file: string): ResourceSink[] {
  const found: ResourceSink[] = [];
  const lines = source.split("\n");
  const add = (index: number, kind: string, expr: string, extra = "") => {
    const lineNo = lineOf(source, index);
    const text = lines[lineNo - 1] ?? "";
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;
    if (resourceUrlIsFine(source, expr)) return;
    if (RESOURCE_ALLOW.some((entry) => file.endsWith(entry.file) && `${text}\n${expr}\n${extra}`.includes(entry.needle))) return;
    found.push({ file, line: lineNo, kind, excerpt: text.trim().slice(0, 100) });
  };

  // JSX <img>, <audio>, <video>, <source> and <a download>.
  for (const match of source.matchAll(/<(img|audio|video|source|a)\b/g)) {
    const tag = tagText(source, match.index!);
    const name = match[1]!;
    if (name === "a") {
      if (!/\sdownload\b/.test(tag)) continue;
      const href = attributeValue(tag, "href");
      if (href !== null) add(match.index!, "a[download]", href, tag);
    } else {
      for (const attr of name === "img" || name === "source" ? ["src", "srcSet"] : name === "video" ? ["src", "poster"] : ["src"]) {
        const value = attributeValue(tag, attr);
        if (value !== null) add(match.index!, name, value, tag);
      }
      // `<audio {...shared} />`: the src, href or poster arrives through an object spread, so read the
      // object literal the spread names (one level, in this file) and check those properties instead.
      for (const spread of tag.matchAll(/\{\s*\.\.\.\s*([A-Za-z_$][\w$]*)\s*\}/g)) {
        const declaration = new RegExp(`\\b(?:const|let|var)\\s+${spread[1]!.replace(/\$/g, "\\$")}\\b[^=\\n]*=\\s*\\{`).exec(source);
        if (!declaration) continue;
        const open = declaration.index + declaration[0].length - 1;
        const literal = callArguments(source, open).replace(/^\{/, "");
        for (const prop of literal.matchAll(/(?:^|[,{\s])(src|srcSet|href|poster)\s*:\s*/g)) {
          const at = open + 1 + prop.index! + prop[0].length;
          add(at, `${name} {...${spread[1]}}.${prop[1]}`, firstArgument(source.slice(at, at + 400)).split("\n")[0]!);
        }
      }
    }
  }
  // element.setAttribute("src" | "href" | "poster", url): the same sink without the property syntax.
  for (const match of source.matchAll(/\.setAttribute\s*\(\s*["'](src|href|poster)["']\s*,/g)) {
    const args = callArguments(source, match.index! + match[0].indexOf("("));
    add(match.index!, `setAttribute(${match[1]})`, firstArgument(args.slice(firstArgument(args).length + 1)));
  }
  // element.src = ..., for new Image().src, a probe, or an <audio> made in code.
  for (const match of source.matchAll(/\b[\w$.]+\.src\s*=(?!=)\s*([^;\n]+)/g)) {
    if (/^\s*(?:""|'')\s*$/.test(match[1]!)) continue;
    add(match.index!, "src=", match[1]!);
  }
  // link.href = url followed by link.download: a programmatic download.
  if (/\.download\s*=/.test(source)) {
    for (const match of source.matchAll(/\b[\w$.]+\.href\s*=(?!=)\s*([^;\n]+)/g)) add(match.index!, "download link", match[1]!);
  }
  for (const match of source.matchAll(/\bnew\s+Audio\s*\(/g)) {
    const args = callArguments(source, match.index! + match[0].length - 1);
    if (args.trim()) add(match.index!, "Audio", firstArgument(args));
  }
  for (const match of source.matchAll(/\bwindow\.open\s*\(/g)) {
    const args = callArguments(source, match.index! + match[0].length - 1);
    if (args.trim()) add(match.index!, "window.open", firstArgument(args));
  }
  // CSS url(...) and backgroundImage built in TS/TSX (url(#id) is an in-document reference).
  for (const match of source.matchAll(/\burl\(\s*(?!#|\$\{(?:uid|id|grad)\b)([^)\n]*)\)/g)) {
    const lineStart = source.lastIndexOf("\n", match.index!) + 1;
    if (/^\s*(\/\/|\*|\/\*)/.test(source.slice(lineStart, match.index!) + "x")) continue;
    if (!/["'`]/.test(source.slice(lineStart, match.index!)) && !/["'`]\s*$/.test(source.slice(lineStart, match.index!))) continue;
    add(match.index!, "css url()", match[1]!);
  }
  for (const match of source.matchAll(/\bbackgroundImage\s*[:=]\s*([^,;\n}]+)/g)) add(match.index!, "backgroundImage", match[1]!);
  return found.sort((a, b) => a.line - b.line);
}

describe("every raw request from src/ to the harness carries the desktop proof", () => {
  it("scans the real sources and finds none without it", () => {
    const failures = sourceFiles(SRC).flatMap((path) => findUnprovenApiRequests(readFileSync(path, "utf8"), srcPath(path)));
    expect(
      failures.map((f) => `src/${f.file}:${f.line} raw ${f.kind} with no desktop proof: ${f.excerpt}`),
      "Send desktopCallerHeaders() (or go through api() in src/state/store.tsx); the harness answers an unproven request 404 no such route",
    ).toEqual([]);
  });

  it("the allow list stays short and every entry still matches a call", () => {
    expect(ALLOW.length).toBeLessThanOrEqual(8);
    expect(RESOURCE_ALLOW.length).toBeLessThanOrEqual(16);
    for (const entry of [...ALLOW, ...RESOURCE_ALLOW]) {
      expect(readFileSync(join(SRC, entry.file), "utf8"), entry.why).toContain(entry.needle.replace(/\($/, ""));
      expect(entry.why.length).toBeGreaterThan(10);
    }
  });

  describe("the scanner itself", () => {
    const flag = (source: string) => findUnprovenApiRequests(source, "x.ts").map((r) => `${r.kind}:${r.line}`);
    it("flags a raw fetch to /api with no proof, including template strings", () => {
      expect(flag("async function f(id) {\n  return fetch(`/api/bots/${id}/x`, { method: 'POST' });\n}")).toEqual(["fetch:2"]);
    });
    it("flags a URL built from a base constant", () => {
      expect(flag("const BASE = '/api/things';\nasync function f() {\n  await fetch(BASE + '/a');\n}")).toEqual(["fetch:3"]);
    });
    it("flags EventSource, WebSocket, sendBeacon and XMLHttpRequest on /api", () => {
      expect(flag("const s = new EventSource(`/api/events?a=1`);")).toEqual(["EventSource:1"]);
      expect(flag("const w = new WebSocket(`ws://h/api/voice/stream`);")).toEqual(["WebSocket:1"]);
      expect(flag("navigator.sendBeacon('/api/presence', body);")).toEqual(["sendBeacon:1"]);
      expect(flag("const x = new XMLHttpRequest();\nx.open('POST', '/api/a');")).toContain("XMLHttpRequest:1");
    });
    it("flags an injected fetchImpl and an alias of fetch", () => {
      expect(flag("async function f(fetchImpl = fetch) {\n  await fetchImpl('/api/voice/cleanup', {});\n}")).toEqual(["fetch:2"]);
      expect(flag("const call = opts.fetchImpl ?? fetch;\nawait call(path, {});")).toEqual(["fetch:2"]);
    });
    it("accepts a request that carries the proof, and one that goes elsewhere", () => {
      expect(flag("fetch('/api/x', { headers: desktopCallerHeaders() });")).toEqual([]);
      expect(flag("fetch('/session/device', { method: 'DELETE' });")).toEqual([]);
      expect(flag("const SESSION = '/session';\nfetch(SESSION);")).toEqual([]);
    });
  });

  describe("browser-loaded resource sinks", () => {
    const flagSinks = (source: string) => findUnprovenResourceSinks(source, "x.tsx").map((r) => `${r.kind}:${r.line}`);
    it("flags exactly the unproven <img>, not the proven one", () => {
      const api = "'/api/attachments/a.png'";
      expect(flagSinks(`const api = ${api};\nconst a = <img src={api + "/x"} alt="" />;`)).toEqual(["img:2"]);
      expect(flagSinks(`const api = ${api};\nconst a = <img src={ticketedResourceUrl(api + "/x")} alt="" />;`)).toEqual([]);
      expect(flagSinks(`const a = <img src={api + "/x"} alt="" />;\nconst b = <img src={ticketedResourceUrl(api + "/x")} alt="" />;`)).toEqual(["img:1"]);
    });
    it("flags every other sink kind on an /api path and accepts the proven forms", () => {
      expect(flagSinks("const a = <audio src={`/api/media/${id}`} />;")).toEqual(["audio:1"]);
      expect(flagSinks('const v = <video controls><source src="/api/v.mp4" /></video>;')).toEqual(["source:1"]);
      expect(flagSinks('const l = <a href={`/api/artifacts/${id}/download`} download="x">save</a>;')).toEqual(["a[download]:1"]);
      expect(flagSinks("const i = new Image();\ni.src = `/api/screen/${id}`;")).toEqual(["src=:2"]);
      expect(flagSinks("const a = new Audio(`/api/tts/${id}`);")).toEqual(["Audio:1"]);
      expect(flagSinks("const s = { backgroundImage: `url(/api/avatars/${id})` };")).toContain("backgroundImage:1");
      expect(flagSinks("const s = `url(/api/avatars/${id})`;")).toEqual(["css url():1"]);
      expect(flagSinks("window.open(`/api/artifacts/${id}/download`);")).toEqual(["window.open:1"]);
      expect(flagSinks("const i = new Image();\ni.src = ticketedResourceUrl(`/api/screen/${id}`);")).toEqual([]);
      expect(flagSinks("const a = new Audio(ticketedResourceUrl(`/api/tts/${id}`));")).toEqual([]);
      expect(flagSinks('const a = <img src="data:image/png;base64,AAA" alt="" />;')).toEqual([]);
      expect(flagSinks('const a = <img src={`blob:${x}`} alt="" />;\nconst b = <img src="https://cdn.example.com/a.png" alt="" />;')).toEqual([]);
      expect(flagSinks('import hero from "./hero.png";\nconst a = <img src={hero} alt="" />;')).toEqual([]);
      expect(flagSinks("const s = `url(#${uid}-grad)`;")).toEqual([]);
    });
    it("sees a src, href or poster handed to a media element through an object spread", () => {
      expect(flagSinks('const shared = { controls: true, src: api + "/x" };\nconst a = <video {...shared} />;')).toEqual(["video {...shared}.src:1"]);
      expect(flagSinks('const shared = { controls: true, src: ticketedResourceUrl(api + "/x") };\nconst a = <video {...shared} />;')).toEqual([]);
      expect(flagSinks("const shared = {\n  poster: `/api/p/${id}`,\n};\nconst a = <video {...shared} />;")).toEqual(["video {...shared}.poster:2"]);
      expect(flagSinks('const shared = { src: "data:audio/wav;base64,AAA" };\nconst a = <audio {...shared} />;')).toEqual([]);
    });
    it("sees setAttribute for src, href and poster", () => {
      expect(flagSinks('el.setAttribute("src", `/api/media/${id}`);')).toEqual(["setAttribute(src):1"]);
      expect(flagSinks("el.setAttribute('poster', api + \"/p\");")).toEqual(["setAttribute(poster):1"]);
      expect(flagSinks('link.setAttribute("href", `/api/x/${id}`);')).toEqual(["setAttribute(href):1"]);
      expect(flagSinks('el.setAttribute("src", ticketedResourceUrl(`/api/media/${id}`));')).toEqual([]);
      expect(flagSinks('el.setAttribute("href", "https://example.com/a");\nel.setAttribute("class", `/api/x`);')).toEqual([]);
    });
    it("still flags a real ticketed source once its ticket is removed", () => {
      for (const file of ["components/Avatar.tsx", "components/ImageMedia.tsx", "components/ComposerAttachments.tsx", "components/CallAura.tsx"]) {
        const real = readFileSync(join(SRC, file), "utf8");
        expect(findUnprovenResourceSinks(real, file), `${file} as shipped`).toEqual([]);
        const stripped = real.replace(/ticketedResourceUrl\(/g, "String(").replace(/<DesktopImg\b/g, "<img");
        expect(findUnprovenResourceSinks(stripped, file).length, `${file} with the wrapper removed`).toBeGreaterThan(0);
      }
    });
    it("scans the real sources and finds no harness URL loaded without a ticket", () => {
      const failures = sourceFiles(SRC).flatMap((path) => findUnprovenResourceSinks(readFileSync(path, "utf8"), srcPath(path)));
      expect(
        failures.map((f) => `src/${f.file}:${f.line} ${f.kind} loads a URL with no desktop proof: ${f.excerpt}`),
        "Load it through <DesktopImg> or ticketedResourceUrl() (src/lib/live-events.ts); a browser-loaded /api URL without a ticket is answered 404 no such route",
      ).toEqual([]);
    });
  });

  describe("URL-loaded resources load through a single-use ticket", () => {
    const read = (file: string) => readFileSync(join(SRC, file), "utf8");
    it.each([
      ["components/ImageMedia.tsx", 3],
      ["components/ComposerAttachments.tsx", 1],
      ["components/Avatar.tsx", 1],
      ["components/CallAura.tsx", 1],
    ])("%s loads its /api image sources through a ticket", (file, count) => {
      expect((read(file).match(/<DesktopImg\b|ticketedResourceUrl\(/g) ?? []).length).toBeGreaterThanOrEqual(count);
    });
    it("no component uploads through the shared parser's unproven default", () => {
      const offenders = sourceFiles(join(SRC, "components")).filter((path) => /import\s*\{[^}]*\bimageAttachmentFromFile\b[^}]*\}\s*from\s*["']@\/lib\/composer-attachments["']/.test(readFileSync(path, "utf8")));
      expect(offenders.map((path) => srcPath(path))).toEqual([]);
    });
  });
});

// ---- Proof-carrying requests refuse redirects (AST) -----------------------
//
// The proof is the per-launch secret in a custom header. A fetch that follows
// a redirect sends that header to the redirect target too (fetch drops
// Authorization across origins, not this), so every request that carries the
// proof refuses a redirect, and a caller's own options cannot turn that back on.
//
// This reads src/ and electron/ with the TypeScript compiler, not with regular
// expressions. A request "carries the proof" when any of its arguments does:
// a producer call (desktopCallerHeaders, desktopSurfaceHeaders, any function or
// method found to return one, under any import name), an object with the proof
// header key, or a variable whose value is one of those, followed through any
// number of variables. For each such fetch, window.fetch, globalThis.fetch,
// alias, fetchImpl or new Request, it computes the EFFECTIVE top-level init:
// properties last-wins, spreads applied at any depth, parentheses unwrapped. The
// request passes only when redirect can be nothing but "error". A spread whose
// content cannot be resolved is unproven and fails. An EventSource or a
// WebSocket cannot refuse a redirect, so one that carries the proof fails.

const ROOT = join(SRC, "..");
const ELECTRON = join(ROOT, "electron");
const PROOF_HEADER = "x-murage-surface-secret";
const PROOF_HEADER_CONSTANT = "SURFACE_SECRET_HEADER";
const BASE_PRODUCERS = ["desktopCallerHeaders", "desktopSurfaceHeaders"];
/** Names whose value is the secret itself (the URL guard below). */
const PROOF_VALUES = new Set(["desktopSecret", "desktopSurfaceSecret"]);
const PROOF_VALUE_CALLS = new Set(["desktopSurfaceSecret", "ensureDesktopSurfaceSecret", "bridgeSecret"]);

/** Non-test sources under electron/, vendored code and fixtures left out. */
function electronFiles(dir = ELECTRON, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "vendor" || name === "fixtures" || name === "node_modules") continue;
      electronFiles(full, out);
    } else if (/\.(mjs|cjs|js)$/.test(name) && !/test|smoke/.test(name)) out.push(full);
  }
  return out;
}
const repoPath = (path: string) => relative(ROOT, path).split(sep).join("/");

const kindFor = (file: string) => (file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);

/** TypeScript names every file with "/" on every OS (C:\a\b.ts is C:/a/b.ts to the compiler host), so the files are keyed that way. */
const tsName = (path: string): string => path.replaceAll("\\", "/");
/** One program over the given files, imports left unresolved: the checker is
 * used only to bind each identifier to the declaration in scope. */
function buildProgram(named: ReadonlyMap<string, string>): ts.Program {
  const sources = new Map([...named].map(([path, text]) => [tsName(path), text] as const));
  const options: ts.CompilerOptions = { allowJs: true, noResolve: true, noLib: true, types: [], jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (name, version) => {
    const text = sources.get(name);
    return text === undefined ? undefined : ts.createSourceFile(name, text, version, true, kindFor(name));
  };
  host.fileExists = (name) => sources.has(name);
  host.readFile = (name) => sources.get(name);
  host.writeFile = () => {};
  return ts.createProgram({ rootNames: [...sources.keys()], options, host });
}

function unwrap(node: ts.Expression): ts.Expression {
  let e = node;
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    else return e;
  }
}

function forEachNode(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => forEachNode(child, visit));
}

/** A property name's text when it is static, else null. */
function staticName(name: ts.PropertyName | ts.Expression): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const e = unwrap(name.expression);
    return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : null;
  }
  return null;
}

/** The proof header key: its literal spelling or the shared constant. */
function isProofKey(name: ts.PropertyName | ts.Expression): boolean {
  if (ts.isComputedPropertyName(name)) return isProofKey(name.expression);
  const e = ts.isPropertyName(name) && !ts.isComputedPropertyName(name) && !ts.isIdentifier(name) ? name : unwrap(name as ts.Expression);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text.toLowerCase() === PROOF_HEADER;
  if (ts.isIdentifier(e) && !ts.isPropertyAssignment(e.parent)) return e.text === PROOF_HEADER_CONSTANT;
  if (ts.isPropertyAccessExpression(e)) return e.name.text === PROOF_HEADER_CONSTANT;
  return false;
}

interface FileIndex {
  file: string;
  sf: ts.SourceFile;
  checker: ts.TypeChecker;
  /** Every value a binding is given: its initializer or default, and each later assignment. */
  values: Map<ts.Symbol, ts.Expression[]>;
  /** Bindings the proof header key is written into after creation (`h[KEY] = s`, `h.set(KEY, s)`). */
  written: Set<ts.Symbol>;
  /** Parameters: their defaults are not what a caller supplies, so their value is unresolved. */
  params: Set<ts.Symbol>;
  /** Bindings an object is mutated through after creation (`init.redirect = x`, `Object.assign(init, x)`). */
  mutated: Set<ts.Symbol>;
  /** Local import or destructuring name -> the exported name it stands for. */
  aliases: Map<string, string>;
}

function indexFile(sf: ts.SourceFile, checker: ts.TypeChecker, file: string): FileIndex {
  const values = new Map<ts.Symbol, ts.Expression[]>();
  const written = new Set<ts.Symbol>();
  const params = new Set<ts.Symbol>();
  const mutated = new Set<ts.Symbol>();
  const aliases = new Map<string, string>();
  const symbol = (node: ts.Node) => checker.getSymbolAtLocation(node);
  const give = (id: ts.Node, value: ts.Expression) => {
    const sym = symbol(id);
    if (sym) values.set(sym, [...(values.get(sym) ?? []), value]);
  };
  const write = (target: ts.Expression) => {
    const id = unwrap(target);
    const sym = ts.isIdentifier(id) ? symbol(id) : undefined;
    if (sym) written.add(sym);
  };
  const mutate = (target: ts.Expression) => {
    let root = unwrap(target);
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = unwrap(root.expression);
    const sym = ts.isIdentifier(root) ? symbol(root) : undefined;
    if (sym) mutated.add(sym);
  };
  forEachNode(sf, (node) => {
    if (ts.isParameter(node)) {
      const names: ts.Node[] = [node.name];
      while (names.length) {
        const n = names.pop()!;
        if (ts.isIdentifier(n)) { const sym = symbol(n); if (sym) params.add(sym); }
        else if (ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) for (const el of n.elements) if (ts.isBindingElement(el)) names.push(el.name);
      }
    }
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name) && node.initializer) give(node.name, node.initializer);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const target = unwrap(node.left);
      if ((ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) && !(ts.isElementAccessExpression(target) && isProofKey(target.argumentExpression))) mutate(target);
    }
    if (ts.isDeleteExpression(node)) mutate(node.expression);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object" && ["assign", "defineProperty", "defineProperties"].includes(node.expression.name.text) && node.arguments[0]) mutate(node.arguments[0]);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = unwrap(node.left);
      if (ts.isIdentifier(left)) give(left, node.right);
      if (ts.isElementAccessExpression(left) && isProofKey(left.argumentExpression)) write(left.expression);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["set", "append"].includes(node.expression.name.text) && node.arguments[0] && isProofKey(node.arguments[0])) write(node.expression.expression);
    if (ts.isImportSpecifier(node)) aliases.set(node.name.text, (node.propertyName ?? node.name).text);
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const imported = node.propertyName ? staticName(node.propertyName) : node.name.text;
      if (imported) aliases.set(node.name.text, imported);
    }
  });
  return { file, sf, checker, values, written, params, mutated, aliases };
}

/** The values the binding an identifier names was given, in its own scope. */
/** The binding an identifier names; for `{ headers }` that is the variable, not the property. */
function bindingOf(index: FileIndex, id: ts.Identifier): ts.Symbol | undefined {
  return ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id ? index.checker.getShorthandAssignmentValueSymbol(id.parent) : index.checker.getSymbolAtLocation(id);
}
function valuesOf(index: FileIndex, id: ts.Identifier): ts.Expression[] {
  const sym = bindingOf(index, id);
  return sym ? (index.values.get(sym) ?? []) : [];
}
/** A parameter, or an object mutated after creation: what it holds cannot be read off its initializer. */
function isUnresolved(index: FileIndex, id: ts.Identifier): boolean {
  const sym = bindingOf(index, id);
  return Boolean(sym && (index.params.has(sym) || index.mutated.has(sym)));
}
function isWritten(index: FileIndex, id: ts.Identifier): boolean {
  const sym = bindingOf(index, id);
  return Boolean(sym && index.written.has(sym));
}

/** The program's source file for a path as this OS names it. */
function sourceFileOf(program: ts.Program, path: string): ts.SourceFile {
  const sf = program.getSourceFile(tsName(path));
  if (!sf) throw new Error(`the AST index has no source file for ${path}`);
  return sf;
}
/** Index real files: one program, one checker. */
function indexFiles(paths: readonly string[]): FileIndex[] {
  const sources = new Map(paths.map((path) => [path, readFileSync(path, "utf8")] as const));
  const program = buildProgram(sources);
  const checker = program.getTypeChecker();
  return paths.map((path) => indexFile(sourceFileOf(program, path), checker, repoPath(path)));
}
/** Index one snippet (the scanner tests). */
function indexSnippet(source: string, file = "x.ts"): FileIndex {
  const name = `/virtual/${file}`;
  const program = buildProgram(new Map([[name, source]]));
  return indexFile(program.getSourceFile(name)!, program.getTypeChecker(), file);
}

/** Producers: the functions that return the proof (`fns`, by the keys of
 * `functionKeys`, and `names` for messages), method or property names
 * called as `x.name()` (`members`), and the parameters some call passes the
 * proof into (`params`, as `name#index`), so a function that receives headers
 * from its caller is judged on what its callers send it. */
interface Producers { fns: Set<string>; names: Set<string>; members: Set<string>; params: Map<string, string> }

/** Where a node is, for messages: `file:line text`. */
function where(node: ts.Node): string {
  const sf = node.getSourceFile();
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  return `${sf.fileName.replace(/^.*?\/(src|electron)\//, "$1/")}:${line} ${node.getText(sf).replace(/\s+/g, " ").slice(0, 70)}`;
}

/** The name a function is known by: its own, or the variable, property or method that holds it. */
function functionName(fn: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return staticName(fn.name);
  const holder = fn.parent;
  if (holder && (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder)) && holder.name && !ts.isObjectBindingPattern(holder.name) && !ts.isArrayBindingPattern(holder.name)) return staticName(holder.name);
  return null;
}

const exported = (node: ts.Node) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** The keys a function answers to for parameter flow: its own declaration;
 * its exported name, for callers that import it; and, inside its own file
 * only, its method or property name. A bare name never links two files. */
function functionKeys(fn: ts.Node): string[] {
  const file = fn.getSourceFile().fileName;
  const keys = [`decl:${file}:${fn.pos}`];
  const name = functionName(fn);
  if (!name) return keys;
  if (ts.isMethodDeclaration(fn) || ts.isPropertyAssignment(fn.parent)) keys.push(`member:${file}:${name}`);
  const statement = ts.isVariableDeclaration(fn.parent) ? fn.parent.parent?.parent : fn;
  if (statement && exported(statement)) keys.push(`import:${name}`);
  return keys;
}

/** The keys a call reaches, by the binding its callee names. */
function calleeKeys(call: ts.CallExpression, checker: ts.TypeChecker): string[] {
  const callee = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(callee)) return [`member:${call.getSourceFile().fileName}:${callee.name.text}`];
  if (!ts.isIdentifier(callee)) return [];
  const keys: string[] = [];
  for (const decl of checker.getSymbolAtLocation(callee)?.declarations ?? []) {
    if (ts.isImportSpecifier(decl)) keys.push(`import:${(decl.propertyName ?? decl.name).text}`);
    else if (ts.isFunctionDeclaration(decl)) keys.push(`decl:${decl.getSourceFile().fileName}:${decl.pos}`);
    else if (ts.isVariableDeclaration(decl) && decl.initializer && (ts.isArrowFunction(unwrap(decl.initializer)) || ts.isFunctionExpression(unwrap(decl.initializer)))) {
      keys.push(`decl:${decl.getSourceFile().fileName}:${unwrap(decl.initializer).pos}`);
    }
  }
  return keys;
}

function returnedExpressions(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isFunctionLike(node) && node !== fn) return;
    if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
    node.forEachChild(walk);
  };
  fn.body.forEachChild(walk);
  return out;
}

class ProofScanner {
  /** What the last `carries() === true` rested on, for messages. */
  leaf = "";
  constructor(readonly index: FileIndex, readonly producers: Producers) {}

  /** A parameter (or a name destructured from one) that some caller passes the proof into. */
  receivesProof(id: ts.Identifier): boolean {
    const sym = bindingOf(this.index, id);
    for (const decl of sym?.declarations ?? []) {
      let node: ts.Node = decl;
      while (ts.isBindingElement(node) || ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) node = node.parent;
      if (!ts.isParameter(node)) continue;
      const fn = node.parent;
      const at = (fn as ts.SignatureDeclaration).parameters.indexOf(node);
      const origin = functionKeys(fn).map((key) => this.producers.params.get(`${key}#${at}`)).find(Boolean);
      if (origin) { this.leaf = `parameter ${id.text}, passed the proof at ${origin}`; return true; }
    }
    return false;
  }

  /** A call to a base producer (under any import name), to a function found
   * to return the proof (by its binding, never by a bare name), or to a method
   * or property function of that name (`options.headers()`). */
  isProducerCall(call: ts.CallExpression): boolean {
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee)) {
      if (BASE_PRODUCERS.includes(callee.text) || BASE_PRODUCERS.includes(this.index.aliases.get(callee.text) ?? "")) return true;
      return calleeKeys(call, this.index.checker).some((key) => this.producers.fns.has(key));
    }
    if (ts.isPropertyAccessExpression(callee)) {
      return BASE_PRODUCERS.includes(callee.name.text) || this.producers.fns.has(`import:${callee.name.text}`) || this.producers.members.has(callee.name.text);
    }
    return false;
  }

  isFetchLike(node: ts.Expression, seen = new Set<ts.Node>()): boolean {
    const e = unwrap(node);
    if (seen.has(e)) return false;
    seen.add(e);
    if (ts.isIdentifier(e)) {
      if (e.text === "fetch" || e.text === "fetchImpl") return true;
      return valuesOf(this.index, e).some((v) => this.isFetchLike(v, seen));
    }
    if (ts.isPropertyAccessExpression(e)) return e.name.text === "fetch" || e.name.text === "fetchImpl";
    if (ts.isBinaryExpression(e)) return this.isFetchLike(e.left, seen) || this.isFetchLike(e.right, seen);
    if (ts.isConditionalExpression(e)) return this.isFetchLike(e.whenTrue, seen) || this.isFetchLike(e.whenFalse, seen);
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "bind") return this.isFetchLike(e.expression.expression, seen);
    return false;
  }

  /** The arguments a fetch was bound with (`fetch.bind(null, url, init)`), through local aliases. */
  boundArguments(node: ts.Expression, seen = new Set<ts.Node>()): readonly ts.Expression[] {
    const e = unwrap(node);
    if (seen.has(e)) return [];
    seen.add(e);
    if (ts.isIdentifier(e)) {
      for (const v of valuesOf(this.index, e)) { const found = this.boundArguments(v, seen); if (found.length) return found; }
      return [];
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "bind") {
      return [...this.boundArguments(e.expression.expression, seen), ...e.arguments.slice(1)];
    }
    return [];
  }

  /** The constructor a `new` names, followed through local aliases (`const N = globalThis.EventSource`). */
  constructorName(node: ts.Expression, seen = new Set<ts.Node>()): string {
    const e = unwrap(node);
    if (seen.has(e)) return "";
    seen.add(e);
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    if (!ts.isIdentifier(e)) return "";
    if (["Request", "EventSource", "WebSocket"].includes(e.text)) return e.text;
    for (const v of valuesOf(this.index, e)) {
      const n = this.constructorName(v, seen);
      if (n) return n;
    }
    return /EventSource$/.test(e.text) ? "EventSource" : /WebSocket$/.test(e.text) ? "WebSocket" : e.text;
  }

  carries(node: ts.Expression | undefined, seen = new Set<ts.Node>()): boolean {
    if (!node) return false;
    const e = unwrap(node);
    if (seen.has(e)) return false;
    seen.add(e);
    if (ts.isCallExpression(e)) {
      if (this.isFetchLike(e.expression)) return false; // a Response does not carry the proof
      if (this.isProducerCall(e)) { this.leaf = where(e); return true; }
      // Only the calls that copy an object through: anything else returns its own value.
      const callee = unwrap(e.expression);
      const copier = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        && ((callee.expression.text === "Object" && ["assign", "fromEntries", "entries"].includes(callee.name.text)) || (callee.expression.text === "JSON" && callee.name.text === "parse"));
      if ((copier || (ts.isIdentifier(callee) && callee.text === "structuredClone")) && e.arguments.some((a) => this.carries(a, seen))) return true;
      return false;
    }
    if (ts.isNewExpression(e)) return ["Headers", "Request", "URLSearchParams"].includes(this.constructorName(e.expression)) && (e.arguments ?? []).some((a) => this.carries(a, seen));
    if (ts.isObjectLiteralExpression(e)) {
      return e.properties.some((p) =>
        (ts.isPropertyAssignment(p) && ((isProofKey(p.name) && Boolean((this.leaf = where(p)))) || this.carries(p.initializer, seen))) ||
        (ts.isShorthandPropertyAssignment(p) && this.carries(p.name, seen)) ||
        (ts.isSpreadAssignment(p) && this.carries(p.expression, seen)));
    }
    if (ts.isArrayLiteralExpression(e)) return e.elements.some((x) => this.carries(x, seen));
    if (ts.isIdentifier(e)) {
      if (isWritten(this.index, e)) { this.leaf = `${where(e)} (the proof key is written into it)`; return true; }
      if (this.receivesProof(e)) return true;
      if (BASE_PRODUCERS.includes(e.text) || BASE_PRODUCERS.includes(this.index.aliases.get(e.text) ?? "")) { this.leaf = where(e); return true; }
      return valuesOf(this.index, e).some((v) => this.carries(v, seen));
    }
    // `init.headers`: the headers of something that carries the proof.
    if (ts.isPropertyAccessExpression(e) && e.name.text === "headers") return this.carries(e.expression, seen);
    if (ts.isElementAccessExpression(e) && (isProofKey(e.argumentExpression) || staticName(unwrap(e.argumentExpression)) === "headers")) return this.carries(e.expression, seen);
    if (ts.isConditionalExpression(e)) return this.carries(e.whenTrue, seen) || this.carries(e.whenFalse, seen);
    if (ts.isBinaryExpression(e)) return this.carries(e.left, seen) || this.carries(e.right, seen);
    if (ts.isSpreadElement(e)) return this.carries(e.expression, seen);
    if (ts.isTemplateExpression(e)) return e.templateSpans.some((span) => this.carries(span.expression, seen));
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return returnedExpressions(e).some((r) => this.carries(r, seen));
    return false;
  }

  /** Every value an expression can resolve to as a string, or "?" when it cannot be proven. */
  private strings(node: ts.Expression, seen = new Set<ts.Node>()): Set<string> {
    const e = unwrap(node);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return new Set([e.text]);
    if (seen.has(e)) return new Set(["?"]);
    seen.add(e);
    if (ts.isConditionalExpression(e)) return new Set([...this.strings(e.whenTrue, seen), ...this.strings(e.whenFalse, seen)]);
    if (ts.isIdentifier(e)) {
      if (isUnresolved(this.index, e)) return new Set(["?"]);
      const values = valuesOf(this.index, e);
      if (values.length !== 1) return new Set(["?"]);
      return this.strings(values[0]!, seen);
    }
    return new Set(["?"]);
  }

  /** What a spread (or an init object) does to `redirect`: each outcome is a value, NONE (leaves it) or "?" (unprovable). */
  effects(node: ts.Expression, seen = new Set<ts.Node>()): Set<string> {
    const e = unwrap(node);
    if (ts.isObjectLiteralExpression(e)) return this.applyObject(e, new Set([NONE]), seen);
    if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === "undefined") || ts.isVoidExpression(e)) return new Set([NONE]);
    if (seen.has(e)) return new Set(["?"]);
    seen.add(e);
    if (ts.isIdentifier(e)) {
      if (isUnresolved(this.index, e)) return new Set(["?"]);
      const values = valuesOf(this.index, e);
      if (!values.length) return new Set(["?"]);
      return new Set(values.flatMap((v) => [...this.effects(v, seen)]));
    }
    if (ts.isConditionalExpression(e)) return new Set([...this.effects(e.whenTrue, seen), ...this.effects(e.whenFalse, seen)]);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return new Set([NONE, ...this.effects(e.right, seen)]);
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(e.operatorToken.kind)) {
      return new Set([...this.effects(e.left, seen), ...this.effects(e.right, seen)]);
    }
    return new Set(["?"]);
  }

  private applyObject(obj: ts.ObjectLiteralExpression, start: Set<string>, seen: Set<ts.Node>): Set<string> {
    let states = start;
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p)) {
        const key = staticName(p.name);
        if (key === "redirect") states = this.strings(p.initializer, new Set(seen));
        else if (key === null) states = new Set([...states, "?"]);
      } else if (ts.isShorthandPropertyAssignment(p)) {
        if (p.name.text === "redirect") states = this.strings(p.name, new Set(seen));
      } else if (ts.isSpreadAssignment(p)) {
        const effects = this.effects(p.expression, seen);
        states = new Set([...states].flatMap((s) => [...effects].map((f) => (f === NONE ? s : f))));
      } else if (p.name && (staticName(p.name) === "redirect" || staticName(p.name) === null)) {
        states = new Set(["?"]);
      }
    }
    return states;
  }

  /** The redirect a request ends up with: its input Request's, overlaid by its own init. */
  effectiveRedirect(args: readonly ts.Expression[], seen = new Set<ts.Node>()): Set<string> {
    let base = new Set([MISSING]);
    const input = args[0] ? unwrap(args[0]) : undefined;
    if (input && !seen.has(input)) {
      seen.add(input);
      const made = ts.isIdentifier(input) ? valuesOf(this.index, input).map(unwrap) : [input];
      const requests = made.filter((v): v is ts.NewExpression => ts.isNewExpression(v) && this.constructorName(v.expression) === "Request");
      if (requests.length) base = new Set(requests.flatMap((r) => [...this.effectiveRedirect(r.arguments ?? [], seen)]));
    }
    if (!args[1]) return base;
    const effects = this.effects(args[1]);
    return new Set([...base].flatMap((s) => [...effects].map((f) => (f === NONE ? s : f))));
  }
}
const NONE = "<none>";
const MISSING = "<missing>";

/** Producers across a set of files, to a fixpoint: base producers plus every function or method that returns one. */
function findProducers(indexes: readonly FileIndex[]): Producers {
  const producers: Producers = { fns: new Set(BASE_PRODUCERS.map((name) => `import:${name}`)), names: new Set(BASE_PRODUCERS), members: new Set(), params: new Map() };
  for (let changed = true; changed; ) {
    changed = false;
    for (const index of indexes) {
      const scanner = new ProofScanner(index, producers);
      forEachNode(index.sf, (node) => {
        if (ts.isCallExpression(node) && !scanner.isFetchLike(node.expression)) {
          const callees = calleeKeys(node, index.checker);
          if (callees.length) {
            node.arguments.forEach((arg, at) => {
              const fresh = callees.map((key) => `${key}#${at}`).filter((key) => !producers.params.has(key));
              if (fresh.length && scanner.carries(arg)) { for (const key of fresh) producers.params.set(key, `${where(arg)} (via ${scanner.leaf})`); changed = true; }
            });
          }
        }
        let name: string | null = null;
        let fn: ts.FunctionLikeDeclaration | null = null;
        let member = false;
        if (ts.isFunctionDeclaration(node) && node.name) { name = node.name.text; fn = node; }
        else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(unwrap(node.initializer)) || ts.isFunctionExpression(unwrap(node.initializer)))) {
          name = node.name.text; fn = unwrap(node.initializer) as ts.ArrowFunction;
        } else if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) && node.name) { name = staticName(node.name); fn = node; member = true; }
        else if (ts.isPropertyAssignment(node) && (ts.isArrowFunction(unwrap(node.initializer)) || ts.isFunctionExpression(unwrap(node.initializer)))) {
          name = staticName(node.name); fn = unwrap(node.initializer) as ts.ArrowFunction; member = true;
        }
        if (!name || !fn) return;
        const keys = functionKeys(fn);
        if (member ? producers.members.has(name) : keys.every((key) => producers.fns.has(key))) return;
        if (!returnedExpressions(fn).some((r) => scanner.carries(r))) return;
        if (member) producers.members.add(name);
        for (const key of keys) producers.fns.add(key);
        producers.names.add(name);
        changed = true;
      });
    }
  }
  return producers;
}

export interface ProofRequest {
  file: string;
  line: number;
  kind: string;
  ok: boolean;
  why: string;
  /** What makes it carry the proof. */
  via: string;
}

/** Every request in one indexed file that carries the proof, judged on its effective init. */
function proofRequestsIn(index: FileIndex, producers: Producers): ProofRequest[] {
  const scanner = new ProofScanner(index, producers);
  const out: ProofRequest[] = [];
  const line = (node: ts.Node) => index.sf.getLineAndCharacterOfPosition(node.getStart(index.sf)).line + 1;
  const judge = (node: ts.Node, kind: string, args: readonly ts.Expression[]) => {
    if (!args.some((a) => scanner.carries(a))) return;
    const via = scanner.leaf;
    if (kind === "EventSource" || kind === "WebSocket") {
      out.push({ file: index.file, line: line(node), kind, ok: false, why: `${kind} cannot refuse a redirect: it must never carry the proof`, via });
      return;
    }
    const states = scanner.effectiveRedirect(args);
    const ok = states.size === 1 && states.has("error");
    const why = ok ? "" : states.has(MISSING) ? 'no redirect: "error"' : states.has("?") ? "redirect is not provable (an unresolved spread or value)" : `redirect: "${[...states].find((s) => s !== "error")}"`;
    out.push({ file: index.file, line: line(node), kind, ok, why, via });
  };
  forEachNode(index.sf, (node) => {
    if (ts.isCallExpression(node) && scanner.isFetchLike(node.expression)) judge(node, "fetch", [...scanner.boundArguments(node.expression), ...node.arguments]);
    if (ts.isNewExpression(node)) {
      const name = scanner.constructorName(node.expression);
      if (name === "Request" || name === "EventSource" || name === "WebSocket") judge(node, name, node.arguments ?? []);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "setRequestHeader" && node.arguments[0] && isProofKey(node.arguments[0])) {
      out.push({ file: index.file, line: line(node), kind: "XMLHttpRequest", ok: false, why: "XMLHttpRequest follows redirects and cannot refuse them: it must never carry the proof", via: where(node) });
    }
  });
  return out;
}

/** One source checked on its own (the scanner tests): its own producers plus the base ones. */
export function proofRequests(source: string, file = "x.ts"): ProofRequest[] {
  const index = indexSnippet(source, file);
  return proofRequestsIn(index, findProducers([index]));
}

// ---- The proof never rides in a URL -----------------------------------------

export interface ProofUrl { file: string; line: number; why: string }

/** Places in one file that build a URL (or any string) with the proof in it. */
export function proofInUrls(source: string | FileIndex, file = "x.ts"): ProofUrl[] {
  const index = typeof source === "string" ? indexSnippet(source, file) : source;
  file = index.file;
  const out: ProofUrl[] = [];
  const line = (node: ts.Node) => index.sf.getLineAndCharacterOfPosition(node.getStart(index.sf)).line + 1;
  const isProofValue = (node: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    const e = unwrap(node);
    if (seen.has(e)) return false;
    seen.add(e);
    if (ts.isIdentifier(e)) return PROOF_VALUES.has(e.text) || PROOF_VALUES.has(index.aliases.get(e.text) ?? "") || valuesOf(index, e).some((v) => isProofValue(v, seen));
    if (ts.isPropertyAccessExpression(e)) return PROOF_VALUES.has(e.name.text);
    if (ts.isCallExpression(e)) {
      const callee = unwrap(e.expression);
      return (ts.isIdentifier(callee) && (PROOF_VALUE_CALLS.has(callee.text) || PROOF_VALUE_CALLS.has(index.aliases.get(callee.text) ?? ""))) || (ts.isPropertyAccessExpression(callee) && PROOF_VALUE_CALLS.has(callee.name.text));
    }
    if (ts.isConditionalExpression(e)) return isProofValue(e.whenTrue, seen) || isProofValue(e.whenFalse, seen);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind !== ts.SyntaxKind.PlusToken) return isProofValue(e.left, seen) || isProofValue(e.right, seen);
    return false;
  };
  const queryKey = (node: ts.Expression | ts.PropertyName) => {
    const name = ts.isComputedPropertyName(node) ? unwrap(node.expression) : node;
    if (ts.isIdentifier(name) && name.text === "SURFACE_SECRET_QUERY") return true;
    const text = ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isIdentifier(name) ? name.text : "";
    return /^surface_?secret$/i.test(text);
  };
  forEachNode(index.sf, (node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /surface_?secret=/i.test(node.text)) {
      out.push({ file, line: line(node), why: "a URL string with the proof's query parameter" });
    }
    if (ts.isTemplateExpression(node) && node.templateSpans.some((span) => isProofValue(span.expression))) out.push({ file, line: line(node), why: "a template string with the proof in it" });
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && (isProofValue(node.left) || isProofValue(node.right))) out.push({ file, line: line(node), why: "a string concatenated with the proof" });
    if (ts.isIdentifier(node) && node.text === "SURFACE_SECRET_QUERY" && !ts.isVariableDeclaration(node.parent)) out.push({ file, line: line(node), why: "the proof's query parameter name" });
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URLSearchParams") {
      const init = node.arguments?.[0] ? unwrap(node.arguments[0]) : undefined;
      if (init && ts.isObjectLiteralExpression(init) && init.properties.some((p) => ts.isPropertyAssignment(p) && (queryKey(p.name) || isProofValue(p.initializer)))) out.push({ file, line: line(node), why: "URLSearchParams built with the proof" });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["set", "append"].includes(node.expression.name.text) && node.arguments.length >= 2) {
      const [key, value] = node.arguments as unknown as [ts.Expression, ts.Expression];
      if (!isProofKey(key) && (queryKey(unwrap(key)) || isProofValue(value))) out.push({ file, line: line(node), why: "a query parameter set to the proof" });
    }
  });
  return out;
}

/** Things that name the query parameter on purpose: the Cloud proxy strips it from every URL it forwards. */
const URL_ALLOW: ReadonlyArray<{ file: string; needle: string; why: string }> = [
  { file: "electron/cloud-home-protocol.mjs", needle: "STRIPPED_QUERY_PARAMS", why: "the Cloud-home proxy names the old query parameter only to strip it from anything a page sends upstream" },
];

let allIndexes: FileIndex[] | null = null;
/** src/ and electron/, indexed once for both guards. */
const ALL_INDEXES = () => (allIndexes ??= indexFiles([...sourceFiles(SRC), ...electronFiles()]));

describe("proof-carrying requests refuse redirects (AST, src/ and electron/)", () => {
  const indexes = ALL_INDEXES();
  const producers = findProducers(indexes);
  const all = indexes.flatMap((index) => proofRequestsIn(index, producers));

  it("finds the producers: the base ones, every wrapper that returns one, and the proof key written in src only by live-events.ts", () => {
    const outside = sourceFiles(SRC).filter((path) => srcPath(path) !== "lib/live-events.ts" && /SURFACE_SECRET_HEADER|x-murage-surface-secret/.test(readFileSync(path, "utf8")));
    expect(outside.map(srcPath), "a second place that builds the proof header is a new producer; route it through desktopSurfaceHeaders()").toEqual([]);
    expect([...producers.names]).toEqual(expect.arrayContaining([...BASE_PRODUCERS, "callRouteHeaders", "desktopHeaders"]));
  });

  it("every request that carries the proof refuses redirects in its effective init", () => {
    expect(all.filter((r) => r.file.startsWith("src/")).length, "src/ requests that carry the proof").toBeGreaterThanOrEqual(28);
    expect(all.filter((r) => r.file.startsWith("electron/")).length, "electron/ requests that carry the proof (main.mjs and inbox-watch.mjs)").toBeGreaterThanOrEqual(18);
    const bad = all.filter((r) => !r.ok).map((r) => `${r.file}:${r.line} ${r.kind}: ${r.why} [carries the proof via ${r.via}]`);
    expect(bad, 'a followed redirect would hand the launch secret to its target: set redirect: "error" after every spread').toEqual([]);
  });

  describe("the scanner itself", () => {
    const scan = (source: string) => proofRequests(source).map((r) => `${r.line}:${r.kind}:${r.ok ? "ok" : r.why}`);
    const MISSING_WHY = 'no redirect: "error"';
    const UNPROVEN = "redirect is not provable (an unresolved spread or value)";

    it("flags a missing refusal, a follow, and a refusal a later spread can override", () => {
      expect(scan("fetch('/api/x', { headers: desktopCallerHeaders() });")).toEqual([`1:fetch:${MISSING_WHY}`]);
      expect(scan("fetch('/api/x', { redirect: 'follow', headers: desktopSurfaceHeaders() });")).toEqual(['1:fetch:redirect: "follow"']);
      expect(scan("fetch(p, { redirect: 'error', ...init, headers: desktopSurfaceHeaders() });")).toEqual([`1:fetch:${UNPROVEN}`]);
    });
    it("Astra: a nested spread after the refusal, parenthesised, is unproven", () => {
      expect(scan('fetch(p, ({\n  redirect: "error",\n  headers: desktopCallerHeaders(),\n  ...init\n}));')).toEqual([`1:fetch:${UNPROVEN}`]);
      expect(scan('fetch(p, { redirect: "error", headers: desktopCallerHeaders(), ...{ ...init } });')).toEqual([`1:fetch:${UNPROVEN}`]);
      expect(scan('fetch(p, { redirect: "error", headers: desktopCallerHeaders(), ...(cond ? { redirect: "follow" } : {}) });')).toEqual(['1:fetch:redirect: "follow"']);
      expect(scan('const init = { redirect: "follow" };\nfetch(p, { redirect: "error", headers: desktopCallerHeaders(), ...{ a: 1, ...init } });')).toEqual(['2:fetch:redirect: "follow"']);
    });
    it("Astra: redirect nested inside headers is not a request-level refusal", () => {
      expect(scan('fetch(p, { headers: { ...desktopCallerHeaders(), redirect: "error" } });')).toEqual([`1:fetch:${MISSING_WHY}`]);
    });
    it("Astra: window.fetch and globalThis.fetch are requests", () => {
      expect(scan("window.fetch(p, { headers: desktopCallerHeaders() });")).toEqual([`1:fetch:${MISSING_WHY}`]);
      expect(scan("globalThis.fetch(p, { headers: desktopCallerHeaders() });")).toEqual([`1:fetch:${MISSING_WHY}`]);
    });
    it("Astra: a renamed producer import still carries the proof", () => {
      expect(scan('import { desktopCallerHeaders as proof } from "./live-events";\nfetch(p, { headers: proof() });')).toEqual([`2:fetch:${MISSING_WHY}`]);
      expect(scan('const { desktopSurfaceHeaders: h } = await import("./live-events");\nfetch(p, { headers: { "x-murage-surface": "desktop", ...h() } });')).toEqual([`2:fetch:${MISSING_WHY}`]);
    });
    it("Astra: headers copied through two variables still carry the proof", () => {
      expect(scan("const a = desktopCallerHeaders();\nconst b = a;\nfetch(p, { headers: b });")).toEqual([`3:fetch:${MISSING_WHY}`]);
      expect(scan("const a = desktopCallerHeaders();\nconst b = { ...a, x: 1 };\nconst init = { headers: b };\nfetch(p, init);")).toEqual([`4:fetch:${MISSING_WHY}`]);
    });
    it("follows aliases, injected fetches, Request objects, EventSource and wrapper producers", () => {
      expect(scan("const call = o.fetchImpl ?? fetch;\nawait call('/t', { headers: desktopCallerHeaders() });")).toEqual([`2:fetch:${MISSING_WHY}`]);
      expect(scan("async function f(fetchImpl = fetch) {\n  await fetchImpl(p, { headers: desktopCallerHeaders() });\n}")).toEqual([`2:fetch:${MISSING_WHY}`]);
      expect(scan("(opts.fetchImpl ?? fetch)(p, { headers: desktopCallerHeaders() });")).toEqual([`1:fetch:${MISSING_WHY}`]);
      expect(scan("const go = window.fetch.bind(window);\ngo(p, { headers: desktopCallerHeaders() });")).toEqual([`2:fetch:${MISSING_WHY}`]);
      expect(scan("new Request(p, { headers: desktopCallerHeaders() });")).toEqual([`1:Request:${MISSING_WHY}`]);
      expect(scan("const r = new Request(p, { headers: desktopCallerHeaders(), redirect: 'error' });\nfetch(r);")).toEqual(["1:Request:ok", "2:fetch:ok"]);
      expect(scan("const r = new Request(p, { headers: desktopCallerHeaders(), redirect: 'error' });\nfetch(r, { redirect: 'follow' });")).toEqual(["1:Request:ok", '2:fetch:redirect: "follow"']);
      expect(scan("new EventSource(`/api/events?${new URLSearchParams(desktopCallerHeaders())}`);")).toEqual(["1:EventSource:EventSource cannot refuse a redirect: it must never carry the proof"]);
      expect(scan("function proofHeaders() {\n  return { 'x-murage-surface': 'desktop', ...desktopSurfaceHeaders() };\n}\nfetch(p, { headers: proofHeaders() });")).toEqual([`4:fetch:${MISSING_WHY}`]);
      expect(scan("const h = {};\nh[SURFACE_SECRET_HEADER] = s;\nfetch(p, { headers: h });")).toEqual([`3:fetch:${MISSING_WHY}`]);
      expect(scan("fetch(p, { headers: { 'x-murage-surface-secret': desktopSurfaceSecret } });")).toEqual([`1:fetch:${MISSING_WHY}`]);
      expect(scan("const o = { headers: () => ({ 'x-murage-surface-secret': s }) };\nfetch(u, { headers: options.headers() });")).toEqual([`2:fetch:${MISSING_WHY}`]);
      // headers handed in by a caller: the callee's request is judged on what its callers send
      expect(scan("function upload(file, headers) {\n  return fetch('/api/attachments', { method: 'POST', headers });\n}\nupload(f, desktopCallerHeaders());")).toEqual([`2:fetch:${MISSING_WHY}`]);
      expect(scan("const send = async ({ headers }) => fetch(u, { headers, redirect: 'error' });\nsend({ headers: desktopCallerHeaders() });")).toEqual(["1:fetch:ok"]);
    });
    it("accepts the refusal after every spread, and conditional spreads that cannot touch redirect", () => {
      expect(scan("fetch(p, { ...init, headers: desktopSurfaceHeaders(), redirect: 'error' });")).toEqual(["1:fetch:ok"]);
      expect(scan("fetch(p, ({ ...init, headers: desktopSurfaceHeaders(), redirect: \"error\" }));")).toEqual(["1:fetch:ok"]);
      expect(scan("fetch(p, { redirect: 'error', headers: { ...desktopCallerHeaders() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });")).toEqual(["1:fetch:ok"]);
      expect(scan("const mode = 'error';\nfetch(p, { headers: desktopCallerHeaders(), redirect: mode });")).toEqual(["2:fetch:ok"]);
      expect(scan("const init = { headers: desktopCallerHeaders(), redirect: 'error' };\nfetch(p, init);")).toEqual(["2:fetch:ok"]);
    });
    it("Astra r5: a parameter default is not what the caller supplies, and a mutated init is unresolved", () => {
      expect(scan('function send(init = { redirect: "error" }) {\n  return fetch("/api/x", { headers: desktopCallerHeaders(), ...init });\n}')).toEqual([`2:fetch:${UNPROVEN}`]);
      expect(scan('const init = { redirect: "error", headers: desktopCallerHeaders() };\ninit.redirect = "follow";\nfetch(p, init);')).toEqual([`3:fetch:${UNPROVEN}`]);
      expect(scan('const init = { redirect: "error", headers: desktopCallerHeaders() };\nObject.assign(init, other);\nfetch(p, init);')).toEqual([`3:fetch:${UNPROVEN}`]);
    });
    it("Astra r5: arguments bound into a fetch are judged", () => {
      expect(scan('const send = fetch.bind(null, "/api/x", { headers: desktopCallerHeaders() });\nsend();')).toEqual([`2:fetch:${MISSING_WHY}`]);
      expect(scan('const send = fetch.bind(null, "/api/x", { headers: desktopCallerHeaders(), redirect: "error" });\nsend();')).toEqual(["2:fetch:ok"]);
    });
    it("ignores requests that carry no proof", () => {
      expect(scan("fetch('/api/health');")).toEqual([]);
      expect(scan("fetch(p, { headers: { 'content-type': 'application/json' } });")).toEqual([]);
    });
  });
});

describe("the proof never rides in a URL (AST, src/ and electron/)", () => {
  it("no source builds a URL with the proof", () => {
    const found = ALL_INDEXES().flatMap((index) => {
      const lines = index.sf.text.split("\n");
      return proofInUrls(index).filter((hit) => !URL_ALLOW.some((entry) => entry.file === index.file && (lines[hit.line - 1] ?? "").includes(entry.needle)));
    });
    expect(found.map((f) => `${f.file}:${f.line} ${f.why}`), "a URL-loaded resource asks for a single-use ticket (ticketedResourceUrl in src/lib/live-events.ts)").toEqual([]);
  });

  it("the allow list still matches", () => {
    for (const entry of URL_ALLOW) expect(readFileSync(join(ROOT, entry.file), "utf8")).toContain(entry.needle);
  });

  describe("the scanner itself", () => {
    const urls = (source: string) => proofInUrls(source).map((f) => `${f.line}:${f.why}`).sort();
    it("flags every way the old code put the proof in a URL", () => {
      expect(urls("params.set(SURFACE_SECRET_QUERY, desktopSecret);")).toEqual(["1:a query parameter set to the proof", "1:the proof's query parameter name"]);
      expect(urls('new URLSearchParams({ surface: "desktop", surfaceSecret: desktopSecret });')).toEqual(["1:URLSearchParams built with the proof"]);
      expect(urls("const u = `/api/a?surface=desktop&surfaceSecret=${desktopSecret}`;")).toEqual(["1:a URL string with the proof's query parameter", "1:a template string with the proof in it"].sort());
      expect(urls('const u = "/api/a?s=" + desktopSurfaceSecret;')).toEqual(["1:a string concatenated with the proof"]);
      expect(urls("const s = await ensureDesktopSurfaceSecret();\nurl.searchParams.append('p', s);")).toEqual(["2:a query parameter set to the proof"]);
      expect(urls("const u = `${base}?k=${window.muragebox.desktopSurfaceSecret}`;")).toEqual(["1:a template string with the proof in it"]);
    });
    it("Astra r5: an aliased import of the secret getter is still the proof", () => {
      expect(urls('import { desktopSurfaceSecret as getProof } from "./live-events";\nconst url = "/api/events?p=" + getProof();')).toEqual(["2:a string concatenated with the proof"]);
    });
    it("accepts the proof in a header", () => {
      expect(urls("headers.set(SURFACE_SECRET_HEADER, desktopSecret);")).toEqual([]);
      expect(urls("const h = { [SURFACE_SECRET_HEADER]: desktopSecret };")).toEqual([]);
      expect(urls('const h = { "x-murage-surface-secret": desktopSurfaceSecret };')).toEqual([]);
      expect(urls("const u = `${base}?${new URLSearchParams({ surfaceTicket: ticket })}`;")).toEqual([]);
    });
  });
});

describe("the AST index on every OS", () => {
  it("finds a file named with Windows separators (TypeScript names every file with /)", () => {
    const name = "C:\\repo\\src\\lib\\proof-probe.ts";
    const program = buildProgram(new Map([[name, "export const probe = (proof: string) => proof;"]]));
    expect(sourceFileOf(program, name).text).toContain("export const probe");
    expect(indexFile(sourceFileOf(program, name), program.getTypeChecker(), "lib/proof-probe.ts").params.size).toBe(1);
  });
});
