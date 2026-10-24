// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deny by default, by construction (0.1.61 plan, contract 4.2).
//
// Every HTTP route the harness answers has one class here, and the class says
// who may call it. A route with no entry is desktop-only: it answers only the
// renderer or the desktop main process carrying this launch's secret. Until
// 0.1.61 it was the other way round: a 78-line denylist named the routes that
// needed the desktop, and anything missing from it (GET /api/decisions, GET
// /api/flux-connection and its test, and more) was open to any process on
// the computer, a bot's own shell included.
//
// The classes:
//   desktop       the renderer's per-launch proof (requestSurface). The default.
//   conversation  the conversation surface a phone, the browser door and the
//                 local MCP server use. Loopback only (the host and origin
//                 gates run first) and a proven caller only (0.1.62 audit C5):
//                 the desktop proof or the companion's launch secret (owner
//                 header or door header). A bot's internal capability is never
//                 proof here; its tools use /api/internal/*. Every refused
//                 caller gets the unknown-route 404. The route
//                 itself scopes what a caller that is not the desktop sees and may do (requestOrigin,
//                 mayApprove, visibleToCompanion, the search and SSE scoping).
//   companion     the desktop, or a request the phone's companion proves it
//                 forwarded (companionAuthorized, the launch proof).
//   internal      a bot's own internal capability (Bearer token, per
//                 capability kind), checked in the /api/internal/ block.
//   media         a short-lived signed capability in the URL (media-assets.ts).
//   extension     a paired Murage for Chrome credential (arrives with L6).
//   engine-login  a relayed vendor CLI sign-in terminal (a WebSocket upgrade, so
//                 the HTTP dispatcher never lists it). Cloud: an owner-desktop
//                 session with step-up only. Desktop: the desktop proof only.
//   health        anyone on loopback: a probe, and the dev-only secret handout.
//
// A caller that is refused gets 404 "no such route" unless it proved who it
// is (a bot's internal capability or the companion's launch proof) and the
// route is not a conversation route: then it gets 403 with a sentence it can
// pass on. The routes' own desktop checks stay
// as a second layer.
//
// route-policy.test.ts reads every route out of the real dispatcher
// (testing/route-discovery.ts) and fails when one has no entry here, when two
// entries give one request two classes, or when an entry matches no route.
// Entries marked `arrives` belong to a lane that has not merged yet; they
// must match no route until it does, and then lose the mark.

import { ENGINE_LOGIN_PATH } from "./cloud-home/engine-login-engines.ts";

export type RouteClass = "desktop" | "conversation" | "companion" | "internal" | "media" | "extension" | "health" | "engine-login";
export interface RoutePolicyEntry {
  methods: readonly string[] | "*";
  path: string | RegExp;
  class: RouteClass;
  why: string;
  /** Explicit cloud write review. `ordinary` retains this entry's documented
   * purpose without additional authority; unknown write entries fail closed. */
  cloudWrite?: "ordinary" | "step-up" | "credential" | "body" | "browser-step-up";
  /** The lane whose routes these are, before it merges. */
  arrives?: "L6" | "L7" | "B2";
}

export const DESKTOP_ONLY_SENTENCE = "This needs the Murage app on your computer.";

const ID = String.raw`[\w-]+`;
const re = (source: string) => new RegExp(`^${source}$`);

