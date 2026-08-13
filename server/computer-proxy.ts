// computer-proxy — a minimal MCP stdio server the claude CLI spawns
// (agentcal's permission-proxy pattern, dedicated entry file so there is
// no argv-dispatch fork-bomb hazard). It gives the agent its bot's cloud
// computer (box.ascii.dev) as CUA-grade tools.
//
// Transport: every action goes through the box's REST run-command
// endpoint (no inbound port on the box, no tunnel). On the box, actions
// prefer the CUA computer-server on loopback :8000 (trycua
// cua-computer-server, installed by the provision bootstrap; raw XTEST
// under the hood) and fall back to xdotool/scrot — the same primitives
// CUA itself uses on Linux.
//
// stdout is the MCP channel — never console.log here.
import { normalizeCrop, ObservationCoordinator, parseBrowserTargets, safeBrowserUrl } from "./computer-observation.ts";

const BOX_API = "https://ascii.dev/api/box/v1";
const boxId = process.env.OGB_BOX_ID ?? "";
const token = process.env.OGB_BOX_TOKEN ?? "";

async function runOnBox(command: string, timeoutMs = 60_000) {
  const res = await fetch(`${BOX_API}/boxes/${boxId}/commands`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body: any = await res.json().catch(() => null);
  return {
    ok: res.ok && body?.exitCode === 0,
    exitCode: body?.exitCode ?? null,
    stdout: body?.stdout ?? "",
    stderr: body?.stderr ?? "",
  };
}

/** Run a CUA computer-server command on the box's loopback; returns the
 * parsed JSON payload, or null when the server isn't up (→ fallback). */
async function cuaCmd(command: string, params: Record<string, unknown>, timeoutMs = 30_000) {
  const payload = JSON.stringify({ command, params }).replace(/'/g, "'\\''");
  const out = await runOnBox(
    `curl -sf -m ${Math.floor(timeoutMs / 1000)} -X POST http://127.0.0.1:8000/cmd -H 'Content-Type: application/json' -d '${payload}'`,
    timeoutMs + 15_000,
  );
  if (!out.ok || !out.stdout.trim()) return null;
  const line = out.stdout.split("\n").find((l: string) => l.startsWith("data: "));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(6));
    return parsed?.success === false ? null : parsed;
  } catch {
    return null;
  }
}

const X = "export DISPLAY=${DISPLAY:-:0}; ";

// capture to a file on the box, read back via the files API — base64 over
// command stdout corrupts (probed 2026-08-12), never ship binary that way
const SHOT_WIDTH = 1280;
const observations = new ObservationCoordinator();

function metricsText() {
  return JSON.stringify(observations.metrics);
}

async function browserTargets() {
  // Chrome's DevTools target list is structured state: titles/URLs tell an
  // agent whether navigation happened without burning a screenshot. It is
  // intentionally best-effort; ordinary desktop use still works without CDP.
  const out = await runOnBox("curl -sf --max-time 2 http://127.0.0.1:9222/json/list", 5_000);
  const targets = out.ok ? parseBrowserTargets(out.stdout) : [];
  if (targets.length) observations.noteStructuredObservation();
  return targets;
}

async function waitForNavigation(url: string, attempts = 3) {
  const expected = safeBrowserUrl(url);
  let targets: Awaited<ReturnType<typeof browserTargets>> = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) {
      observations.noteRetry();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    targets = await browserTargets();
    if (!expected || targets.some((target) => target.url === expected)) {
      observations.noteVerification(true);
      return { ok: true, targets };
    }
  }
  observations.noteVerification(false);
  return { ok: false, targets };
}
const SHOT_CMD = [
  "export DISPLAY=${DISPLAY:-:0}",
  "f=/tmp/ogb-shot.png",
  'scrot -o "$f" 2>/dev/null || import -window root "$f" 2>/dev/null || ffmpeg -y -f x11grab -i "$DISPLAY" -frames:v 1 "$f" >/dev/null 2>&1',
  `command -v convert >/dev/null && convert "$f" -resize ${SHOT_WIDTH}x "$f" 2>/dev/null || true`,
  'test -s "$f" && echo captured',
].join("; ");

// real display size, fetched once per proxy lifetime (per turn)
let geometryCache: { width: number; height: number } | null | undefined;
async function displayGeometry() {
  if (geometryCache !== undefined) return geometryCache;
  const out = await runOnBox(`${X}xdotool getdisplaygeometry`);
  const m = out.stdout.trim().match(/^(\d+)\s+(\d+)/);
  geometryCache = m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  return geometryCache;
}

async function readBoxFile(path: string): Promise<string | null> {
  const res = await fetch(
    `${BOX_API}/boxes/${boxId}/files?path=${encodeURIComponent(path)}&encoding=base64`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) },
  );
  const body: any = await res.json().catch(() => null);
  const content = body?.content;
  return res.ok && typeof content === "string" && content ? content : null;
}

