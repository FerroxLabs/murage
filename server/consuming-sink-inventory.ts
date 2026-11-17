import { CONNECTED_APP_SOURCE_PATHS } from "../shared/connected-app-names.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** LASTRESORT r3.3 §§9–13. Registration is an exact destination capability,
 * never permission inherited from a filename, path prefix or matching id. */
export type ResponseMode = "body" | "chunk" | "headers" | "native" | "request";
export const RESPONSE_CLASSES = Object.freeze(["success", "validation", "authorization", "unknown-method", "exception", "empty", "tool-list", "local-help", "transport-failure", "asynchronous"] as const);
export const PROJECT_ROUTE_NAMES = Object.freeze(["assign", "review-assign", "accept", "card-manage", "brief-update", "summary-update", "criteria", "done", "blocked", "card-update", "bring-in", "suggest", "review-result", "read-messages"]);
export const EMAIL_ROUTE_NAMES = Object.freeze(["email_list", "email_read", "email_send", "email_reply", "email_trust_offer"]);
export interface SinkInventoryEntry {
  readonly id: string;
  readonly mode: ResponseMode;
  readonly destination: string;
  readonly bindingSource: string;
  readonly provenanceProducer: string;
  readonly provenanceContract: "explicit-per-response";
  /** Successful stored-content routes require their refs-bearing producer,
   * including an explicitly empty read. Local error copy remains permitted. */
  readonly storedContentProducer: boolean;
  readonly finalGate: "emitConsumingTurnResponse";
  readonly refusalHandler: "binding.onLedgerRefused";
  readonly b17: string;
  readonly symbol: string;
  readonly responseClasses: typeof RESPONSE_CLASSES;
  readonly isRegistered?: () => boolean;
}

// Exact HTTP methods. Method mismatches and unknown paths take fixed denial;
// they cannot inherit a successful route's provenance classification.
export const INTERNAL_HTTP_ROUTES = Object.freeze([
  ["POST", "project/propose", "ChiefProposalTurns", "23605"],
  ...["thread-search", "thread-list", "thread-read"].map(name => ["POST", `memory/${name}`, "threadRecallRoute", "23649"]),
  ...["search", "get", "save", "propose-correction"].map(name => ["POST", `memory/${name}`, "memoryAgentRoute", "23663"]),
  ...["register-artifact", "needs-owner-now", "voice-note", "stop-line-allowance", "publish-site", "take-down-site", "generate-image", "web-read", "web-search",
    "resolve-image-reference", "device/call", "highlevel/mcp", "host-computer", "unified-browser", "headless-browser", "venue/read-messages", "venue/post", "room-share/ask",
    "bot-management", "access-request", "permission-status", "outcome-proposals", "routine-requests", "skills/stage", "ask-bot", "delegate-bot", "create-bot",
    "request-browser-connection", "mcp-servers", "ask-user", "show-widget", "update-widget", "request-credential", "connectors/mcp", "computer-activity", "connectors/request"]
    .map(name => ["POST", name, "internal dispatch", "23589–25056"]),
  ...["image-models", "image-prompt-block", "agents", "routines", "skills"].map(name => ["GET", name, "internal dispatch", "23589–25056"]),
  ...["image-prompt-blocks", "image-reference-packs", "tool-result"].flatMap(name => ["GET", "POST"].map(method => [method, name, "toolJson/json", "22239–22257"])),
  ...["GET", "POST", "DELETE"].map(method => [method, "computer-control", "internal dispatch", "24979"]),
  ...["GET", "DELETE"].map(method => [method, "headless-browser", "headless browser authority and cleanup", "23589–25056"]),
] .map(([method, path, symbol, b17]) => Object.freeze({ method: method!, path: `/api/internal/${path}`, symbol: symbol!, b17: `server/index.ts:${b17}` })));

const entries = new Map<string, SinkInventoryEntry>();
const dynamicEntries = new Map<string, SinkInventoryEntry>();
function entry(id: string, mode: ResponseMode, destination: string, producer: string, b17: string, symbol: string): SinkInventoryEntry {
  const storedContentProducer = /^(?:POST \/api\/internal\/(?:memory\/(?:search|get|thread-search|thread-read|thread-list)|venue\/read-messages|project\/(?:read-messages|bring-in)|resolve-image-reference|ask-bot|delegate-bot)|GET \/api\/internal\/(?:image-prompt-blocks?|image-reference-packs|skills|tool-result|delegations\/[\w-]+))$/.test(destination);
  const item = Object.freeze({ id, mode, destination, bindingSource: "immutable admitted generation and concrete live members",
    provenanceProducer: producer, provenanceContract: "explicit-per-response" as const, storedContentProducer, finalGate: "emitConsumingTurnResponse" as const, refusalHandler: "binding.onLedgerRefused" as const, b17, symbol, responseClasses: RESPONSE_CLASSES });
  entries.set(id, item);
  return item;
}
for (const route of INTERNAL_HTTP_ROUTES) for (const mode of ["headers", "body", "chunk"] as const) {
  entry(`${route.method} ${route.path}:${mode}`, mode, `${route.method} ${route.path}`, route.symbol, route.b17, route.symbol);
}
// Existing pass-2 gateway callers retain exact ids; no arbitrary registration.
entry("gateway:headers", "headers", "model gateway HTTP response", "gateway provider response", "server/model-gateway.ts:231", "handleGatewayRequest");
entry("gateway:json-error-limit-done", "body", "model gateway HTTP response", "gateway provider response", "server/model-gateway.ts:55,65,275", "sendJson/handleGatewayRequest");
entry("gateway:sse", "chunk", "model gateway HTTP response", "gateway provider response", "server/model-gateway.ts:240,254", "handleGatewayRequest");
entry("gateway:upstream-request", "request", "provider HTTP request", "serialized provider request", "server/model-gateway.ts:120", "handleGatewayRequest");
entry("highlevel:rpc-response", "body", "HighLevelHost.handle JSON-RPC return", "HighLevel external service and local protocol replies", "server/highlevel/host.ts:125", "HighLevelHost.handle");
for (const mode of ["headers", "body", "chunk"] as const) entry(`outer:response:${mode}`, mode,
  "request-owned internal busy/exception response", "static busy or exception outcome", "server/index.ts:22183,32795", "busyJson/outer catch");
