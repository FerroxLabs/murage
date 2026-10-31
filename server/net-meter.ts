// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IncomingMessage, ServerResponse } from "node:http";

// What crossed the app's HTTP port this minute, by route and by stream frame kind, for the io-budget line (LOG-CPU-LINEAGE).
// Counts and bytes only. Nothing here sees a body, and a label is made of fixed words: a url word outside the route table comes out as `:x`, a
// frame kind outside the list as `other`, so an id, a name, a path or a query value has no way onto the line. Two Map updates per request or
// frame, one sort a minute, at most NET_MAX_LABELS rows: the cost does not grow with history or with how long the app has been open.
// A route's bytes are its socket's between request and close, so requests pipelined on one socket would share; browsers do not pipeline.

/** The most rows kept per table in one minute. Anything new past this folds into `other`. */
export const NET_MAX_LABELS = 48;
/** A minute above this gets a line of its own even when the CPU and write watchdogs are calm (5 MB/s). */
export const NET_LINE_BYTES_PER_MINUTE = 300 * 1048576;
const NET_TOP = 5;
const OTHER = "other";

/** Every literal word in a route of this server. A word missing here costs detail (`:x`), never privacy: add it when a new route matters. */
const ROUTE_WORDS = new Set(`
  about-me accept access access-request account accounts action active active-branch activity agents announcements api approve artifacts ask ask-bot
  ask-revoke ask-user assets attachments authorize automation-admission avatar backup backup-failure-notice backup-restart backup-waiting board bot-keys
  bot-management bots box brief browse browser browser-extension browser-setup budget cached calendar-calls call call-note calls cancel cards catalog
  challenge chats check check-delegation checkpoints claude-update cleanup cli-candidates cli-test clients cloud columns computer computer-activity
  computer-control config confirm connected connector-cards connectors control copy create-bot decisions delegate-bot delegations delete
  deletion-preview deletions desktop desktop-secret device devices diagnostics directory discord dismiss door-state drain edit email enable
  engine-commands engine-management engine-setup-command enter events export files flux-connection flux-memory folder-trust follow-model foreground
  forget general-notes generate generate-image get github goals grok groups headless-browser health held-continuations hermes history hold host-computer
  house-rules image image-models image-prompt-block image-prompt-blocks image-reference-pack image-reference-packs images import inbox incident inspect
  instances instructions intake internal interrupt issues jobs join learning-paused leave library limit-backup link linux-sandbox list local-computer
  mcp mcp-enable-cards mcp-grants mcp-remote mcp-servers mcp-sign-in-cards members memory message-allow messages minted mobile model-gateway
  model-signins models mutate needs-owner-now needs-reconnect netlify new-options news off-today offered open-cards opencode outcome-proposals owed
  own-server owner packages page pair pairing permission-status permissions phones prepare presence probe profile profiles project projects
  prompt-blocks proposal propose propose-correction provider-connections publish publish-site push queue reactions read read-messages rearm reclaim
  recovery refresh register register-artifact release remove rename reopen replace repo report request request-browser-connection request-credential
  requests reset resolve-image-reference resource-ticket respond restore restore-holds resume retry revision revoke revoke-sessions rollback room
  routine routine-requests routine-runs routines rules run save scan-progress scout screenshot search secret-cards section-context seen seen-all self
  sends sentinel servers sessions settings setup shapes share shared-results sharing show-widget sidebar-sections skills slack speak stage start-task
  starter-profiles state status stdio stop stop-line-allowance storage stream subscribe suggest summary take-down-site targets tasks team-library
  team-map team-sections teams telegram terms test thread-list thread-read thread-search thread-snoozes threads ticket timezone token tool-result topics
  transcribe tray tts turn-end typing unified-browser unlink update-widget usage v0 v1 venue version versions viewed voice voice-host voice-note voices
  vps-mcp wait-delegation warm watch-files watch-proposal web-search webhooks whats-new whatsapp widgets work-profile work-roots work-threads workspace
`.trim().split(/\s+/));
/** The words a route follows with a name of its own (`/api/bots/<id>/read`): the next segment is never kept, even when it spells a route word, as a
 * bot called `hermes` or a file called `report` would. Taken from the route patterns. A static word after one of these comes out as `:x` too: detail is what gives way, never privacy. */