const send = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const text = (id: unknown, t: string, isError = false) =>
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) } });

const TOOLS = [
  {
    name: "screenshot",
    description:
      "See the bot's cloud computer only when visual state is needed. First use browser_state for Chrome navigation/title/URL checks; repeated stable reads reuse a verified frame, and unchanged pixels return text instead of another image.",
    inputSchema: {
      type: "object",
      properties: {
        force: { type: "boolean", description: "Capture even when no computer action has marked the screen dirty." },
        region: {
          type: "object",
          description: "Optional screenshot-space crop within the 1280px-wide observation.",
          properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
          required: ["x", "y", "width", "height"],
        },
      },
    },
  },
  {
    name: "browser_state",
    description: "Read safe structured Chrome state (page titles and URLs with query strings removed) through local DevTools. Use before screenshots to verify navigation and identify the current page.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "wait_for_navigation",
    description: "Boundedly verify Chrome reached an http(s) URL using structured DevTools state. Retries at most three times.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "observation_metrics",
    description: "Return this turn's screenshot, structured-observation, action, retry, and verification metrics.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "click",
    description:
      "Click on the computer's screen. Use pixel coordinates as they appear in the most recent screenshot — scaling to the real display resolution is handled for you.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right"], description: "default left" },
        double: { type: "boolean", description: "double-click" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "type_text",
    description: "Type text at the current focus on the computer.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "press_key",
    description:
      'Press a key or chord on the computer, xdotool syntax: "Return", "Tab", "ctrl+c", "alt+F4", "ctrl+shift+t".',
    inputSchema: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"] },
  },
  {
    name: "scroll",
    description: "Scroll the computer screen up or down by N clicks.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        clicks: { type: "number", description: "default 3" },
      },
      required: ["direction"],
    },
  },
  {
    name: "computer_exec",
    description:
      "Run a shell command on the bot's cloud computer (Linux, passwordless sudo, X11 desktop). Returns stdout/stderr/exit code.",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "open_url",
    description: "Open a URL in the computer's own Chrome and boundedly verify navigation through structured browser state before requesting a screenshot.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
];