export const NATIVE_FINAL_SINKS = Object.freeze([
  ["claude:broker", "server/drivers/claude.ts:823,832,848,860,876", "broker socket"],
  ["claude:elicitation", "server/drivers/claude.ts:3484", "elicitation stdin"],
  ["codex:protocol", "server/drivers/codex.ts:583,1219,1298", "app-server stdin"],
  ["codex:hook-socket", "server/drivers/codex-hook.ts:700", "hook socket.end"],
  ["codex:generated-hook", "server/drivers/codex-hook.ts:157", "generated fd 1"],
  ["pi:answer", "server/drivers/pi.ts:1045", "native decision stdin"],
  ["acp:approval", "server/drivers/acp/approval-delivery.ts:51", "approval stream.write"],
  ["antigravity:relay", "server/drivers/antigravity-relay.ts:34", "hook stdout"],
  ["antigravity:generated-decision", "server/drivers/antigravity.ts:132", "generated decision stdout"],
  ["hermes:generated-hook", "server/drivers/acp/hermes.ts:149", "generated approval stdout"],
  ["openai:decision", "server/drivers/openai-chat.ts:1528", "decision continuation"],
  ["openai:tool-append", "server/drivers/openai-chat.ts:1366", "model-context append"],
  ["openai:fetch", "server/drivers/openai-chat.ts:692", "provider fetch"],
  ["pi:tool-return", "server/drivers/pi-mcp-extension.ts:660,671,673,725", "extension return/throw"],
  ["pi:permission-return", "server/drivers/pi-permission-gate.ts:1210,1212", "decision return including silent allow"],
].map(([id, b17, destination]) => Object.freeze({ id: id!, b17: b17!, destination: destination! })));
for (const sink of NATIVE_FINAL_SINKS) entry(`native:${sink.id}`, "native", sink.destination, "bound native decision/outcome producer", sink.b17, sink.id);
entry("upgrade:vps-mcp:admission", "request", "GET /api/internal/vps-mcp/v1/stdio", "authenticated upgrade request", "server/index.ts:32900", "VPS MCP upgrade");
entry("upgrade:vps-mcp:frame", "chunk", "VPS MCP ws.send", "bound VPS child frame", "server/cloud-home/vps-mcp-relay.ts:146", "VPS MCP frame release");
entry("proxy:child-request", "request", "exact admitted MCP child stdin", "validated engine request or bound server-request answer", "server/mcp-bridge.ts:335", "createConsumingIngress.request");
entry("proxy:final-ingress", "body", "server-owned final engine acceptance", "authenticated single-use envelope", "server/mcp-bridge.ts:356,394", "createConsumingIngress.deliver");
entry("proxy:custom:frame", "body", "server-owned custom MCP acceptance", "external MCP frame; no Murage stored-source provenance", "server/drivers/mcp-mounts.ts:53–61", "createMcpMountAdmission");
entry("proxy:wipeMcp:frame", "body", "server-owned MCP effect-metadata wrapper acceptance",
  "immutable wipeMcp spawn; bridge-owned frame and staged internal metadata publication",
  "server/mcp-wipe-proxy.ts:runMcpBridge", "SPAWNED_PROXY_FILES.wipeMcp");
export const RELEASE_CONTROL_ROUTE = Object.freeze({ method: "POST", path: "/api/internal/turn-release/v1/verdict", kind: "turn-release", destination: "authenticated verdict client only", binding: "immutable proxy instance and adapter lease" });
export const PROXY_RESPONSE_CLASSES = Object.freeze(["initialize", "ping", "tools/list", "local-help", "validation", "unknown-method", "success", "asynchronous", "notification", "server-request", "invalid-frame", "upstream-failure", "stale-generation"] as const);
export const FINAL_INGRESS_DESTINATIONS = Object.freeze([
  { destination: "chat-mcp-client acceptance", status: "server-owned", gate: "createConsumingIngress.deliver", supervisor: "exact ChildProcess" },
  { destination: "external CLI MCP stdio", status: "admission-disabled", gate: "assertConsumingMountAdmission", supervisor: "unavailable final synchronous ingress" },
  { destination: "external Pi extension return", status: "admission-disabled", gate: "assertConsumingMountAdmission", supervisor: "unavailable final synchronous ingress" },
  { destination: "nested VPS child stdout", status: "admission-disabled", gate: "assertConsumingMountAdmission", supervisor: "unavailable inherited supervisor channel" },
]);
export const CONTEXT_FREE_CONTROLS = Object.freeze([
  { destination: "supervisor", role: "terminal refusal", constraint: "fixed -32099 frame; original bounded id; no content; seals generation; never an engine tool result" },
  { destination: "transport", role: "close/ping/pong", constraint: "no application payload; cannot grant release" },
  { destination: "already-bound child request", role: "cancellation", constraint: "bounded bound id only; no result/input/text; cannot reopen, acknowledge success or resume" },
  { destination: "verdict client", role: "release verdict control", constraint: "terminates at authenticated control client; never engine input" },
]);
// Kept solely for the existing isolated proxy protocol fixture. This id is not
// an HTTP route, spawn entry, mount or production admission capability.
if (process.env.VITEST || process.env.NODE_ENV === "test") entry("test:proxy", "body", "isolated proxy fixture", "consumingFixture", "none (test support)", "proxy-turn-release.test.ts");

export const consumingSinkInventory = (): readonly SinkInventoryEntry[] => Object.freeze([...entries.values()]);
export function consumingSinkEntry(id: string, mode: ResponseMode): SinkInventoryEntry | undefined {
  const found = entries.get(id) ?? dynamicEntries.get(id);
  return found?.mode === mode ? found : undefined;
}

/** Dynamic routes require membership proved by the dispatcher from its actual
 * registry, in addition to the exact route grammar. No caller-supplied name alone
 * registers a route. The proof callback is evaluated at request admission. */
export function registeredInternalRoute(method: string, path: string,
  registry: { project: (name: string) => boolean; email: (name: string) => boolean; mcp: (name: string) => boolean;
    delegation: (id: string) => boolean; box: (id: string) => boolean; catalog?: (id: string) => boolean }): boolean {
  if (INTERNAL_HTTP_ROUTES.some(route => route.method === method && route.path === path)) return true;
  const dynamic = method === "POST" && /^\/api\/internal\/(project|email|mcp-remote)\/([a-z][a-z0-9_-]*)$/.exec(path);
  const catalog = method === "POST" && /^\/api\/internal\/mcp-catalog\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(path);
  const wipeMetadata = method === "POST" && /^\/api\/internal\/mcp-remote\/([a-z][a-z0-9_-]{0,31})\/wipe-metadata$/.exec(path);
  const delegation = method === "GET" && /^\/api\/internal\/delegations\/([\w-]{4,64})$/.exec(path);
  const box = /^\/api\/internal\/box\/v1\/boxes\/([A-Za-z0-9_-]{1,128})(\/(?:resume|commands|artifacts|files))?$/.exec(path);
  const isRegistered = () => dynamic ? (dynamic[1] === "project" ? PROJECT_ROUTE_NAMES.includes(dynamic[2]!) && registry.project(dynamic[2]!) : dynamic[1] === "email" ? EMAIL_ROUTE_NAMES.includes(dynamic[2]!) && registry.email(dynamic[2]!) : registry.mcp(dynamic[2]!))
    : wipeMetadata ? registry.mcp(wipeMetadata[1]!)
    : catalog ? registry.catalog?.(catalog[1]!) === true
    : delegation ? registry.delegation(delegation[1]!)
    : box ? registry.box(box[1]!) && (method === "POST" ? ["/resume", "/commands"].includes(box[2]!) : method === "GET" && ["", "/artifacts", "/files"].includes(box[2] ?? "")) : false;
  if (!isRegistered()) return false;
  for (const mode of ["headers", "body", "chunk"] as const) {
    const id = `${method} ${path}:${mode}`;
    const descriptor = entry(id, mode, `${method} ${path}`, catalog || wipeMetadata ? "localJson" : "registered dynamic handler", "server/index.ts:24179–24966", catalog ? "publishCloudMcpCatalog" : wipeMetadata ? "recordMcpWipeHints" : "registered internal dispatch");
    entries.delete(id);
    dynamicEntries.set(id, Object.freeze({ ...descriptor, isRegistered }));
    // Admission metadata is bounded independently of history. Already-issued
    // descriptors retain their own immutable membership check and identity.
    if (dynamicEntries.size > 1024) dynamicEntries.delete(dynamicEntries.keys().next().value!);
  }
  return true;
}

