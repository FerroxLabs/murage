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
// URL-loaded resources (<img src>, new Image().src) cannot set a header: the
// harness reads the same proof from the query string, so those sinks must go
// through desktopResourceUrl().
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The markers that mean a request carries (or is built from) the proof. */
const PROOF_WHOLE = /desktopCallerHeaders|callRouteHeaders|desktopHeaders|liveEventsUrl|desktopResourceUrl|\bticket\b/;
/** The secret alone is not the proof: the harness needs the surface mark with it. */
const carriesProof = (text: string) => PROOF_WHOLE.test(text) || ((/desktopSurfaceHeaders/.test(text) || /\.\.\.surfaceHeaders\b/.test(text)) && /x-murage-surface["']?\s*:|SURFACE_HEADER/.test(text));

/** Raw requests the policy leaves open or that the proof cannot apply to. */
const ALLOW: ReadonlyArray<{ file: string; needle: string; why: string }> = [
  { file: "lib/live-events.ts", needle: "DEV_SECRET_PATH", why: "GET /api/desktop-secret is a health route: it hands the secret over, so it cannot carry it (dev launches only)" },
  { file: "lib/live-events.ts", needle: "NativeEventSource(", why: "the URL comes from liveEventsUrl(), which puts the surface mark and secret in the query" },
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
// (anything under /api/) must go through desktopResourceUrl(), or the harness
// answers 404 "no such route". EventSource and WebSocket are covered above.

/** A URL expression that is wrapped, or is a helper that wraps it. */
const RESOURCE_PROOF = /desktopResourceUrl|liveEventsUrl/;
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
    const failures = sourceFiles(SRC).flatMap((path) => findUnprovenApiRequests(readFileSync(path, "utf8"), relative(SRC, path)));
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
      expect(flagSinks(`const api = ${api};\nconst a = <img src={desktopResourceUrl(api + "/x")} alt="" />;`)).toEqual([]);
      expect(flagSinks(`const a = <img src={api + "/x"} alt="" />;\nconst b = <img src={desktopResourceUrl(api + "/x")} alt="" />;`)).toEqual(["img:1"]);
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
      expect(flagSinks("const i = new Image();\ni.src = desktopResourceUrl(`/api/screen/${id}`);")).toEqual([]);
      expect(flagSinks("const a = new Audio(desktopResourceUrl(`/api/tts/${id}`));")).toEqual([]);
      expect(flagSinks('const a = <img src="data:image/png;base64,AAA" alt="" />;')).toEqual([]);
      expect(flagSinks('const a = <img src={`blob:${x}`} alt="" />;\nconst b = <img src="https://cdn.example.com/a.png" alt="" />;')).toEqual([]);
      expect(flagSinks('import hero from "./hero.png";\nconst a = <img src={hero} alt="" />;')).toEqual([]);
      expect(flagSinks("const s = `url(#${uid}-grad)`;")).toEqual([]);
    });
    it("sees a src, href or poster handed to a media element through an object spread", () => {
      expect(flagSinks('const shared = { controls: true, src: api + "/x" };\nconst a = <video {...shared} />;')).toEqual(["video {...shared}.src:1"]);
      expect(flagSinks('const shared = { controls: true, src: desktopResourceUrl(api + "/x") };\nconst a = <video {...shared} />;')).toEqual([]);
      expect(flagSinks("const shared = {\n  poster: `/api/p/${id}`,\n};\nconst a = <video {...shared} />;")).toEqual(["video {...shared}.poster:2"]);
      expect(flagSinks('const shared = { src: "data:audio/wav;base64,AAA" };\nconst a = <audio {...shared} />;')).toEqual([]);
    });
    it("sees setAttribute for src, href and poster", () => {
      expect(flagSinks('el.setAttribute("src", `/api/media/${id}`);')).toEqual(["setAttribute(src):1"]);
      expect(flagSinks("el.setAttribute('poster', api + \"/p\");")).toEqual(["setAttribute(poster):1"]);
      expect(flagSinks('link.setAttribute("href", `/api/x/${id}`);')).toEqual(["setAttribute(href):1"]);
      expect(flagSinks('el.setAttribute("src", desktopResourceUrl(`/api/media/${id}`));')).toEqual([]);
      expect(flagSinks('el.setAttribute("href", "https://example.com/a");\nel.setAttribute("class", `/api/x`);')).toEqual([]);
    });
    it("still flags a real wrapped source once its desktopResourceUrl is removed", () => {
      for (const file of ["components/Avatar.tsx", "components/ImageMedia.tsx", "components/ComposerAttachments.tsx", "components/CallAura.tsx"]) {
        const real = readFileSync(join(SRC, file), "utf8");
        expect(findUnprovenResourceSinks(real, file), `${file} as shipped`).toEqual([]);
        const stripped = real.replace(/desktopResourceUrl\(/g, "String(");
        expect(findUnprovenResourceSinks(stripped, file).length, `${file} with the wrapper removed`).toBeGreaterThan(0);
      }
    });
    it("scans the real sources and finds no harness URL loaded without desktopResourceUrl", () => {
      const failures = sourceFiles(SRC).flatMap((path) => findUnprovenResourceSinks(readFileSync(path, "utf8"), relative(SRC, path)));
      expect(
        failures.map((f) => `src/${f.file}:${f.line} ${f.kind} loads a URL with no desktop proof: ${f.excerpt}`),
        "Wrap the URL in desktopResourceUrl() (src/lib/live-events.ts); a browser-loaded /api URL without it is answered 404 no such route",
      ).toEqual([]);
    });
  });

  describe("URL-loaded resources carry the proof in the query", () => {
    const read = (file: string) => readFileSync(join(SRC, file), "utf8");
    it.each([
      ["components/ImageMedia.tsx", 3],
      ["components/ComposerAttachments.tsx", 1],
      ["components/Avatar.tsx", 1],
      ["components/CallAura.tsx", 1],
    ])("%s wraps its /api image sources in desktopResourceUrl", (file, count) => {
      expect((read(file).match(/desktopResourceUrl\(/g) ?? []).length).toBeGreaterThanOrEqual(count);
    });
    it("no component uploads through the shared parser's unproven default", () => {
      const offenders = sourceFiles(join(SRC, "components")).filter((path) => /import\s*\{[^}]*\bimageAttachmentFromFile\b[^}]*\}\s*from\s*["']@\/lib\/composer-attachments["']/.test(readFileSync(path, "utf8")));
      expect(offenders.map((path) => relative(SRC, path))).toEqual([]);
    });
  });
});