async function call(id: unknown, name: string, args: any) {
  if (name === "screenshot") {
    const force = args.force === true;
    if (!observations.needsCapture(force)) return text(id, `screen unchanged since the last verified observation; no screenshot captured or sent. metrics: ${metricsText()}`);
    const crop = args.region === undefined ? null : normalizeCrop(args.region, SHOT_WIDTH);
    if (args.region !== undefined && !crop) return text(id, "region must be a bounded x,y,width,height crop within the 1280px-wide screenshot", true);
    const cropCommand = crop ? `; convert "$f" -crop ${crop.width}x${crop.height}+${crop.x}+${crop.y} +repage "$f" 2>/dev/null || true` : "";
    const out = await runOnBox(`${SHOT_CMD}${cropCommand}`, 60_000);
    if (!/captured/.test(out.stdout)) {
      return text(id, `screenshot failed: ${out.stderr.slice(0, 200) || "capture produced no file"}`, true);
    }
    const data = await readBoxFile("/tmp/ogb-shot.png");
    if (!data) return text(id, "screenshot failed: could not read the frame back", true);
    const observed = observations.observeFrame(data, crop);
    if (!observed.changed) return text(id, `screen pixels are unchanged after the action; no image sent. metrics: ${metricsText()}`);
    return send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: `${crop ? "cropped" : "full-screen"} observation captured. metrics: ${metricsText()}` }] },
    });
  }
  if (name === "browser_state") {
    const targets = await browserTargets();
    return text(id, targets.length ? `Structured browser state:\n${targets.map((target) => `- ${target.title || "Untitled"}: ${target.url}`).join("\n")}\nmetrics: ${metricsText()}` : "Structured browser state unavailable. Use screenshot only if visual state is necessary.");
  }
  if (name === "wait_for_navigation") {
    const url = String(args.url ?? "");
    if (!safeBrowserUrl(url)) return text(id, "wait_for_navigation needs an http(s) URL", true);
    const result = await waitForNavigation(url);
    return text(id, result.ok ? `navigation verified: ${safeBrowserUrl(url)}. metrics: ${metricsText()}` : `navigation not verified after 3 checks. Current structured state: ${result.targets.map((target) => target.url).join(", ") || "unavailable"}. Use screenshot only if needed. metrics: ${metricsText()}`, !result.ok);
  }
  if (name === "observation_metrics") return text(id, metricsText());
  if (name === "click") {
    const x = Math.round(Number(args.x));
    const y = Math.round(Number(args.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return text(id, "click needs numeric x,y", true);
    // screenshot space is 1280 wide (files-API capture is downscaled) but
    // the real display can be larger — scale uniformly by width or clicks
    // land short (probed live: 1920×1080 display, 1280×720 screenshots,
    // every raw click 1.5× off). xdotool only; CUA's own scaler assumes a
    // different (1280×800) API space and would double-convert.
    const geometry = await displayGeometry();
    const scale = geometry ? geometry.width / SHOT_WIDTH : 1;
    const sx = Math.round(x * scale);
    const sy = Math.round(y * scale);
    const btn = args.button === "right" ? 3 : 1;
    const rep = args.double ? "--repeat 2 --delay 150 " : "";
    const out = await runOnBox(`${X}xdotool mousemove ${sx} ${sy} click ${rep}${btn}`);
    if (!out.ok) return text(id, `click failed: ${out.stderr.slice(0, 200)}`, true);
    observations.noteAction();
    return text(
      id,
      `clicked ${x},${y}${scale !== 1 ? ` (scaled to ${sx},${sy} on the ${geometry!.width}x${geometry!.height} display)` : ""}${args.double ? " (double)" : ""}${args.button === "right" ? " (right)" : ""} — screenshot to verify`,
    );
  }
  if (name === "type_text") {
    const t = String(args.text ?? "");
    if (!t) return text(id, "nothing to type", true);
    const cua = await cuaCmd("type_text", { text: t });
    if (!cua) {
      const safe = t.replace(/'/g, "'\\''");
      const out = await runOnBox(`${X}xdotool type --delay 12 '${safe}'`);
      if (!out.ok) return text(id, `type failed: ${out.stderr.slice(0, 200)}`, true);
    }
    observations.noteAction();
    return text(id, `typed ${t.length} chars`);
  }
  if (name === "press_key") {
    const keys = String(args.keys ?? "").replace(/[^\w+]/g, "");
    if (!keys) return text(id, "press_key needs keys", true);
    const out = await runOnBox(`${X}xdotool key ${keys}`);
    if (!out.ok) return text(id, `key failed: ${out.stderr.slice(0, 200)}`, true);
    observations.noteAction();
    return text(id, `pressed ${keys}`);
  }
  if (name === "scroll") {
    const clicks = Math.min(Math.max(Math.round(Number(args.clicks) || 3), 1), 20);
    const command = args.direction === "up" ? "scroll_up" : "scroll_down";
    const cua = await cuaCmd(command, { clicks });
    if (!cua) {
      const btn = args.direction === "up" ? 4 : 5;
      const out = await runOnBox(`${X}xdotool click --repeat ${clicks} ${btn}`);
      if (!out.ok) return text(id, `scroll failed: ${out.stderr.slice(0, 200)}`, true);
    }
    observations.noteAction();
    return text(id, `scrolled ${args.direction} ${clicks}`);
  }
  if (name === "computer_exec") {
    const out = await runOnBox(String(args.command ?? "").slice(0, 4000), 120_000);
    observations.noteAction();
    return text(
      id,
      `exit ${out.exitCode}\n${out.stdout.slice(-6000)}${out.stderr ? `\n[stderr]\n${out.stderr.slice(-2000)}` : ""}`,
    );
  }
  if (name === "open_url") {
    const url = String(args.url ?? "");
    if (!/^https?:\/\//.test(url)) return text(id, "only http(s) URLs", true);
    const q = url.replace(/'/g, "%27");
    await runOnBox(
      `${X}(google-chrome --user-data-dir=/tmp/omb-chrome --no-first-run --remote-debugging-port=9222 '${q}' || chromium --user-data-dir=/tmp/omb-chrome --no-first-run --remote-debugging-port=9222 '${q}' || chromium-browser --user-data-dir=/tmp/omb-chrome --no-first-run --remote-debugging-port=9222 '${q}' || xdg-open '${q}') >/dev/null 2>&1 & sleep 2; echo opened`,
      30_000,
    );
    observations.noteAction();
    const verification = await waitForNavigation(url, 3);
    if (verification.ok) return text(id, `opened and navigation verified: ${safeBrowserUrl(url)}. Prefer browser_state before a screenshot. metrics: ${metricsText()}`);
    return text(id, `opened ${safeBrowserUrl(url)}, but structured navigation was not verified. Use browser_state or a screenshot if visual state is necessary. metrics: ${metricsText()}`);
  }
  return text(id, `unknown tool ${name}`, true);
}

async function handle(msg: any) {
  if (msg.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "openmausbot-computer", version: "2" },
      },
    });
  }
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  if (msg.method === "tools/call") {
    try {
      return await call(msg.id, msg.params?.name, msg.params?.arguments ?? {});
    } catch (e) {
      return text(msg.id, `computer tool failed: ${(e as Error).message}`, true);
    }
  }
  if (String(msg.method ?? "").startsWith("notifications/")) return;
  if (msg.id != null) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      /* ignore malformed lines */
    }
  }
});
process.stdin.on("end", () => process.exit(0));