/** Historical b17 citations, not current line numbers or acceptance counts.
 * NOT A SINK constrains only the named role/destination; consuming reuse refuses. */
export const reviewedBoundaryRows = Object.freeze([
   {
      b17: "new: server/drivers/cli-mount-shim.ts (S1 §1)",
      contract: "S1 authenticated socket; final acceptance in RelayedMount before socket write",
      destination: "CLI stdio from the process-ticket authenticated server socket only",
      inventory: "REG", name: "cliMountShim", role: "BOUND TRANSPORT"
   },
   {
      "b17" : "server/browser-extension-panel-avatar-encoder.ts; shared/spawned-proxies.mjs:10",
      "contract" : "worker classification",
      "destination" : "owner browser panel avatar IPC; no engine delivery",
      "inventory" : "REG",
      "name" : "panelAvatarEncoder",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "server/drivers/highlevel-proxy.ts; shared/spawned-proxies.mjs:36",
      "contract" : "§12.1",
      "destination" : "server/drivers/highlevel-proxy.ts runHighLevelProxy writeMcpLine",
      "inventory" : "REG",
      "name" : "highlevel",
      "role" : "SINK"
   },
   {
      "b17": "new: server/consuming-turn-ingress.ts (§12.1)",
      "contract": "§12.1 server-owned final synchronous acceptance and supervisor",
      "destination": "exact engine lease; never a standalone child stdout passthrough",
      "inventory": "REG",
      "name": "consumingIngress",
      "role": "SINK"
   },
   {
      "b17" : "112",
      "contract" : "§13 T-INV-SCAN explicit exclusion record",
      "destination" : "Backup HTTPS fixture matched because exact server scan excludes tests, not fixtures; not production; server/backup-restic-loopback-s3.fixture.ts:112",
      "inventory" : "FILE",
      "name" : "server/backup-restic-loopback-s3.fixture.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "88, 123",
      "contract" : "§9.1 at caller",
      "destination" : "Validates connected-app tool request shape, no transport write; server/bot-access.ts:88",
      "inventory" : "FILE",
      "name" : "server/bot-access.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "79",
      "contract" : "§9.1 at consuming caller",
      "destination" : "Constructs outbound calendar tools/call, not final engine response; server/bot-calls-calendar.ts:79",
      "inventory" : "FILE",
      "name" : "server/bot-calls-calendar.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "319, 328, 334, 341, 353",
      "contract" : "§2.5 / §12.6",
      "destination" : "Call-session media/control sockets, not engine JSON-RPC; any model input derived from calls uses turn input fence; server/bot-calls-routes.ts:319",
      "inventory" : "FILE",
      "name" : "server/bot-calls-routes.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "254",
      "contract" : "§12.1",
      "destination" : "Browser-method dispatch guard; final engine response owned by proxy; server/browser-control.ts:254",
      "inventory" : "FILE",
      "name" : "server/browser-control.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "153",
      "contract" : "§12.1 at consuming browser proxy",
      "destination" : "Native browser-extension broker socket, not model response; server/browser-extension-broker.ts:153",
      "inventory" : "FILE",
      "name" : "server/browser-extension-broker.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "70, 196, 203, 205, 230, 232, 249",
      "contract" : "§12.1",
      "destination" : "Browser-extension command socket/server, not model engine; results flow through consuming browser proxy; server/browser-extension-engine.ts:70",
      "inventory" : "FILE",
      "name" : "server/browser-extension-engine.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "376",
      "contract" : "§12.1",
      "destination" : "Browser tool dispatcher; final reply belongs to consuming proxy; server/browser-extension-integration.ts:376",
      "inventory" : "FILE",
      "name" : "server/browser-extension-integration.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "240, 296, 338, 381, 382, 384, 409, 419",
      "contract" : "§12.1 at proxy",
      "destination" : "Browser tool dispatch plus browser event/ack WebSocket; returned results require consuming proxy gate; server/browser-native-relay.ts:240",
      "inventory" : "FILE",
      "name" : "server/browser-native-relay.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "83",
      "contract" : "§12.1 if surfaced by proxy",
      "destination" : "Browser restore CLI result; no direct consuming-engine transport; server/browser-restore-cli.ts:83",
      "inventory" : "FILE",
      "name" : "server/browser-restore-cli.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "39",
      "contract" : "§12.1 at consuming browser proxy",
      "destination" : "Byte transport to cloud browser service, not engine delivery; server/cloud-home/browser-relay.ts:39",
      "inventory" : "FILE",
      "name" : "server/cloud-home/browser-relay.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "114, 174, 184",
      "contract" : "§12.6 non-consuming role",
      "destination" : "Interactive login terminal WebSocket/stdin, not consuming model turn; server/cloud-home/engine-login.ts:114",
      "inventory" : "FILE",
      "name" : "server/cloud-home/engine-login.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "24, 30",
      "contract" : "§9.1 / §12.2 at destination",
      "destination" : "HTTP/upgrade transport to home server; no tool semantics; any consuming destination remains registered and fenced; server/cloud-home/proxy-socket.ts:24",
      "inventory" : "FILE",
      "name" : "server/cloud-home/proxy-socket.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "155",
      "contract" : "§12.6 non-consuming role",
      "destination" : "Browser canary CDP client socket, not model reply; server/cloud-home/ui-canary-browser.ts:155",
      "inventory" : "FILE",
      "name" : "server/cloud-home/ui-canary-browser.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "11",
      "contract" : "§12.2",
      "destination" : "Upgrade dispatcher; registered VPS delegate is independently fenced; server/cloud-home/upgrade-gate.ts:11",
      "inventory" : "FILE",
      "name" : "server/cloud-home/upgrade-gate.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "87, 146, 160",
      "contract" : "§12.2",
      "destination" : "WebSocket response frame and forwarding into bound computer child; server/cloud-home/vps-mcp-relay.ts:87",
      "inventory" : "FILE",
      "name" : "server/cloud-home/vps-mcp-relay.ts",
      "role" : "SINK"
   },
   {
      "b17" : "60, 72",
      "contract" : "§12.1, §12.2",
      "destination" : "Child stdout delivery of VPS MCP replies; ws.send is the reverse request direction; server/cloud-home/vps-relay-mcp.ts:60",
      "inventory" : "FILE",
      "name" : "server/cloud-home/vps-relay-mcp.ts",
      "role" : "SINK"
   },
   {
      "b17" : "794, 1318, 1516, 1664, 2011",
      "contract" : "§9.1, §12.1",
      "destination" : "Connected-app upstream RPC/SSE and filtering; final answer in connector proxy/internal route",
      "inventory" : "FILE",
      "name" : CONNECTED_APP_SOURCE_PATHS.runtime,
      "role" : "NOT A SINK"
   },
   {
      "b17" : "496, 1260",
      "contract" : "§12.1",
      "destination" : "Final computer tool JSON-RPC stdout; server/computer-proxy.ts:496",
      "inventory" : "FILE",
      "name" : "server/computer-proxy.ts",
      "role" : "SINK"
   },
   {
      "b17" : "520, 534, 756, 882, 905, 916, 938, 946, 950, 963, 984",
      "contract" : "§12.1",
      "destination" : "Final connector stdout, including startup failure and local failures; server/connector-proxy.ts:520",
      "inventory" : "FILE",
      "name" : "server/connector-proxy.ts",
      "role" : "SINK"
   },
   {
      "b17" : "149, 835",
      "contract" : "§12.1, §12.5",
      "destination" : "Generated approval-hook stdout; separate stdin match is RPC client transport; server/drivers/acp/hermes.ts:149",
      "inventory" : "FILE",
      "name" : "server/drivers/acp/hermes.ts",
      "role" : "SINK"
   },
   {
      "b17" : "820, 1632",
      "contract" : "§12.1",
      "destination" : "Final JSON-RPC stdout includes help and local/capped errors; server/drivers/agents-proxy.ts:820",
      "inventory" : "FILE",
      "name" : "server/drivers/agents-proxy.ts",
      "role" : "SINK"
   },
   {
      "b17" : "34",
      "contract" : "§12.1, §12.5",
      "destination" : "Generated native decision hook stdout; server/drivers/antigravity-relay.ts:34",
      "inventory" : "FILE",
      "name" : "server/drivers/antigravity-relay.ts",
      "role" : "SINK"
   },
   {
      "b17" : "132",
      "contract" : "§12.1, §12.5",
      "destination" : "Generated static allow/deny hook stdout; server/drivers/antigravity.ts:132",
      "inventory" : "FILE",
      "name" : "server/drivers/antigravity.ts",
      "role" : "SINK"
   },
   {
      "b17" : "48, 50, 63",
      "contract" : "§12.1",
      "destination" : "Engine-facing writeMcpLine success/error (also server/drivers/browser-extension-mcp.ts:58); server/drivers/browser-extension-mcp.ts:48",
      "inventory" : "FILE",
      "name" : "server/drivers/browser-extension-mcp.ts",
      "role" : "SINK"
   },
   {
      "b17" : "522, 540",
      "contract" : "§12.1",
      "destination" : "Final JSON-RPC stdout, including local responses; server/drivers/browser-proxy.ts:522",
      "inventory" : "FILE",
      "name" : "server/drivers/browser-proxy.ts",
      "role" : "SINK"
   },
   {
      "b17" : "409, 457",
      "contract" : "§12.1 ingress, §2.5 final fetch",
      "destination" : "Writes requests to MCP child, returns call result to chat driver; final model append is server/drivers/openai-chat.ts:1366; server/drivers/chat-mcp-client.ts:409",
      "inventory" : "FILE",
      "name" : "server/drivers/chat-mcp-client.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "1600, 3255, 3320, 3484, 5521",
      "contract" : "§2.5, §12.5",
      "destination" : "Prompt and native-answer stdin; launch-marker stdout at :1600 is a non-consuming executable probe; server/drivers/claude.ts:1600",
      "inventory" : "FILE",
      "name" : "server/drivers/claude.ts",
      "role" : "SINK"
   },
   {
      "b17" : "140, 175",
      "contract" : "§12.6 explicit probe role",
      "destination" : "Model catalog RPC/initialized probe, no consuming turn; server/drivers/codex-catalog.ts:140",
      "inventory" : "FILE",
      "name" : "server/drivers/codex-catalog.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "678",
      "contract" : "§12.1, §12.5",
      "destination" : "Native hook socket listener; final socket.end at server/drivers/codex-hook.ts:700 and generated fd 1 write at :157; server/drivers/codex-hook.ts:678",
      "inventory" : "FILE",
      "name" : "server/drivers/codex-hook.ts",
      "role" : "SINK"
   },
   {
      "b17" : "583, 1219, 1298",
      "contract" : "§2.5, §12.5",
      "destination" : "Final app-server stdin writes include idle denials and protocol responses; server/drivers/codex.ts:583",
      "inventory" : "FILE",
      "name" : "server/drivers/codex.ts",
      "role" : "SINK"
   },
   {
      "b17" : "62, 163",
      "contract" : "§12.1",
      "destination" : "Final JSON-RPC stdout and local method dispatch; server/drivers/dweb-proxy.ts:62",
      "inventory" : "FILE",
      "name" : "server/drivers/dweb-proxy.ts",
      "role" : "SINK"
   },
   {
      "b17" : "187, 189, 260, 269, 283, 286, 287",
      "contract" : "§12.1",
      "destination" : "Browser calls feed final response via server/drivers/headless-browser-proxy.ts:330; server/drivers/headless-browser-proxy.ts:187",
      "inventory" : "FILE",
      "name" : "server/drivers/headless-browser-proxy.ts",
      "role" : "SINK"
   },
   {
      "b17" : "58",
      "contract" : "§12.1 at browser proxy",
      "destination" : "CDP request sent to browser socket, not engine answer; server/drivers/headless-target-guard.ts:58",
      "inventory" : "FILE",
      "name" : "server/drivers/headless-target-guard.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "125, 126, 163",
      "contract" : "§12.1",
      "destination" : "Final JSON-RPC result/error stdout; server/drivers/memory-proxy.ts:125",
      "inventory" : "FILE",
      "name" : "server/drivers/memory-proxy.ts",
      "role" : "SINK"
   },
   {
      "b17" : "85",
      "contract" : "§12.1",
      "destination" : "Local phone-tool dispatch; final writes at server/drivers/phone-jobs-proxy.ts:96, :102; server/drivers/phone-jobs-proxy.ts:85",
      "inventory" : "FILE",
      "name" : "server/drivers/phone-jobs-proxy.ts",
      "role" : "SINK"
   },
   {
      "b17" : "329, 341",
      "contract" : "§12.1",
      "destination" : "Final phone-tool JSON-RPC stdout; server/drivers/phone-proxy.ts:329",
      "inventory" : "FILE",
      "name" : "server/drivers/phone-proxy.ts",
      "role" : "SINK"
   },
   {
      "b17" : "205, 310",
      "contract" : "§12.1, §12.5",
      "destination" : "MCP child requests plus final Pi tool return/throw at server/drivers/pi-mcp-extension.ts:660, :671, :673, :725; server/drivers/pi-mcp-extension.ts:205",
      "inventory" : "FILE",
      "name" : "server/drivers/pi-mcp-extension.ts",
      "role" : "SINK"
   },
   {
      "b17" : "502, 1045",
      "contract" : "§2.5, §12.5",
      "destination" : "Native answer/prompt stdin writer; separate catalog write is non-consuming probe; server/drivers/pi.ts:502",
      "inventory" : "FILE",
      "name" : "server/drivers/pi.ts",
      "role" : "SINK"
   },
   {
      "b17" : "151",
      "contract" : "§12.1 at proxy",
      "destination" : "Tool-call processing core; stdout belongs to server/drivers/remote-mcp-proxy.ts:40 [r3.3 CITE]; server/drivers/remote-mcp-proxy-core.ts:151",
      "inventory" : "FILE",
      "name" : "server/drivers/remote-mcp-proxy-core.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "40, 157",
      "contract" : "§12.1, §12.4",
      "destination" : "Final remote-MCP JSON-RPC stdout after HTTP/SSE processing; server/drivers/remote-mcp-proxy.ts:40",
      "inventory" : "FILE",
      "name" : "server/drivers/remote-mcp-proxy.ts",
      "role" : "SINK"
   },
   {
      "b17" : "43, 45, 60",
      "contract" : "§12.1",
      "destination" : "Engine-facing writeMcpLine errors and success at server/drivers/unified-browser-proxy.ts:63; server/drivers/unified-browser-proxy.ts:43",
      "inventory" : "FILE",
      "name" : "server/drivers/unified-browser-proxy.ts",
      "role" : "SINK"
   },
   {
      "b17" : "48, 53",
      "contract" : "§9.1",
      "destination" : "Outbound web-search tool request, result returned to internal route; server/free-web-search.ts:48",
      "inventory" : "FILE",
      "name" : "server/free-web-search.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "177",
      "contract" : "§12.6 non-consuming role",
      "destination" : "Native updater RPC subprocess, not consuming conversation; server/fuigo-native-update.ts:177",
      "inventory" : "FILE",
      "name" : "server/fuigo-native-update.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "102, 113",
      "contract" : "§12.6 non-consuming role",
      "destination" : "Optimization worker job/cancel protocol, not current conversational engine input; server/gepa-worker.ts:102",
      "inventory" : "FILE",
      "name" : "server/gepa-worker.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "137",
      "contract" : "§9.1 at consuming caller",
      "destination" : "HighLevel request restriction parsing, not engine delivery; server/highlevel/access.ts:137",
      "inventory" : "FILE",
      "name" : "server/highlevel/access.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "125",
      "contract" : "§9.1, §12.6",
      "destination" : "Synthesizes JSON-RPC tool replies; every consuming return must reach E, unknown HTTP path refuses; server/highlevel/host.ts:125",
      "inventory" : "FILE",
      "name" : "server/highlevel/host.ts",
      "role" : "SINK"
   },
   {
      "b17" : "26, 27, 28, 48",
      "contract" : "§9.1, §12.1",
      "destination" : "Requests external computer tools; consuming response emitted by host proxy/HTTP route; server/host-computer-broker.ts:26",
      "inventory" : "FILE",
      "name" : "server/host-computer-broker.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "165",
      "contract" : "§12.6 non-consuming role",
      "destination" : "Power/port listener immediately destroys accepted sockets; server/host-power.ts:165",
      "inventory" : "FILE",
      "name" : "server/host-power.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "1048",
      "contract" : "§9.1",
      "destination" : "Parses upstream image SSE; internal generate-image answer is released in index.ts; server/image-generation.ts:1048",
      "inventory" : "FILE",
      "name" : "server/image-generation.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "13618, 23287, 23995, 24000, 24020, 24044, 24076, 25455, 32171, 32808, 32900, 32904, 32906",
      "contract" : "§9.1, §12.2, §12.3",
      "destination" : "Internal HTTP, raw connector/MCP responses and VPS upgrade dispatch; UI event-stream match is not engine content; server/index.ts:13618",
      "inventory" : "FILE",
      "name" : "server/index.ts",
      "role" : "SINK"
   },
   {
      "b17" : "238",
      "contract" : "§12.1",
      "destination" : "tools/call interception produces local replies; final answer writes through server/mcp-bridge.ts:335, :356 and child reply forwarding at :394; server/mcp-bridge.ts:238",
      "inventory" : "FILE",
      "name" : "server/mcp-bridge.ts",
      "role" : "SINK"
   },
   {
      "b17" : "24",
      "contract" : "§12.1 control-only classification",
      "destination" : "Empty stdout flush marker, no application bytes or answer; cannot grant release; server/mcp-listed.ts:24",
      "inventory" : "FILE",
      "name" : "server/mcp-listed.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "164",
      "contract" : "§12.6 explicit probe role",
      "destination" : "MCP discovery probe stdin, not answer into an active turn; server/mcp-probe.ts:164",
      "inventory" : "FILE",
      "name" : "server/mcp-probe.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "105, 247, 259, 271",
      "contract" : "§9.1, §12.4",
      "destination" : "Returns JSON/SSE upstream body to route; final stream release is server/index.ts:24959; server/mcp-relay.ts:105",
      "inventory" : "FILE",
      "name" : "server/mcp-relay.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "98",
      "contract" : "§12.6 non-consuming role",
      "destination" : "Temporary upgrade-health listener, not model response; server/memory/upgrade-health.ts:98",
      "inventory" : "FILE",
      "name" : "server/memory/upgrade-health.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "115, 120, 230, 239, 253",
      "contract" : "§12.4, §12.5 GATEWAY",
      "destination" : "Provider JSON/SSE responses into engine; final writes server/model-gateway.ts:231, :240, :254; server/model-gateway.ts:115",
      "inventory" : "FILE",
      "name" : "server/model-gateway.ts",
      "role" : "SINK"
   },
   {
      "b17" : "82, 130",
      "contract" : "§12.1, §12.5",
      "destination" : "Final permission JSON-RPC stdout; server/permission-proxy.ts:82",
      "inventory" : "FILE",
      "name" : "server/permission-proxy.ts",
      "role" : "SINK"
   },
   {
      "b17" : "451",
      "contract" : "§2.5 / §12.6",
      "destination" : "Launcher env/cwd frame to child before CLI prompt; later driver writes remain fenced; server/procs.ts:451",
      "inventory" : "FILE",
      "name" : "server/procs.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "47, 68, 78, 87",
      "contract" : "§12.1 at owning computer proxy",
      "destination" : "Generated remote browser observation/action stdout is captured as tool content; no direct engine attach permitted; server/remote-computer.ts:47",
      "inventory" : "FILE",
      "name" : "server/remote-computer.ts",
      "role" : "SINK"
   },
   {
      "b17" : "486, 508",
      "contract" : "§9.1 / §12.1 at consumer",
      "destination" : "Outbound HTTP/SSE to remote MCP; final engine answer belongs to its consuming relay/proxy; server/remote-mcp-client.ts:486",
      "inventory" : "FILE",
      "name" : "server/remote-mcp-client.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "156",
      "contract" : "§12.1, §12.4",
      "destination" : "Opens upstream SSE session; downstream engine response must use bound proxy; server/remote-mcp-sse-sessions.ts:156",
      "inventory" : "FILE",
      "name" : "server/remote-mcp-sse-sessions.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "143",
      "contract" : "§12.6 non-consuming role",
      "destination" : "Sentinel command output to operator terminal; server/sentinel/cli.ts:143",
      "inventory" : "FILE",
      "name" : "server/sentinel/cli.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "85, 90, 116",
      "contract" : "§12.1 at consuming browser proxy",
      "destination" : "CDP browser/client upgrade relay, not conversational engine JSON-RPC; server/user-chrome-proxy.ts:85",
      "inventory" : "FILE",
      "name" : "server/user-chrome-proxy.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "116, 119",
      "contract" : "§12.6 non-consuming role",
      "destination" : "PCM and control sent to transcription WebSocket, not consuming CLI; server/voice/flux-stream.ts:116",
      "inventory" : "FILE",
      "name" : "server/voice/flux-stream.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "277",
      "contract" : "§12.6 non-consuming role",
      "destination" : "WebSocket admission for human voice relay, not an engine answer; server/voice/stream-route.ts:277",
      "inventory" : "FILE",
      "name" : "server/voice/stream-route.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "305",
      "contract" : "§12.6 non-consuming role",
      "destination" : "Voice-host SSE surface; not a tool-result writer into the model; server/voice/voice-host-route.ts:305",
      "inventory" : "FILE",
      "name" : "server/voice/voice-host-route.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "160",
      "contract" : "§12.1, §12.2",
      "destination" : "Port availability probe createServer; MCP launch args reach registered bridge; server/vps-computer.ts:160",
      "inventory" : "FILE",
      "name" : "server/vps-computer.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "196",
      "contract" : "§2.5 / §12.6",
      "destination" : "Webhook HTTP ingress listener; any resulting new turn uses admission/input fence; server/webhook-ingress.ts:196",
      "inventory" : "FILE",
      "name" : "server/webhook-ingress.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "435",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Companion local control server, not engine reply; companion/src/control.ts:435",
      "inventory" : "FILE",
      "name" : "companion/src/control.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "486, 487, 530",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Paired-device/browser HTTP doors and human voice transport, not model-answer transport; companion/src/index.ts:486",
      "inventory" : "FILE",
      "name" : "companion/src/index.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "399, 400, 401",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Android device status/frame/input IPC, UI/device service; electron/android-device.mjs:399",
      "inventory" : "FILE",
      "name" : "electron/android-device.mjs",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "340",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Browser control HTTP service; final model answer returns through fenced browser proxy; electron/browser-host.cjs:340",
      "inventory" : "FILE",
      "name" : "electron/browser-host.cjs",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "258, 262, 263, 264",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Remote login terminal IPC; no consuming conversational turn; electron/cloud-home-engine-login.mjs:258",
      "inventory" : "FILE",
      "name" : "electron/cloud-home-engine-login.mjs",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "232",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Companion UI HTTP relay; no engine-targeted answer; server consuming destinations keep their own gates; electron/companion-origin-gateway.mjs:232",
      "inventory" : "FILE",
      "name" : "electron/companion-origin-gateway.mjs",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "385, 386, 387, 394, 405, 416",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Computer connection/permission setup IPC, not native model approval reply; electron/cua.mjs:385",
      "inventory" : "FILE",
      "name" : "electron/cua.mjs",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "272",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Interactive engine-login IPC, not conversational turn; electron/engine-login-local.mjs:272",
      "inventory" : "FILE",
      "name" : "electron/engine-login-local.mjs",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "93",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Installation recovery UI IPC; electron/installation-recovery-window.mjs:93",
      "inventory" : "FILE",
      "name" : "electron/installation-recovery-window.mjs",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "95, 98, 147",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Static IPC inventory harness diagnostic stdout; excluded from production count, retained for broader scan accounting; electron/ipc-inventory-harness.mjs:95",
      "inventory" : "FILE",
      "name" : "electron/ipc-inventory-harness.mjs",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "111, 127",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Trusted-renderer IPC wrapper; engine-answer handling remains at server final sinks; electron/main-ipc-trust.mjs:111",
      "inventory" : "FILE",
      "name" : "electron/main-ipc-trust.mjs",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "539, 540, 593, 596, 597, 598, 600, 601, 605, 607, 612, 613, 616, 620, 622, 628, 703, 2919, 2920, 2921, 2935, 2939, 2943, 2947, 2951, 2972, 2977, 2987, 3000, 3004, 3062, 3357, 3358, 3677, 3701, 3708, 3714, 3759, 3772, 3831, 3847, 3876, 3926, 3933, 3960, 3973, 3983, 3991, 3999, 4002, 4007, 4012, 4020, 4028, 4033, 4039, 4050, 4064, 4083, 4086, 4091, 4095, 4096, 4102, 4105, 4116, 4117, 4118, 4119, 4123, 4124, 4125, 4128, 4131, 4134, 4137, 4143, 4144, 4147, 4150, 4151, 4153, 4162, 4166, 4178, 4254, 4258, 4268, 4283, 4287, 4304, 4309, 4320, 4354, 4355, 4356, 4357, 4361, 4365, 4409, 4410, 4411, 4412, 4416, 4417, 4419, 4428",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Desktop UI IPC registrations; no direct engine stdin/stdout or MCP reply among these matches; electron/main.mjs:539",
      "inventory" : "FILE",
      "name" : "electron/main.mjs",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "11",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Type declaration only, no runtime server creation; electron/model-signin.d.mts:11",
      "inventory" : "FILE",
      "name" : "electron/model-signin.d.mts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "58",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "OAuth callback listener; electron/oauth/loopback.mjs:58",
      "inventory" : "FILE",
      "name" : "electron/oauth/loopback.mjs",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "13",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Port probe listener; electron/port-availability.mjs:13",
      "inventory" : "FILE",
      "name" : "electron/port-availability.mjs",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "104, 105, 106, 107, 108",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Updater state/action IPC; electron/updater.mjs:104",
      "inventory" : "FILE",
      "name" : "electron/updater.mjs",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "3367, 3390, 3485, 3591",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Vendored WebSocket listener implementation; concrete destinations classified separately; electron/vendor/ws.cjs:3367",
      "inventory" : "FILE",
      "name" : "electron/vendor/ws.cjs",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "1652, 1654, 1657",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Installer fleet progress output; installer/bin/murage.mjs:1652",
      "inventory" : "FILE",
      "name" : "installer/bin/murage.mjs",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "167, 175",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Installer terminal prompts/newlines; installer/lib/ui.mjs:167",
      "inventory" : "FILE",
      "name" : "installer/lib/ui.mjs",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "52, 279, 282, 305",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Pure connected-app call identity/classification, no transport write; shared/connected-app-calls.ts:52",
      "inventory" : "FILE",
      "name" : "shared/connected-app-calls.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "203, 206",
      "contract" : "§12.6; any consuming delivery still uses §9.1/§12.1",
      "destination" : "Pure tool-call name mapping, no transport write; shared/connected-app-names.ts:203",
      "inventory" : "FILE",
      "name" : "shared/connected-app-names.ts",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "server/drivers/memory-proxy.ts; shared/spawned-proxies.mjs:8",
      "contract" : "§12.1",
      "destination" : "server/drivers/memory-proxy.ts:125–126 final JSON-RPC stdout",
      "inventory" : "REG",
      "name" : "memory",
      "role" : "SINK"
   },
   {
      "b17" : "server/memory/worker.ts; shared/spawned-proxies.mjs:9",
      "contract" : "§9.1 at consumer",
      "destination" : "server/memory/worker.ts:59 IPC query result to server, not engine; downstream memory route fenced",
      "inventory" : "REG",
      "name" : "memoryWorker",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "server/channels/whatsapp/bridge.ts; shared/spawned-proxies.mjs:12",
      "contract" : "§2.5 at any derived turn input",
      "destination" : "server/channels/whatsapp/bridge.ts:1029 IPC to channel host; WhatsApp ingress/egress is not an engine tool answer",
      "inventory" : "REG",
      "name" : "whatsappBridge",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "server/bot-package-guard-worker.ts; shared/spawned-proxies.mjs:14",
      "contract" : "§12.6 non-consuming",
      "destination" : "server/bot-package-guard-worker.ts:20–22 import progress/result to parent",
      "inventory" : "REG",
      "name" : "importGuardWorker",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "server/engine-history-worker.ts; shared/spawned-proxies.mjs:16",
      "contract" : "§12.6 non-consuming",
      "destination" : "server/engine-history-worker.ts:15 deletion-job result to parent",
      "inventory" : "REG",
      "name" : "engineHistoryWorker",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "server/transcript-read-worker.ts; shared/spawned-proxies.mjs:17",
      "contract" : "§12.6 non-consuming",
      "destination" : "server/transcript-read-worker.ts:22–24 forgotten-text lookup to event-log maintenance",
      "inventory" : "REG",
      "name" : "transcriptReadWorker",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "server/inbox-fill-worker.ts; shared/spawned-proxies.mjs:18",
      "contract" : "§12.6 non-consuming",
      "destination" : "server/inbox-fill-worker.ts:133–135 inbox projection completion/error to parent",
      "inventory" : "REG",
      "name" : "inboxFillWorker",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "server/job-launcher.ts; shared/spawned-proxies.mjs:20",
      "contract" : "§2.5 at final driver writes",
      "destination" : "server/job-launcher.ts:13–16 consumes env/cwd frame, preserves inherited engine stdin; fd 3 status at :51",
      "inventory" : "REG",
      "name" : "jobLauncher",
      "role" : "NOT A SINK"
   },
   {
      "b17" : "server/computer-proxy.ts; shared/spawned-proxies.mjs:21",
      "contract" : "§12.1",
      "destination" : "server/computer-proxy.ts:496 stdout",
      "inventory" : "REG",
      "name" : "computer",
      "role" : "SINK"
   },
   {
      "b17" : "server/permission-proxy.ts; shared/spawned-proxies.mjs:22",
      "contract" : "§12.1, §12.5",
      "destination" : "server/permission-proxy.ts:82 stdout, including :180 and :189",
      "inventory" : "REG",
      "name" : "permission",
      "role" : "SINK"
   },
   {
      "b17" : "server/container-mcp.ts; shared/spawned-proxies.mjs:23",
      "contract" : "§12.1",
      "destination" : "server/container-mcp.ts:24 delegates to server/mcp-bridge.ts:356",
      "inventory" : "REG",
      "name" : "containerMcp",
      "role" : "SINK"
   },
   {
      "b17" : "server/vps-container-mcp.ts; shared/spawned-proxies.mjs:24",
      "contract" : "§12.1",
      "destination" : "server/vps-container-mcp.ts:25 delegates to server/mcp-bridge.ts:356",
      "inventory" : "REG",
      "name" : "vpsContainerMcp",
      "role" : "SINK"
   },
   {
      "b17" : "server/cloud-home/vps-relay-mcp.ts; shared/spawned-proxies.mjs:25",
      "contract" : "§12.1, §12.2",
      "destination" : "server/cloud-home/vps-relay-mcp.ts: wrapper delegates to runMcpBridge; pipe responses use releaseProxyFrame; upstream.send is child-facing request transport",
      "inventory" : "REG",
      "name" : "vpsRelayMcp",
      "role" : "SINK"
   },
   {
      "b17" : "server/drivers/agents-proxy.ts; shared/spawned-proxies.mjs:26",
      "contract" : "§12.1",
      "destination" : "server/drivers/agents-proxy.ts:820 stdout",
      "inventory" : "REG",
      "name" : "agents",
      "role" : "SINK"
   },
   {
      "b17" : "server/drivers/dweb-proxy.ts; shared/spawned-proxies.mjs:27",
      "contract" : "§12.1",
      "destination" : "server/drivers/dweb-proxy.ts:62 stdout",
      "inventory" : "REG",
      "name" : "dweb",
      "role" : "SINK"
   },
   {
      "b17" : "server/connector-proxy.ts; shared/spawned-proxies.mjs:28",
      "contract" : "§12.1",
      "destination" : "server/connector-proxy.ts:520, :534 stdout",
      "inventory" : "REG",
      "name" : "connectors",
      "role" : "SINK"
   },
   {
      "b17" : "server/drivers/remote-mcp-proxy.ts; shared/spawned-proxies.mjs:29",
      "contract" : "§12.1",
      "destination" : "server/drivers/remote-mcp-proxy.ts:40 stdout",
      "inventory" : "REG",
      "name" : "remoteMcp",
      "role" : "SINK"
   },
   {
      "b17" : "server/drivers/phone-proxy.ts; shared/spawned-proxies.mjs:30",
      "contract" : "§12.1",
      "destination" : "server/drivers/phone-proxy.ts:329 stdout",
      "inventory" : "REG",
      "name" : "phone",
      "role" : "SINK"
   },
   {
      "b17" : "server/drivers/phone-jobs-proxy.ts; shared/spawned-proxies.mjs:32",
      "contract" : "§12.1",
      "destination" : "server/drivers/phone-jobs-proxy.ts:96, :102 writeMcpLine",
      "inventory" : "REG",
      "name" : "phoneJobs",
      "role" : "SINK"
   },
   {
      "b17" : "server/drivers/browser-proxy.ts; shared/spawned-proxies.mjs:33",
      "contract" : "§12.1",
      "destination" : "server/drivers/browser-proxy.ts:522 stdout",
      "inventory" : "REG",
      "name" : "browser",
      "role" : "SINK"
   },
   {
      "b17" : "server/drivers/headless-browser-proxy.ts; shared/spawned-proxies.mjs:34",
      "contract" : "§12.1",
      "destination" : "server/drivers/headless-browser-proxy.ts:330 writeMcpLine",
      "inventory" : "REG",
      "name" : "headlessBrowser",
      "role" : "SINK"
   },
   {
      "b17" : "server/drivers/unified-browser-proxy.ts; shared/spawned-proxies.mjs:35",
      "contract" : "§12.1",
      "destination" : "server/drivers/unified-browser-proxy.ts:60, :63 writeMcpLine",
      "inventory" : "REG",
      "name" : "unifiedBrowser",
      "role" : "SINK"
   },
   {
      "b17" : "server/drivers/host-computer-proxy.ts; shared/spawned-proxies.mjs:36",
      "contract" : "§12.1",
      "destination" : "server/drivers/host-computer-proxy.ts:59 writeMcpLine",
      "inventory" : "REG",
      "name" : "hostComputer",
      "role" : "SINK"
   },
   {
      "b17" : "server/drivers/pi-mcp-extension.ts; shared/spawned-proxies.mjs:40",
      "contract" : "§12.1, §12.5",
      "destination" : "server/drivers/pi-mcp-extension.ts:660, :671, :673, :725 tool return/throw, despite loading inside external Pi",
      "inventory" : "REG",
      "name" : "piMcpExtension",
      "role" : "SINK"
   },
   {
      "b17" : "server/drivers/pi-permission-gate.ts; shared/spawned-proxies.mjs:41",
      "contract" : "§12.1, §12.5",
      "destination" : "server/drivers/pi-permission-gate.ts:1210, :1212 tool-call return including local allow/block",
      "inventory" : "REG",
      "name" : "piPermissionGate",
      "role" : "SINK"
   },
   {
      "b17" : "server/drivers/mcp-mounts.ts:18, :72",
      "contract" : "§12.1 server/connector-proxy.ts:520, :534; §9.1 internal connectors; all aliases map to one bound descriptor",
      "destination" : "§12.1 server/connector-proxy.ts:520, :534; §9.1 internal connectors; all aliases map to one bound descriptor",
      "inventory" : "MOUNTS",
      "name" : "connected-apps current and legacy names",
      "role" : "SINK when mounted; third-party service behind Murage connector"
   },
   {
      "b17" : "server/drivers/mcp-mounts.ts:19–24",
      "contract" : "§12.1 server/computer-proxy.ts:496",
      "destination" : "§12.1 server/computer-proxy.ts:496",
      "inventory" : "MOUNTS",
      "name" : "computer integration",
      "role" : "SINK"
   },
   {
      "b17" : "server/drivers/mcp-mounts.ts:25–34",
      "contract" : "§12.1 host/container/VPS bridge and §12.2 where applicable; unknown executable cannot bypass ingress",
      "destination" : "§12.1 host/container/VPS bridge and §12.2 where applicable; unknown executable cannot bypass ingress",
      "inventory" : "MOUNTS",
      "name" : "localComputer command/args/env alternative",
      "role" : "SINK at wrapper, external child may be uninstrumented"
   },
   {
      "b17" : "server/drivers/mcp-mounts.ts:36",
      "contract" : "§12.1 server/drivers/memory-proxy.ts:125–126",
      "destination" : "§12.1 server/drivers/memory-proxy.ts:125–126",
      "inventory" : "MOUNTS",
      "name" : "murage-memory",
      "role" : "SINK"
   },
   {
      "b17" : "server/drivers/mcp-mounts.ts:37",
      "contract" : "§12.1 server/drivers/agents-proxy.ts:820",
      "destination" : "§12.1 server/drivers/agents-proxy.ts:820",
      "inventory" : "MOUNTS",
      "name" : "agents",
      "role" : "SINK"
   },
   {
      "b17" : "server/drivers/mcp-mounts.ts:38",
      "contract" : "§12.1 server/drivers/phone-proxy.ts:329",
      "destination" : "§12.1 server/drivers/phone-proxy.ts:329",
      "inventory" : "MOUNTS",
      "name" : "phone",
      "role" : "SINK"
   },
   {
      "b17" : "server/drivers/mcp-mounts.ts:40",
      "contract" : "§12.1 server/drivers/phone-jobs-proxy.ts:96, :102",
      "destination" : "§12.1 server/drivers/phone-jobs-proxy.ts:96, :102",
      "inventory" : "MOUNTS",
      "name" : "phoneJobs",
      "role" : "SINK"
   },
   {
      "b17" : "server/drivers/mcp-mounts.ts:41–46",
      "contract" : "§12.1 server/drivers/dweb-proxy.ts:62",
      "destination" : "§12.1 server/drivers/dweb-proxy.ts:62",
      "inventory" : "MOUNTS",
      "name" : "dweb",
      "role" : "SINK"
   },
   {
      "b17" : "server/drivers/mcp-mounts.ts:53–61",
      "contract" : "§12.5 EXTERNAL; require bound Murage ingress/extension acceptance, fence Murage inputs/answers, stop exact generation on refusal; enumerate mount instance at admission, unknown instance refuses",
      "destination" : "§12.5 EXTERNAL; require bound Murage ingress/extension acceptance, fence Murage inputs/answers, stop exact generation on refusal; enumerate mount instance at admission, unknown instance refuses",
      "inventory" : "MOUNTS",
      "name" : "every owner custom command/link and dynamic name",
      "role" : "External SINK, not instrumentable third-party internals"
   }
]
.map(row => Object.freeze(row)));