export const ROUTE_POLICY: readonly RoutePolicyEntry[] = [
  { methods: ["GET"], path: ENGINE_LOGIN_PATH, class: "engine-login", arrives: "B2", why: "A paired owner desktop signs an engine in or out through the vendor's own CLI; step-up is required and a browser session is refused." },
  { methods: ["GET"], path: "/api/cloud/model-signins", class: "desktop", why: "Only paired owners read token-free home sign-in status." },
  { methods: ["GET"], path: /^\/api\/cloud\/model-signins\/(chatgpt|supergrok)\/attempts\/[A-Za-z0-9_-]{1,200}$/, class: "desktop", why: "The initiating paired device reads its pending sign-in." },
  { methods: ["POST"], path: /^\/api\/cloud\/model-signins\/(chatgpt|supergrok)\/(start|sign-out|attempts\/[A-Za-z0-9_-]{1,200}\/cancel)$/, class: "desktop", cloudWrite: "step-up", why: "A paired owner confirms a home model sign-in change." },
  { methods: ["DELETE"], path: /^\/api\/cloud\/model-signins\/(chatgpt|supergrok)$/, class: "desktop", cloudWrite: "step-up", why: "A paired owner confirms removing a home model connection." },
  { methods: "*", path: /^\/api\/cloud\/own-server(?:\/(?:confirm|test))?$/, class: "desktop", cloudWrite: "step-up", why: "A paired owner connects, checks or removes their own server for bots to use as a computer (server/cloud-home/own-server.ts)." },
  { methods: ["PUT"], path: "/api/owner/timezone", class: "desktop", cloudWrite: "ordinary", why: "The paired owner sets the home's routine time zone." },
  { methods: ["GET"], path: "/api/projects/new-options", class: "desktop", why: "The owner chooses available project members." },
  { methods: ["POST"], path: "/api/projects/proposal", class: "desktop", cloudWrite: "ordinary", why: "The owner asks the Chief for a project proposal." },
  { methods: ["POST"], path: "/api/projects", class: "desktop", cloudWrite: "ordinary", why: "The owner creates project authority and members." },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/project\/(close|reopen|export-brief)$/, class: "desktop", cloudWrite: "ordinary", why: "The owner closes, reopens or exports a project." },
  // ── health ────────────────────────────────────────────────────────────
  { methods: ["GET"], path: "/api/health", class: "health", why: "a liveness probe the companion, the MCP server and the launcher read before anything else" },
  { methods: "*", path: "/api/desktop/resource-ticket", class: "desktop", cloudWrite: "ordinary", why: "POST only (the handler answers 404 otherwise): the desktop window's single-use ticket for one URL-loaded resource (EventSource, image, download link), so the launch proof never rides in a URL; the handler answers 404 on a cloud home" },
  { methods: ["GET"], path: "/api/desktop-secret", class: "health", why: "dev launches only: hands the renderer this launch's secret, and answers 404 whenever the harness is a packaged child (devDesktopSecretOffered)" },

  // ── internal: a bot's own capability ─────────────────────────────────
  { methods: "*", path: /^\/api\/model-gateway(?:\/|$)/, class: "internal", cloudWrite: "ordinary", why: "the plan sign-in model gateway (server/model-gateway.ts): an engine inside a bot's turn, proved by its per-turn gateway key; handled before this gate and answers 401 without one" },
  { methods: "*", path: /^\/api\/internal(?:\/|$)/, class: "internal", cloudWrite: "ordinary", why: "the agents, connectors, computer and memory proxies inside a bot's turn; the block answers 401 without a live capability and 403 for the wrong kind or a channel person's refused route" },

  // ── media: a signed URL ───────────────────────────────────────────────
  { methods: "*", path: /^\/api\/media\/bytes(?:\/|$)/, class: "media", cloudWrite: "ordinary", why: "audio and video elements cannot send the desktop header; each byte URL carries its own short-lived capability" },

  // ── companion: the desktop, or the phone's forwarded launch proof ─────
  { methods: ["GET"], path: "/api/inbox", class: "companion", why: "the phone's Inbox, scoped to the conversations its sidebar shows (inbox-access.ts)" },
  { methods: ["POST"], path: "/api/inbox/state", class: "companion", cloudWrite: "ordinary", why: "read, snooze and clear marks on items inside that same list" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/voice-host`), class: "companion", cloudWrite: "ordinary", why: "the fast half of a call, for a bot the phone's sidebar shows (call-access.ts)" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/call-note`), class: "companion", cloudWrite: "ordinary", why: "the note a call leaves in its conversation, same rule" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/computer/join`), class: "companion", cloudWrite: "browser-step-up", why: "full cloud desktop access from the phone, after the companion's per-device capability check" },
  { methods: ["PATCH"], path: re(`/api/bots/${ID}/profile`), class: "companion", cloudWrite: "ordinary", why: "a bot's name, persona, avatar and voice: the persona rides every one of its turns" },
  { methods: ["DELETE"], path: re(`/api/(?:bots|groups)/${ID}/tasks/${ID}`), class: "companion", cloudWrite: "ordinary", why: "deleting a task conversation destroys its transcript" },
  { methods: ["GET", "POST"], path: "/api/mcp-grants", class: "companion", cloudWrite: "credential", why: "the owner lists and makes script access for one bot (mcp-grants.ts); a script or a bot never makes its own" },
  { methods: ["DELETE"], path: re(`/api/mcp-grants/${ID}`), class: "companion", cloudWrite: "step-up", why: "the owner switches one script access off" },
  { methods: ["POST"], path: "/api/sidebar-sections", class: "companion", cloudWrite: "ordinary", why: "filing bots into a team decides who they can reach and which team brief they read" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/work-threads`), class: "companion", cloudWrite: "ordinary", why: "open (creating on first use) the owner's work thread for a covered team, from the desktop or the paired phone (SPEC-X 12.1)" },
  { methods: ["POST"], path: re(`/api/routines/${ID}/run`), class: "companion", cloudWrite: "browser-step-up", why: "run an existing routine now, with the permissions it was given at the keyboard" },
  // the room's queue (SPEC-P 11.1, lane E1): the phone reads and steers it too
  { methods: ["GET"], path: re(`/api/groups/${ID}/requests`), class: "companion", why: "a room's queue: who waits and why, owner words only for the owner's own unsent messages" },
  { methods: ["POST"], path: re(`/api/groups/${ID}/requests/${ID}/(?:cancel|retry)`), class: "companion", cloudWrite: "ordinary", why: "cancel a waiting request, or ask again after one that ended" },
  { methods: ["POST"], path: re(`/api/groups/${ID}/project/control/(?:stop|pause|resume|redirect)`), class: "companion", cloudWrite: "ordinary", why: "project-wide Stop all, pause, resume and a steering note to the lead: owner-proved (a conversation caller keeps the per-room interrupt)" },
  { methods: "*", path: /^\/api\/bots\/[^/]+\/browser(?:\/frame)?$/, class: "companion", cloudWrite: "ordinary", why: "watching and steering a bot's browser from the phone, for a bot its sidebar shows" },
  { methods: ["POST"], path: "/api/presence", class: "companion", cloudWrite: "ordinary", why: "a visible desktop or browser tab telling the host someone is at the desk (mobile/v1 H3)" },
  { methods: "*", path: /^\/api\/mobile\/push\//, class: "companion", cloudWrite: "ordinary", why: "push enrolment and notification actions, each proved by the companion door (mobile/v1)" },
  { methods: "*", path: re(`/api/threads/${ID}/browser-setup/${ID}`), class: "companion", cloudWrite: "ordinary", why: "answering a bot's browser setup card, like any card: the desktop or the paired phone (mayApprove)" },
  { methods: "*", path: /^\/api\/bots\/[^/]+\/browser-extension$/, class: "companion", cloudWrite: "ordinary", why: "connecting, pausing or stopping a bot's Murage for Chrome session: the desktop or the paired phone (mayApprove)" },
  { methods: "*", path: /^\/api\/bots\/[^/]+\/browser-extension\/activity$/, class: "companion", cloudWrite: "step-up", why: "reading what a bot did in the owner's browser: the desktop or the paired phone (mayApprove); the handler answers GET only, with unsupported writes retaining the conservative step-up gate" },
  { methods: "*", path: /^\/api\/bots\/[^/]+\/browser-extension\/mode$/, class: "companion", cloudWrite: "step-up", why: "reading a bot's browser approval mode, and turning Full permissive off (or to ask each step) from the paired phone; the handler answers GET and PATCH only and allows turning it on from the desktop app only, with the bot's name typed" },
  { methods: "*", path: /^\/api\/bots\/[^/]+\/browser-extension\/sites$/, class: "companion", cloudWrite: "step-up", why: "reading a bot's approved sites on the phone, and Revoke (an allow back to ask); the handler answers GET and POST only and leaves every other edit to the desktop app" },

  // ── extension: a paired Murage for Chrome client ──────────────────────
  { methods: ["GET", "PUT", "PATCH", "DELETE"], path: "/api/browser-extension/mcp", class: "desktop", cloudWrite: "ordinary", why: "only POST carries a paired client's calls; the handler refuses every other method" },
  { methods: ["POST"], path: "/api/browser-extension/mcp", class: "extension", cloudWrite: "ordinary", why: "a paired external browser client's tool calls, authorized by its own client id and bearer credential, never with an Origin" },

  // ── conversation: the phone, the browser door and the MCP server ──────
  { methods: ["GET"], path: "/api/config", class: "conversation", why: "configured-or-not booleans and which surface is asking; the keys never leave" },
  { methods: ["GET"], path: "/api/events", class: "conversation", why: "the live stream; frames are scoped to what a non-desktop surface may see (sse-visibility.ts)" },
  { methods: ["GET"], path: "/api/instances", class: "conversation", why: "which engines and models exist, to pick one for a bot" },
  { methods: ["GET"], path: "/api/search", class: "conversation", why: "transcript search, scoped to visible threads off the desktop" },
  { methods: ["GET", "POST"], path: "/api/bots", class: "conversation", cloudWrite: "body", why: "the fleet (view=sidebar: the fleet without transcripts, one sidebar line per conversation), and making a bot: one made by a caller that proved nothing starts with no computer, browser or connected apps and in no team" },
  { methods: ["GET"], path: re(`/api/bots/${ID}`), class: "conversation", why: "one bot's whole record (its full description, its playbooks), no transcript, for a settings panel that booted from the roster's cut copy; the same visibility as the fleet listing" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/messages`), class: "conversation", cloudWrite: "ordinary", why: "talking to a bot; words not proven to be the owner's are recorded as unproven and never run engine commands" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/messages/${ID}/edit`), class: "conversation", cloudWrite: "ordinary", why: "edit and rerun a message, same rule" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/interrupt`), class: "conversation", cloudWrite: "ordinary", why: "stop a bot's turn" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/read`), class: "conversation", cloudWrite: "ordinary", why: "mark a conversation read" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/warm`), class: "conversation", cloudWrite: "ordinary", why: "hold a thread's idle engine ready while its composer is focused" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/typing`), class: "conversation", cloudWrite: "ordinary", why: "the owner is typing: background work holds back a few seconds (owner-first)" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/active-branch`), class: "conversation", cloudWrite: "ordinary", why: "switch between a conversation's branches" },
  { methods: ["GET"], path: re(`/api/bots/${ID}/engine-commands`), class: "conversation", why: "names of the bot's own engine commands for the composer menu" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/avatar/generate`), class: "conversation", cloudWrite: "ordinary", why: "draw a new avatar for a bot" },
  { methods: ["GET"], path: re(`/api/bots/${ID}/skills`), class: "conversation", why: "the list of a bot's skills the new-bot intake counts; installing stays on the desktop" },
  { methods: ["GET", "POST"], path: re(`/api/bots/${ID}/tasks`), class: "conversation", cloudWrite: "ordinary", why: "start a separate task conversation, or page back through the older ones the roster window leaves out" },
  { methods: ["GET", "POST", "PATCH"], path: re(`/api/bots/${ID}/tasks/${ID}`), class: "conversation", cloudWrite: "body", why: "read, open or rename a task conversation; its settings stay on the desktop" },
  // 1.0.4 SL-K / SL-I: conversation class so a paired device gets the plain 404 from the route's own desktop check (as the task settings PATCH)
  { methods: ["POST"], path: re(`/api/bots/${ID}/tasks/${ID}/permissions/refresh`), class: "desktop", cloudWrite: "step-up", why: "copy the bot's permissions onto one chat after a preview" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/threads/follow-model`), class: "desktop", cloudWrite: "ordinary", why: "chats with a model of their own go back to the bot's model" },
  { methods: ["PUT", "DELETE"], path: re(`/api/bots/${ID}/limit-backup`), class: "desktop", cloudWrite: "step-up", why: "the engine that takes over when the bot's engine hits its limit" },
  { methods: ["GET"], path: re(`/api/groups/${ID}/project`), class: "companion", why: "owner project material and decisions" },
  { methods: ["POST"], path: re(`/api/groups/${ID}/project/viewed`), class: "companion", cloudWrite: "ordinary", why: "owner project material and decisions" },
  { methods: ["PATCH"], path: re(`/api/groups/${ID}/project/brief`), class: "companion", cloudWrite: "ordinary", why: "owner project material and decisions" },
  { methods: ["GET"], path: re(`/api/groups/${ID}/project/brief/versions`), class: "companion", why: "owner project material and decisions" },
  { methods: ["GET"], path: re(`/api/groups/${ID}/project/brief/versions/[0-9]+`), class: "companion", why: "owner project material and decisions" },
  { methods: ["POST"], path: re(`/api/groups/${ID}/project/goals`), class: "companion", cloudWrite: "ordinary", why: "owner project material and decisions" },
  { methods: ["PATCH"], path: re(`/api/groups/${ID}/project/goals/${ID}`), class: "companion", cloudWrite: "ordinary", why: "owner project material and decisions" },
  { methods: ["PATCH"], path: re(`/api/groups/${ID}/project/budget`), class: "desktop", cloudWrite: "step-up", why: "raising a ceiling widens autonomy" },
  { methods: ["POST"], path: re(`/api/groups/${ID}/project/budget`), class: "desktop", cloudWrite: "step-up", why: "owner creates the period budget" },
  { methods: ["PUT"], path: re(`/api/groups/${ID}/project/work-roots`), class: "desktop", cloudWrite: "step-up", why: "owner chooses authority folders" },
  { methods: ["PATCH"], path: re(`/api/groups/${ID}/project/work-profile`), class: "desktop", cloudWrite: "step-up", why: "owner chooses file approval authority" },
  { methods: ["GET"], path: re(`/api/groups/${ID}/usage`), class: "companion", why: "usage for Details and the strip" },
  { methods: ["PATCH"], path: re(`/api/groups/${ID}/project/settings`), class: "desktop", cloudWrite: "step-up", why: "project authority and layout configuration" },
  { methods: ["GET"], path: re(`/api/groups/${ID}/board`), class: "companion", why: "owner project material and decisions" },
  { methods: ["POST"], path: re(`/api/groups/${ID}/board/cards`), class: "companion", cloudWrite: "ordinary", why: "owner project material and decisions" },
  { methods: ["PATCH"], path: re(`/api/groups/${ID}/board/cards/${ID}`), class: "companion", cloudWrite: "ordinary", why: "owner project material and decisions" },
  { methods: ["PUT"], path: re(`/api/groups/${ID}/board/columns`), class: "desktop", cloudWrite: "ordinary", why: "project authority and layout configuration" },
  { methods: ["GET"], path: re(`/api/groups/${ID}/activity`), class: "companion", why: "owner project material and decisions" },
  { methods: ["POST"], path: "/api/groups", class: "conversation", cloudWrite: "ordinary", why: "make a room" },
  { methods: ["POST"], path: re(`/api/groups/${ID}/messages`), class: "conversation", cloudWrite: "ordinary", why: "talk in a room; same unproven-origin rule as a bot" },
  { methods: ["POST"], path: re(`/api/groups/${ID}/interrupt`), class: "conversation", cloudWrite: "ordinary", why: "stop a room's turn" },
  { methods: ["POST"], path: re(`/api/groups/${ID}/read`), class: "conversation", cloudWrite: "ordinary", why: "mark a room read" },
  { methods: ["GET", "POST"], path: re(`/api/groups/${ID}/tasks`), class: "conversation", cloudWrite: "ordinary", why: "start a room task, or page back through the older ones the roster window leaves out" },
  { methods: ["GET", "POST", "PATCH"], path: re(`/api/groups/${ID}/tasks/${ID}`), class: "conversation", cloudWrite: "ordinary", why: "read, open or rename a room task" },
  { methods: ["GET"], path: re(`/api/threads/${ID}/messages`), class: "conversation", why: "a transcript page, one thread id at a time" },
  { methods: ["GET"], path: re(`/api/threads/${ID}/owner`), class: "conversation", why: "which bot or room a thread belongs to, for a link to a conversation older than the roster window" },
  { methods: ["GET"], path: re(`/api/threads/${ID}/open-cards`), class: "conversation", why: "the open request cards on the active branch of one thread" },
  { methods: ["GET"], path: re(`/api/threads/${ID}/messages/${ID}/image`), class: "conversation", why: "an image in a transcript" },
  { methods: ["POST"], path: re(`/api/threads/${ID}/messages/${ID}/reactions`), class: "conversation", cloudWrite: "ordinary", why: "react to a message" },
  { methods: ["GET"], path: re(`/api/threads/${ID}/export`), class: "conversation", why: "export one conversation" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/respond`), class: "conversation", cloudWrite: "ordinary", why: "answer a card in the bot's own thread, same rule as the thread route (mayApprove)" },
  { methods: ["POST"], path: re(`/api/threads/${ID}/respond`), class: "conversation", cloudWrite: "ordinary", why: "answer a card: anyone may decline or skip, only the desktop or the paired phone may allow or answer (mayApprove)" },
  { methods: ["POST"], path: re(`/api/threads/${ID}/widgets/${ID}/respond`), class: "conversation", cloudWrite: "ordinary", why: "press a bot's widget: only the desktop or the paired phone (mayApprove); one owner send per widget" },
  { methods: ["POST"], path: re(`/api/threads/${ID}/widgets/${ID}/reopen`), class: "conversation", cloudWrite: "ordinary", why: "reopen a settled widget's answers in a new widget (mayApprove)" },
  { methods: ["POST"], path: "/api/attachments", class: "conversation", cloudWrite: "ordinary", why: "upload an image; bound to a conversation only with the launch proof (isImageUpload)" },
  { methods: ["GET"], path: re(String.raw`/api/attachments/[\w.-]+`), class: "conversation", why: "an app-owned image by its generated name, never a path" },
  { methods: ["POST"], path: "/api/files", class: "conversation", cloudWrite: "ordinary", why: "a share-sheet document, stored under a generated name" },
  { methods: ["GET"], path: "/api/tts/voices", class: "conversation", why: "voice labels; the voice key never leaves" },
  { methods: ["POST"], path: "/api/tts/speak", class: "conversation", cloudWrite: "ordinary", why: "speak a reply; audio out, no key" },
  { methods: ["POST"], path: "/api/tts/prepare", class: "conversation", cloudWrite: "ordinary", why: "split a reply into utterances and say whether a voice is set up; reads no key, writes nothing" },
  { methods: ["POST"], path: "/api/voice/transcribe", class: "conversation", cloudWrite: "ordinary", why: "voice in: audio in, text out, the Flux key stays here" },
  { methods: "*", path: "/api/voice/stream/ticket", class: "conversation", cloudWrite: "ordinary", why: "voice in, streaming: a short-lived ticket bound to the proven principal (POST only; the handler answers 405 otherwise); the Flux key stays here" },
  { methods: "*", path: "/api/voice/stream", class: "conversation", cloudWrite: "ordinary", why: "voice in, streaming: the websocket is served at upgrade behind a single-use ticket bound to the same principal; a plain HTTP request here finds no route" },
  { methods: ["POST"], path: "/api/voice/cleanup", class: "conversation", cloudWrite: "ordinary", why: "tidy a finished dictation: text in, text out, the model key stays here; same door as transcribe" },
  { methods: ["GET"], path: "/api/routines", class: "conversation", why: "the list of routines" },

  { methods: ["GET"], path: "/api/connectors", class: "conversation", why: "opaque connected-app ids and aliases" },
  { methods: ["GET"], path: "/api/connectors/catalog", class: "conversation", why: "the connected-app catalogue" },
  { methods: ["GET"], path: "/api/connectors/catalog/cached", class: "conversation", why: "the last complete catalogue from disk; read-only" },
  { methods: ["GET"], path: "/api/connectors/catalog/search", class: "conversation", why: "catalogue search; read-only" },
  { methods: ["GET"], path: "/api/connectors/catalog/page", class: "conversation", why: "one page of the full catalogue; read-only" },
  { methods: ["GET"], path: "/api/connectors/connected", class: "conversation", why: "which apps are connected; authorizing and revoking stay on the desktop" },
  { methods: ["GET"], path: "/api/connectors/needs-reconnect", class: "desktop", why: "which connected apps need signing in again, with their account ids and labels, for the owner's Reconnect line; the handler does no per-caller scoping, so it stays with the owner's desktop" },
  { methods: ["GET"], path: "/api/library/suggest", class: "conversation", why: "the new-bot intake's suggestions; ranks, never installs" },
  { methods: ["GET"], path: "/api/library/search", class: "conversation", why: "library search for the intake" },
  { methods: ["GET"], path: "/api/library/browse", class: "conversation", why: "library facets for the intake" },
  { methods: ["GET"], path: "/api/team-library/catalog", class: "conversation", why: "the team catalogue for the intake" },
  { methods: ["GET"], path: /^\/api\/team-library\/teams\/[a-z0-9][a-z0-9-]*$/, class: "conversation", why: "one team's description for the intake" },

  // ── desktop: everything that administers Murage ────────────────────────
  { methods: ["GET"], path: "/api/decisions", class: "desktop", why: "the approval decision log" },
  // bots shared across teams (SPEC-X 12.1): owner-only reach and what rides every team
  { methods: ["GET", "PATCH"], path: re(`/api/bots/${ID}/sharing`), class: "desktop", cloudWrite: "step-up", why: "who can request this bot's work: an owner-only reach field (contract 4.3), with its load" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/sharing/skills`), class: "desktop", cloudWrite: "step-up", why: "a learned skill revision the owner lets ride every team" },
  { methods: ["GET", "PUT"], path: re(`/api/bots/${ID}/general-notes`), class: "desktop", cloudWrite: "ordinary", why: "notes that ride every team this bot works for" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/sharing/copy`), class: "desktop", cloudWrite: "step-up", why: "makes a new bot for one team (a copy per client)" },
  { methods: "*", path: /^\/api\/flux-connection(?:\/|$)/, class: "desktop", cloudWrite: "credential", why: "read, test, replace, select or remove the Flux key" },
  { methods: "*", path: /^\/api\/provider-connections(?:\/|$)/, class: "desktop", cloudWrite: "credential", why: "model provider connection custody and catalogues" },
  { methods: "*", path: /^\/api\/local-models(?:\/|$)/, class: "desktop", cloudWrite: "credential", why: "local model server addresses, keys, detection and tool tests" },
  { methods: "*", path: /^\/api\/workspace-files(?:\/|$)/, class: "desktop", cloudWrite: "ordinary", why: "workspace discovery, file read, revision-conditioned write and native open" },
  { methods: "*", path: /^\/api\/media(?:$|\/(?!bytes(?:\/|$)))/, class: "desktop", cloudWrite: "ordinary", why: "resolve scoped media, pin a reference and issue byte capabilities" },
  { methods: "*", path: /^\/api\/artifacts(?:\/|$)/, class: "desktop", cloudWrite: "ordinary", why: "verified private workspace deliverables" },
  { methods: "*", path: /^\/api\/claude-accounts(?:\/|$)/, class: "desktop", cloudWrite: "credential", why: "named native Claude account configuration" },
  { methods: "*", path: "/api/automation-admission", class: "desktop", cloudWrite: "ordinary", why: "pause or resume automatic work" },
  { methods: ["POST"], path: "/api/backup-failure-notice", class: "desktop", cloudWrite: "ordinary", why: "the desktop reports a stopped backup to the Inbox" },
  { methods: ["GET"], path: "/api/backup-waiting", class: "desktop", why: "who a held-up backup is waiting for" },
  { methods: ["POST"], path: "/api/backup-restart", class: "desktop", cloudWrite: "ordinary", why: "admit or cancel a backup restart" },
  { methods: ["GET"], path: "/api/storage", class: "desktop", why: "Settings > Storage: free disk space and what Murage keeps on this computer" },
  { methods: ["GET"], path: "/api/storage/attachments", class: "desktop", why: "Settings > Storage lists every attachment file and the conversations that use it: the owner's desktop only, never the phone, the browser door or a bot (1.0.3 R1.10)" },
  { methods: ["POST"], path: "/api/storage/attachments/remove", class: "desktop", cloudWrite: "step-up", why: "Settings > Storage removes attachment files for good (1.0.4 SL-H): the owner's local desktop only, as the list; cloudRouteDecision denies it on every Cloud scope" },
  { methods: ["POST"], path: "/api/inbox/learning-paused/leave", class: "desktop", cloudWrite: "ordinary", why: "Leave paused on the learning-paused Inbox item: sets it aside for this month (inbox-learning-paused.ts); the handler also requires the desktop door" },
  { methods: ["GET"], path: "/api/restore-holds", class: "desktop", why: "the owner lists what a restore is keeping" },
  { methods: ["POST"], path: re(`/api/restore-holds/(output_receipt|shared_result)/${ID}/release`), class: "desktop", cloudWrite: "step-up", why: "the owner releases one item a restore kept" },
  { methods: ["POST"], path: re(`/api/shared-results/${ID}/dismiss`), class: "desktop", cloudWrite: "ordinary", why: "the owner dismisses a finished shared result that cannot be delivered" },
  { methods: ["GET"], path: "/api/deletion-preview", class: "desktop", why: "what a Delete confirmation removes" },
  { methods: ["GET"], path: "/api/deletions/owed", class: "desktop", why: "engine copies of deleted conversations still owed" },
  { methods: ["POST"], path: "/api/deletions/retry", class: "desktop", cloudWrite: "ordinary", why: "Try again now for an engine copy still owed" },
  { methods: ["POST"], path: "/api/deletions/dismiss", class: "desktop", cloudWrite: "ordinary", why: "Dismiss the lines for engine copies still owed (saved, so it lasts)" },
  { methods: ["GET"], path: "/api/desktop/tray", class: "desktop", why: "the menu bar and tray menu" },
  { methods: "*", path: /^\/api\/memory(?:\/|$)/, class: "desktop", cloudWrite: "step-up", why: "memory authority, sharing, retention and configuration" },
  { methods: ["GET", "POST"], path: "/api/images/settings", class: "desktop", cloudWrite: "ordinary", why: "image provider and model selection" },
  { methods: ["GET", "POST", "DELETE"], path: /^\/api\/images\/(?:probe|library|prompt-blocks|reference-packs)(?:\/|$)/, class: "desktop", cloudWrite: "ordinary", why: "image model checks, which send a real render, and every bot's saved prompt blocks and reference packs" },
  { methods: ["PATCH", "PUT"], path: "/api/config", class: "desktop", cloudWrite: "credential", why: "application, credentials, browser and computer configuration" },
  { methods: "*", path: /^\/api\/thread-snoozes(?:\/|$)/, class: "desktop", cloudWrite: "ordinary", why: "snooze or wake a conversation" },
  { methods: "*", path: /^\/api\/about-me$/, class: "desktop", cloudWrite: "ordinary", why: "the owner's own profile" },
  { methods: "*", path: /^\/api\/house-rules(?:\/reset)?$/, class: "desktop", cloudWrite: "ordinary", why: "House Rules text and switch" },
  { methods: "*", path: /^\/api\/whats-new(?:\/seen)?$/, class: "desktop", cloudWrite: "ordinary", why: "What's New pages shown" },
  { methods: ["GET"], path: "/api/terms", class: "conversation", why: "which terms are accepted: any owner surface the door serves may read it, so a screen that cannot accept can still see that the desktop did, or say where to accept" },
  { methods: ["POST", "PUT", "PATCH", "DELETE"], path: "/api/terms", class: "companion", cloudWrite: "ordinary", why: "only GET reads the terms status; every other method on it is for the owner's desktop or paired phone" },
  { methods: "*", path: "/api/terms/accept", class: "companion", cloudWrite: "ordinary", why: "terms acceptance: the owner's desktop or paired phone accepts; nothing else can agree to the terms for them" },
  { methods: "*", path: /^\/api\/announcements(?:\/|$)/, class: "desktop", cloudWrite: "ordinary", why: "announcements seen, dismissed and their settings" },
  { methods: "*", path: /^\/api\/skills(?:\/|$)/, class: "desktop", cloudWrite: "step-up", why: "the skill collection: import, duplicate, switch on for a bot, delete" },
  { methods: ["GET", "PUT"], path: "/api/section-context", class: "desktop", cloudWrite: "ordinary", why: "persistent team instructions" },
  { methods: ["GET"], path: "/api/team-map", class: "desktop", why: "the whole team map" },
  { methods: "*", path: /^\/api\/team-sections(?:\/|$)/, class: "desktop", cloudWrite: "ordinary", why: "rename, delete and change the members and lead of a team" },
  { methods: ["POST"], path: /^\/api\/teams\/(?:import|export)$/, class: "desktop", cloudWrite: "step-up", why: "team configuration and filesystem import and export" },
  { methods: ["GET"], path: /^\/api\/teams\/scout(?:\/directory)?$/, class: "desktop", why: "scan folders on this computer for team packages" },
  { methods: ["POST"], path: "/api/team-library/github", class: "desktop", cloudWrite: "step-up", why: "download team packages to disk" },
  { methods: ["POST"], path: "/api/team-library/grok", class: "desktop", cloudWrite: "step-up", why: "read a shared Grok Bot page on x.ai or a pasted export into a package preview" },
  { methods: ["POST"], path: /^\/api\/packages\/(?:import|export)$/, class: "desktop", cloudWrite: "step-up", why: "review and commit or export a local package" },
  { methods: ["GET"], path: "/api/packages/scan-progress", class: "desktop", why: "progress of the import guard's scan of a local package; the owner's own import on the computer" },
  { methods: ["POST"], path: "/api/starter-profiles", class: "desktop", cloudWrite: "step-up", why: "review and install a local starter profile" },
  { methods: "*", path: /^\/api\/(?:telegram|slack|discord)\/(?:status|pair|resume|revoke)$/, class: "desktop", cloudWrite: "credential", why: "pair and revoke an owner channel" },
  { methods: "*", path: /^\/api\/whatsapp\/(?:status|link|approve|dismiss|resume|revoke|unlink|groups)$/, class: "desktop", cloudWrite: "credential", why: "link, approve contacts for and unlink the owner's WhatsApp number" },
  { methods: "*", path: /^\/api\/setup(?:\/|$)/, class: "desktop", cloudWrite: "ordinary", why: "the first-run checklist and its recorded answers" },
  { methods: ["GET"], path: "/api/cli-candidates", class: "desktop", why: "engine binaries found on this computer" },
  { methods: ["POST"], path: "/api/cli-test", class: "desktop", cloudWrite: "step-up", why: "execute a supplied engine binary" },
  { methods: ["POST"], path: "/api/engine-setup-command", class: "desktop", cloudWrite: "ordinary", why: "resolve a trusted engine setup recipe" },
  { methods: ["GET", "POST"], path: re(String.raw`/api/engine-management/[\w.-]+`), class: "desktop", cloudWrite: "step-up", why: "inspect and install managed engines" },
  { methods: ["PATCH"], path: re(String.raw`/api/instances/[\w.-]+`), class: "desktop", cloudWrite: "step-up", why: "change engine launch configuration" },
  { methods: ["POST"], path: re(String.raw`/api/instances/[\w.-]+/claude-update`), class: "desktop", cloudWrite: "step-up", why: "run Claude Code's own updater for a Claude engine" },
  { methods: ["GET"], path: "/api/hermes/profiles", class: "desktop", why: "the Hermes profiles on this computer, read from its files" },
  { methods: ["POST"], path: "/api/hermes/profiles/import", class: "desktop", cloudWrite: "step-up", why: "add local Hermes profiles as engines that spawn a CLI, and bots on them" },
  { methods: "*", path: /^\/api\/mcp\/servers(?:\/|$)/, class: "desktop", cloudWrite: "step-up", why: "install, probe and change MCP servers" },
  { methods: ["POST"], path: "/api/mcp/inspect", class: "desktop", cloudWrite: "step-up", why: "read a pasted link, command or snippet and probe its links" },
  { methods: "*", path: "/api/folder-trust", class: "desktop", cloudWrite: "step-up", why: "per-folder trust for an engine that gates repo-local files" },
  { methods: ["GET"], path: "/api/diagnostics/incident", class: "desktop", why: "owner-selected incident export" },
  { methods: ["POST"], path: "/api/subscribe", class: "desktop", cloudWrite: "ordinary", why: "the owner's own newsletter sign-up" },
  { methods: "*", path: /^\/api\/local-computer(?:\/|$)/, class: "desktop", cloudWrite: "step-up", why: "the shared host computer's status, lifecycle and capture" },
  { methods: ["POST"], path: "/api/routines", class: "desktop", cloudWrite: "body", why: "create a durable spawn schedule" },
  { methods: ["PATCH", "DELETE"], path: re(`/api/routines/${ID}`), class: "desktop", cloudWrite: "body", why: "change or delete a durable spawn schedule" },
  { methods: ["POST"], path: re(`/api/routines/${ID}/instructions/rollback`), class: "desktop", cloudWrite: "ordinary", why: "restore a retained routine instruction version" },
  { methods: ["POST"], path: re(`/api/routines/${ID}/always-allow(?:/remove)?`), class: "companion", cloudWrite: "step-up", why: "remember or remove a routine's own permission grant, from the desktop or the paired phone, rereading the pending card (AMEND-13 Rule 81d)" },
  { methods: ["POST"], path: "/api/routine-runs/seen-all", class: "desktop", cloudWrite: "ordinary", why: "mark every routine run seen" },
  { methods: ["POST"], path: re(`/api/routine-runs/${ID}/(?:cancel|seen)`), class: "desktop", cloudWrite: "ordinary", why: "cancel a routine run or mark it seen" },
  { methods: ["DELETE"], path: re(`/api/routine-runs/${ID}`), class: "desktop", cloudWrite: "ordinary", why: "delete one past routine run from its history" },
  { methods: ["GET", "POST"], path: "/api/calendar-calls", class: "desktop", cloudWrite: "ordinary", why: "calendar calls and creating one" },
  { methods: ["PATCH", "DELETE"], path: re(`/api/calendar-calls/${ID}`), class: "desktop", cloudWrite: "ordinary", why: "change a calendar call" },
  { methods: ["POST"], path: re(`/api/calendar-calls/${ID}/room`), class: "desktop", cloudWrite: "ordinary", why: "open a calendar call's room" },
  { methods: ["GET", "POST"], path: "/api/webhooks", class: "desktop", cloudWrite: "step-up", why: "list and create external triggers" },
  { methods: ["PATCH", "DELETE"], path: re(`/api/webhooks/${ID}`), class: "desktop", cloudWrite: "step-up", why: "change external trigger configuration" },
  { methods: ["POST"], path: re(`/api/webhooks/${ID}/(?:rotate|test)`), class: "desktop", cloudWrite: "step-up", why: "rotate or exercise an external trigger" },
  { methods: ["POST"], path: re(`/api/connectors/${ID}/authorize`), class: "desktop", cloudWrite: "credential", why: "authorize a connected account" },
  { methods: ["DELETE"], path: re(`/api/connectors/${ID}(?:/accounts/[A-Za-z0-9][A-Za-z0-9_-]{0,127})?`), class: "desktop", cloudWrite: "credential", why: "revoke connected accounts" },
  { methods: ["POST"], path: re(`/api/delegations/[\\w-]{4,64}/stop`), class: "desktop", cloudWrite: "ordinary", why: "stop a delegated task" },
  { methods: ["POST"], path: re(`/api/delegations/[\\w-]{4,160}/(?:send-again|dismiss)`), class: "desktop", cloudWrite: "ordinary", why: "send a held hand-off again, or let it go" },
  // one bot's administration
  { methods: ["PATCH", "DELETE"], path: re(`/api/bots/${ID}`), class: "desktop", cloudWrite: "body", why: "bot authority, engine, working folder and deletion" },
  { methods: ["GET", "PUT"], path: re(`/api/bots/${ID}/access`), class: "desktop", cloudWrite: "step-up", why: "review scoped connected-app authority" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/always-allow(?:/remove)?`), class: "desktop", cloudWrite: "step-up", why: "persistent permission grants" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/(?:assistant-profile|skills|skills/library)`), class: "desktop", cloudWrite: "step-up", why: "install executable instructions" },
  { methods: "*", path: re(`/api/bots/${ID}/skills/[a-z0-9-]+(?:/history|/rollback)?`), class: "desktop", cloudWrite: "step-up", why: "read, enable, change, roll back or delete an installed skill" },
  { methods: ["GET", "PUT"], path: re(`/api/bots/${ID}/memory`), class: "desktop", cloudWrite: "ordinary", why: "the bot's notebook" },
  { methods: ["GET"], path: re(`/api/bots/${ID}/memory/topics/[^/]+`), class: "desktop", why: "one notebook topic" },
  { methods: ["GET"], path: re(`/api/bots/${ID}/checkpoints`), class: "desktop", why: "working folder checkpoints" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/checkpoints/restore`), class: "desktop", cloudWrite: "ordinary", why: "restore files in a working folder" },
  { methods: ["PATCH"], path: re(`/api/bots/${ID}/cards/${ID}`), class: "companion", cloudWrite: "ordinary", why: "record the owner's own choice on a card in their conversation, from the desktop or the paired phone, like answering it (mayApprove)" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/held-continuations/${ID}/retry`), class: "desktop", cloudWrite: "step-up", why: "reauthorize a saved continuation or retry its original request" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/intake`), class: "desktop", cloudWrite: "ordinary", why: "apply the new-bot intake's answers" },
  { methods: ["DELETE"], path: re(`/api/bots/${ID}/queue/${ID}`), class: "desktop", cloudWrite: "ordinary", why: "drop a queued message" },
  { methods: ["PATCH"], path: re(`/api/bots/${ID}/message-allow`), class: "companion", cloudWrite: "step-up", why: "who a bot can message: an owner-only field; the route itself refuses any widening from the phone and lets it narrow back to My team (contract 4.3)" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/secret-cards/${ID}/(?:provided|resume|dismiss|value)`), class: "desktop", cloudWrite: "credential", why: "a secret typed on the computer (value: the dev and headless fallback only, which keeps it in config.json)" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/mcp-enable-cards/${ID}/(?:enable|dismiss)`), class: "desktop", cloudWrite: "step-up", why: "the owner's own Turn on (or Not now) for a server a bot filed switched off; the click on the computer is the approval" },
  { methods: "*", path: re(`/api/bots/${ID}/connector-cards/${ID}/(?:authorize|status|timeout|resume|dismiss)`), class: "desktop", cloudWrite: "credential", why: "authorize an account through an inline card" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/mcp-sign-in-cards/${ID}/(?:resume|dismiss)`), class: "desktop", cloudWrite: "credential", why: "settle or dismiss a link server's sign-in card; the sign-in itself runs in the desktop shell" },
  { methods: ["POST"], path: "/api/publish/netlify/check", class: "desktop", cloudWrite: "credential", why: "Connect Netlify: ask Netlify whether the sign-in or pasted token works, then settle the card; connecting happens on the computer" },
  { methods: "*", path: re(`/api/bots/${ID}/published-sites(?:/${ID}/take-down)?`), class: "desktop", cloudWrite: "step-up", why: "the sites a bot put online: list, hand an existing site to it, or take one down; the owner's own click on the computer is the approval" },
  { methods: "*", path: re(`/api/bots/${ID}/(?:learning|outcomes|feedback|lessons)(?:/[\\w/-]*)?`), class: "desktop", cloudWrite: "ordinary", why: "what a bot learned from its owner: settings, results marked, feedback and lessons (owner-private)" },
  { methods: "*", path: re(`/api/bots/${ID}/shapes`), class: "desktop", cloudWrite: "ordinary", why: "the bot's whole prompt, notes and brief included" },
  { methods: ["GET"], path: re(`/api/bots/${ID}/watch-files`), class: "desktop", why: "files a routine may watch" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/watch-proposal`), class: "desktop", cloudWrite: "ordinary", why: "answer a proposed file watch" },
  { methods: ["GET"], path: re(`/api/bots/${ID}/computer`), class: "desktop", why: "cloud computer status" },
  { methods: ["POST"], path: re(`/api/bots/${ID}/computer/(?:provision|sleep|exec|screenshot|remove)`), class: "desktop", cloudWrite: "step-up", why: "cloud computer provisioning and control" },
  { methods: "*", path: re(`/api/bots/${ID}/computer/(?:control|viewer-close)`), class: "desktop", cloudWrite: "ordinary", why: "take or hand back the cloud computer's controls" },
  { methods: "*", path: re(`/api/bots/${ID}/local-computer(?:/run|/stop|/remove|/screenshot|/keepalive)?`), class: "desktop", cloudWrite: "step-up", why: "per-bot host computer status, lifecycle and capture" },
  // one room's administration
  { methods: ["PATCH", "DELETE"], path: re(`/api/groups/${ID}`), class: "desktop", cloudWrite: "body", why: "room configuration and deletion" },
  { methods: ["PATCH"], path: re(`/api/groups/${ID}/setup`), class: "desktop", cloudWrite: "ordinary", why: "room working folder and execution setup" },
  { methods: ["DELETE"], path: re(`/api/groups/${ID}/queue/${ID}`), class: "desktop", cloudWrite: "ordinary", why: "drop a queued room message" },
  { methods: ["GET"], path: re(`/api/threads/${ID}/events`), class: "desktop", why: "one conversation's event history" },
  { methods: "*", path: /^\/api\/bots\/[^/]+\/browser-extension\/check$/, class: "desktop", cloudWrite: "step-up", why: "choosing which engine runs the browser action check: owner and desktop app only; the handler answers PATCH only" },
  { methods: "*", path: "/api/browser-extension/clients", class: "desktop", cloudWrite: "step-up", why: "pair and revoke external browser clients" },
  { methods: "*", path: "/api/browser/linux-sandbox/enable", class: "desktop", cloudWrite: "step-up", why: "Linux AppImage Enable browser: the owner approves the system administrator prompt that installs the bot browser's AppArmor profile; the desktop app only" },
  { methods: "*", path: /^\/api\/bots\/[^/]+\/browser-extension\/start-task$/, class: "desktop", cloudWrite: "step-up", why: "the owner starts a new browser task after Stop (a new binding, no grants): the desktop app only; a bot never reaches it" },
];

/** The bot or room a conversation route acts on. A caller that is not the
 * desktop gets the same answer for a hidden bot or a bot-to-bot room as for
 * one that does not exist (visibleToCompanion), whatever the route. */
export function conversationSubject(target: string): { scope: "bot"; botId: string } | { scope: "group"; groupId: string } | null {
  const bot = /^\/api\/bots\/([\w-]+)\/(?:messages(?:\/[\w-]+\/edit)?|interrupt|message-allow|read|warm|typing|active-branch|engine-commands|avatar\/generate|profile|respond|cards\/[\w-]+|skills|browser-extension(?:\/(?:activity|mode|sites))?|work-threads|tasks(?:\/[\w-]+)?)$/.exec(target);
  if (bot) return { scope: "bot", botId: bot[1]! };
  const group = /^\/api\/groups\/([\w-]+)\/(?:messages|interrupt|read|tasks(?:\/[\w-]+)?|project(?:\/[\w-]+)*|board(?:\/[\w-]+)*|activity|usage|requests(?:\/[\w-]+)*)$/.exec(target);
  if (group) return { scope: "group", groupId: group[1]! };
  return null;
}

/** The entry that decides this request, or undefined (desktop-only). */
export function routePolicy(method: string, path: string): RoutePolicyEntry | undefined {
  return ROUTE_POLICY.find(entry => (entry.methods === "*" || entry.methods.includes(method))
    && (typeof entry.path === "string" ? entry.path === path : entry.path.test(path)));
}

/** The class of a request. Anything unlisted is desktop-only. */
export function routeClass(method: string, path: string): RouteClass {
  return routePolicy(method, path)?.class ?? "desktop";
}

/** Who a request proved it is, as far as the gate needs to know. */
export interface RouteCaller {
  desktop: boolean;
  /** The phone's companion forwarded it with the launch proof. */
  companion: boolean;
  /** The companion forwarded it from a phone or the browser door, with the
   * launch secret in the door header: it vouches for where the request came
   * from, not that the person behind it is the owner. */
  door: boolean;
  /** A live internal capability (a bot's turn). Never admits a conversation route. */
  bot: boolean;
}

/** May this caller reach a route of this class at the gate? The classes
 * whose proof lives in the route (internal, media, extension) and the open
 * one (health) pass here; their routes decide. A conversation route needs a
 * proven caller: the desktop, or the companion (launch proof or door header).
 * A bot's internal capability is NEVER admitted here: a bot's own shell runs
 * on this computer, and its tools reach the harness through its scoped
 * /api/internal/* routes (and /api/box, /api/repo, /api/opencode), not
 * through the conversations. */
export function routeAdmits(routeClassName: RouteClass, caller: RouteCaller): boolean {
  if (caller.desktop) return true;
  if (routeClassName === "desktop" || routeClassName === "engine-login") return false;
  if (routeClassName === "companion") return caller.companion;
  // Audit C5: loopback is not a proof, and neither is a bot's capability. A
  // bot's shell must not read the fleet, transcripts or search, or send into
  // and stop other bots' conversations.
  if (routeClassName === "conversation") return caller.companion || caller.door;
  return true;
}

/** The refusal for a caller the gate turns away: a sentence for one that
 * proved who it is, and nothing that confirms the route for anyone else.
 * A conversation route answers every refused caller, a bot included, exactly
 * as an unknown route does. */
export function routeRefusal(caller: RouteCaller, routeClassName?: RouteClass): { status: 403 | 404; body: { error: string } } {
  if (routeClassName === "conversation") return { status: 404, body: { error: "no such route" } };
  return caller.bot || caller.companion
    ? { status: 403, body: { error: DESKTOP_ONLY_SENTENCE } }
    : { status: 404, body: { error: "no such route" } };
}

/** Cloud requests enter the paired owner device door. All scope and sensitive
 * operation decisions stay here, alongside the existing desktop inventory.
 *
 * Door and device routes answered in server/cloud-request-auth.ts before or beside this decision:
 *  - GET /api/cloud/door-state, POST /api/cloud/enter, POST /api/cloud/enter/report: unauthenticated door routes (ticket and device
 *    key proof, per-source limits). The first door's /api/cloud/enter/pair and its door cookie no longer exist.
 *  - POST /api/cloud/devices/list and /api/cloud/devices/revoke: home management, HMAC-signed by the control plane
 *    (operation === path), like /api/cloud/stop.
 *  - GET /api/cloud/devices and POST /api/cloud/devices/forget: any paired device lists the home's devices (30 a minute) or
 *    forgets itself; answered before this function, so the `devices/<id>` sensitivity below never applies to them. */
export type CloudRouteDecision = "allow" | "deny" | "step-up required";
export function cloudRouteDecision(method: string, targetRoute: string, scope: import("./cloud-sessions.ts").CloudScope | "owner-browser" | "anonymous",
  body: unknown, steppedUp = false): CloudRouteDecision {
  const entry = routePolicy(method,targetRoute);
  const write = !["GET","HEAD","OPTIONS"].includes(method);
  if (targetRoute === "/api/desktop-secret") return "deny";
  // Remove deletes files for good: local desktop only, never a Cloud home (1.0.4 SL-H)
  if (targetRoute === "/api/storage/attachments/remove") return "deny";
  const credential = write && entry?.cloudWrite === "credential";
  const serialized = body !== null && typeof body === "object" ? JSON.stringify(body) : "";
  const elevated = write && (/"(?:fullAccess|noLimits|acknowledgeFullAccess|acknowledgeNoLimits|fullAccessChannelMessages|fullAccessSetupRequests|autoApprove|acknowledgeLocalAuto)"\s*:\s*true/.test(serialized)
    || /"alwaysAllow"\s*:/.test(serialized)
    || /"permissionMode"\s*:\s*"(?:auto|full|unlimited)"/.test(serialized)
    || /"computer"\s*:\s*"local"/.test(serialized)
    || /"hostComputerConsent"\s*:\s*"allowed"/.test(serialized));
  const sensitive = credential || elevated || (write && entry?.cloudWrite === "step-up")
    || (write && !entry?.cloudWrite)
    || /^\/api\/cloud\/(?:pairing|devices\/[^/]+|account|recovery\/)/.test(targetRoute)
    || /^\/api\/(?:move|lend)\/(?:commit|undo|scopes)/.test(targetRoute)
    || (method === "DELETE" && /^\/api\/(?:bots|groups)\/[\w-]+$/.test(targetRoute));
  if (scope === "anonymous") return entry && (entry.class === "health" || (entry.class === "media" && ["GET", "HEAD"].includes(method))) ? "allow" : "deny";
  if (scope === "service") return entry && ["health","internal","media","extension"].includes(entry.class) ? "allow" : "deny";
  // An engine sign-in terminal is a credential flow even though it opens with a
  // GET upgrade: owner-desktop only, and always behind a step-up assertion.
  if (entry?.class === "engine-login") return scope !== "owner-desktop" ? "deny" : steppedUp ? "allow" : "step-up required";
  // An owner browser (passkey device of the home owner) has the desktop owner's route access: every route the desktop session reaches, with the same step-up on the same sensitive writes. The credential terminal (engine-login) is already owner-desktop only above.
  if (scope === "owner-browser") return sensitive && !steppedUp ? "step-up required" : "allow";
  if (scope === "browser") {
    const settingsRead = cloudSettingsRead(method,targetRoute);
    if (write && entry?.cloudWrite === "browser-step-up") return elevated ? "deny" : steppedUp ? "allow" : "step-up required";
    return !sensitive && (settingsRead || (entry && ["conversation","companion","health","media"].includes(entry.class))) ? "allow" : "deny";
  }
  if (scope === "owner-phone" && (credential || elevated)) return "deny";
  if (sensitive && !steppedUp) return "step-up required";
  // Unknown targetRoutes keep the desktop default; concrete handler still decides 404.
  return "allow";
}

/** Read only bodies whose authority depends on their content. Upload and chat
 * streams retain their existing readers, limits and cancellation behavior. */
export function cloudRouteNeedsBody(method: string, targetRoute: string): boolean {
  if (["GET","HEAD","OPTIONS"].includes(method)) return false;
  return method === "DELETE" || targetRoute.startsWith("/api/cloud/")
    || /^\/api\/(?:bots|threads)\/[\w-]+\/respond$/.test(targetRoute)
    || routeClass(method,targetRoute) === "desktop"
    // A step-up or credential write binds its assertion to the body, so it is read whatever its class (the train moved some owner-only writes to the companion class).
    || ["body", "browser-step-up", "step-up", "credential"].includes(routePolicy(method,targetRoute)?.cloudWrite ?? "")
    || (method === "PATCH" && /^\/api\/bots\/[\w-]+(?:\/tasks\/[\w-]+)?$/.test(targetRoute));
}

export function cloudSettingsRead(method: string, targetRoute: string): boolean {
  return method === "GET" && /^\/api\/(?:config|about-me|house-rules|images\/settings|provider-connections|flux-connection)$/.test(targetRoute);
}