const NAMED_AFTER = new Set(`
  accounts artifacts attachments attempts bindings bot-keys bots browser-setup calendar-calls calls cards cloud collection computer connector-cards
  connectors control delegations devices email engine-management goals groups held-continuations image images instances local-computer mcp-enable-cards
  mcp-grants mcp-remote mcp-sign-in-cards memory messages model-gateway model-signins other-setups packages project prompt-blocks provider-connections
  queue reference-packs requests restore-holds routine-runs routines secret-cards sends sentinel servers sessions setup shared-results skills tasks
  teams threads topics v1 versions webhooks whatsapp widgets
`.trim().split(/\s+/));
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
/** What `view=` tells apart on the roster and thread routes: the boot roster against a thread opening. */
const KNOWN_VIEW = /[?&]view=(sidebar|switch)(?:[&#]|$)/;
const MAX_SEGMENTS = 8;
const FRAME_KINDS = new Set(`bot bot.deleted call computer computer-control config deletion-owed group group.deleted inbox.changed learning.improved learning.remembered memory.waiting message message.patch notify open-cards.ready project.board project.strip replay room.requests routine routine.deleted routine.run routine.run.deleted runtime screen screen.unavailable sends sidebar.order thread webhook webhook.attempt webhook.deleted`.split(" "));

/** `METHOD /api/bots/:x/read`: fixed words only, whatever the request said. */
export function routeLabel(method: string | undefined, url: string | undefined): string {
  const verb = method && METHODS.has(method) ? method : "OTHER";
  const raw = url ?? "/";
  const end = raw.search(/[?#]/);
  const segments = (end < 0 ? raw : raw.slice(0, end)).split("/").slice(1, MAX_SEGMENTS + 1);
  // Fails closed: the segment after a named collection is a name whatever it spells, and once a segment is neither a name nor a known word
  // the route is unknown from there on, so nothing after it is kept either.
  let unknown = false;
  const path = segments.map((part, index) => {
    if (part === "") return "";
    if (unknown) return ":x";
    if (NAMED_AFTER.has(segments[index - 1] ?? "")) return ":x";
    if (ROUTE_WORDS.has(part) || NAMED_AFTER.has(part)) return part;
    unknown = true;
    return ":x";
  }).join("/");
  const view = end < 0 ? null : KNOWN_VIEW.exec(raw.slice(end));
  return `${verb} /${path}${view ? `?view=${view[1]}` : ""}`;
}

export interface NetRow { label: string; n: number; bytes: number }
export interface NetMinute { outBytes: number; routes: NetRow[]; frames: NetRow[] }

function note(table: Map<string, NetRow>, label: string, bytes: number): void {
  const row = table.get(label);
  if (row) { row.n++; row.bytes += bytes; return; }
  if (label !== OTHER && table.size >= NET_MAX_LABELS + (table.has(OTHER) ? 1 : 0)) { note(table, OTHER, bytes); return; }
  table.set(label, { label, n: 1, bytes });
}

/** The largest by bytes, and the busiest by count when bytes left it out: a storm of small answers is a finding too. */
function top(table: Map<string, NetRow>): NetRow[] {
  const rows = [...table.values()].sort((a, b) => b.bytes - a.bytes || b.n - a.n);
  const kept = rows.slice(0, NET_TOP);
  const busiest = rows.slice(NET_TOP).sort((a, b) => b.n - a.n)[0];
  if (busiest && busiest.n > kept[kept.length - 1]!.n) kept.push(busiest);
  return kept;
}

export class NetMeter {
  private routes = new Map<string, NetRow>();
  private frames = new Map<string, NetRow>();
  private outBytes = 0;

  /** One answered request: its `routeLabel` and the bytes written for it. */
  noteRoute(label: string, bytes: number): void { try { this.outBytes += bytes; note(this.routes, label, bytes); } catch { /* a meter never reaches a request */ } }
  /** One stream frame, `bytes` being what the open streams accepted. */
  noteFrame(kind: string, bytes: number): void { try { this.outBytes += bytes; note(this.frames, FRAME_KINDS.has(kind) ? kind : OTHER, bytes); } catch { /* a meter never reaches a broadcast */ } }
  /** Rows held right now (tests). */
  size(): number { return this.routes.size + this.frames.size; }
  /** The minute's top rows; the counters start over. */
  take(): NetMinute {
    const minute = { outBytes: this.outBytes, routes: top(this.routes), frames: top(this.frames) };
    this.routes = new Map(); this.frames = new Map(); this.outBytes = 0;
    return minute;
  }
}

const megabytes = (bytes: number) => (bytes / 1048576).toFixed(1);
const rows = (list: NetRow[]) => list.map(row => `${row.label} n=${row.n} ${megabytes(row.bytes)}MB`).join(", ") || "none";
/** The line's text for one minute, or "" when nothing crossed the port. */
export function netText(minute: NetMinute, ms: number): string {
  if (minute.outBytes <= 0 && !minute.routes.length && !minute.frames.length) return "";
  return `net last ${Math.round(ms / 1000)}s: out ${megabytes(minute.outBytes)} MB; routes: ${rows(minute.routes)}; frames: ${rows(minute.frames)}`;
}

/** The process-wide meter: index.ts feeds it, the io watchdog reads it once a minute. */
export const netMeter = new NetMeter();

/** One answered request on the minute's counters. The stream counts its opens here (a reconnect loop shows as a count) and its bytes frame by frame.
 * `close` ends every response, a cut-off one too; the socket is read through `req`, as the response has let go of it by then. It lives here, not in
 * index.ts: route discovery reads the first LOCAL function the server's listener calls as the dispatcher. */
export function meterResponse(req: IncomingMessage, res: ServerResponse): void {
  try {
    const label = routeLabel(req.method, req.url);
    if (label === "GET /api/events" || label.startsWith("GET /api/events?")) return netMeter.noteRoute(label, 0);
    const socket = req.socket, before = socket.bytesWritten;
    res.once("close", () => netMeter.noteRoute(label, Math.max(0, socket.bytesWritten - before)));
  } catch { /* a meter never reaches a request */ }
}