// B–D use these exact spawn destinations. Registry key and concrete final sink
// remain distinct: a worker classification never grants engine output authority.
for (const row of reviewedBoundaryRows) {
  if (row.inventory === "REG" && row.role === "SINK") {
    entry(`proxy:${row.name}:frame`, "body", row.destination,
      `immutable ${row.name} spawn; explicit frame provenance`, row.b17, `SPAWNED_PROXY_FILES.${row.name}`);
  }
}
/** Historical b17 coordinates are evidence, never current source offsets or
 * acceptance counts. Resolve current sites by these independently named symbols. */
export const CURRENT_SYMBOL_MAP = Object.freeze([
  { b17: "server/index.ts:15864–15866", file: "server/index.ts", symbol: "sendProjectUsageTurn", responsibility: "wrap input and capture immutable consuming binding" },
  { b17: "server/index.ts:15762", file: "server/index.ts", symbol: "sharedOwnerUsageTurn", responsibility: "verify wrapper binding identity" },
  { b17: "server/index.ts:15770", file: "server/index.ts", symbol: "sharedOwnerUsageTurn / instance.adapter.sendTurn", responsibility: "actual adapter submission of fenced input" },
  { b17: "server/index.ts:15771", file: "server/index.ts", symbol: "sharedOwnerUsageTurn / sharedOwnerUsage.accepted", responsibility: "acceptance recorded against captured binding" },
]);


// D:403: every independent browser-extension reply class uses this destination.
entry("proxy:browser-extension:frame", "body", "server-owned browser-extension MCP final ingress",
  "immutable browser-extension spawn; explicit protocol reply provenance", "server/drivers/browser-extension-mcp.ts:56–80", "releaseProxyFrame");
/** D:427 reader inventory: each row names the raw reader and its accounting seam.
 * This is coverage metadata, never a probe exemption or release authority. */
export const CONSUMING_UPSTREAM_READERS = Object.freeze([
  ["server/mcp-relay.ts", "accountedChunks"],
  ["server/remote-mcp-client.ts", "currentUpstreamAccounting"],
  ["server/remote-mcp-sse-sessions.ts", "createSseReader"],
  [CONNECTED_APP_SOURCE_PATHS.transport, "accountedFetch"],
  ["server/connector-proxy.ts", "proxyFetch"],
  ["server/drivers/remote-mcp-proxy.ts", "proxyFetch"],
  ["server/drivers/memory-proxy.ts", "proxyFetch"],
  ["server/drivers/agents-proxy.ts", "collectProxyUpstream"],
  ["server/drivers/browser-proxy.ts", "proxyUpstreamResponse"],
  ["server/drivers/dweb-proxy.ts", "proxyFetch"],
  ["server/drivers/host-computer-proxy.ts", "collectProxyUpstream"],
  ["server/drivers/phone-jobs-proxy.ts", "collectProxyUpstream"],
  ["server/drivers/highlevel-proxy.ts", "collectProxyUpstream"],
  ["server/drivers/unified-browser-proxy.ts", "proxyFetch"],
  ["server/drivers/headless-browser-proxy.ts", "proxyUpstreamResponse"],
  ["server/drivers/browser-extension-mcp.ts", "proxyUpstreamResponse"],
  ["server/browser-floor-builtin.ts", "readBrowserRefusal"],
  ["server/drivers/phone-proxy.ts", "collectProxyUpstream"],
  ["server/mcp-bridge.ts", "reserveProxyUpstream"],
  ["server/permission-proxy.ts", "reserveProxyUpstream"],
  ["server/drivers/chat-mcp-client.ts", "ingress.upstream"],
  ["server/drivers/pi-mcp-extension.ts", "reserveProxyUpstream"],
  ["server/cloud-home/vps-mcp-relay.ts", "ingress.upstream"],
  ["server/cloud-home/vps-relay-mcp.ts", "reserveProxyUpstream"],
  ["server/box-relay.ts", "currentUpstreamAccounting"],
  ["server/free-web-search.ts", "currentUpstreamAccounting"],
  ["server/image-generation.ts", "currentUpstreamAccounting"],
  ["server/drivers/openai-chat.ts", "accountedResponse"],
  ["server/model-gateway.ts", "readConsumingUpstream"],
] as const);
