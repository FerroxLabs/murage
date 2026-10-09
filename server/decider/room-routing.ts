// Copyright OpenMausBot contributors
// SPDX-License-Identifier: Apache-2.0
//
// NOTICE: lifted from OpenMausBot (Apache-2.0), adapted for Murage and Flux Router.
// The decision model's first job: who answers a room message nobody was
// @mentioned in, for rooms set to "Auto".
//
// One Choice over the room's active bots, keyed by bot id and described by
// name, title and description, plus __everyone__ for a message that needs
// several members. The state is the room, its people, the last room lines
// and the new message: the shape that routed 53 of 53 bench messages.
//
// Acting on it: a bot or __everyone__ at p >= 0.6 answers; anything less
// sure, and any failure at all, falls back to the room's lead (or its first
// member), which is exactly what a lead-mode room does today. Nothing here
// throws.
import type { Decider } from "./index.ts";
import type { DeciderLogRow } from "./log.ts";
import type { DeciderFailure } from "./types.ts";

/** Flux ends the call itself at 1.1 s; typical answers take 300–550 ms. A turn
 * never waits longer than this for the choice, then the lead answers. */
export const ROOM_ROUTING_TIMEOUT_MS = 1_200;
/** Bench calibration: answers at >= 0.6 were right 92–99% of the time. */
export const ROOM_ROUTING_MIN_PROBABILITY = 0.6;
export const MIN_PROBABILITY = ROOM_ROUTING_MIN_PROBABILITY;
export const EVERYONE_OPTION = "__everyone__";
const EVERYONE_MEANING = "Several members: the message explicitly needs answers or work from more than one member of the room, for example it asks everyone or asks each member for their part.";
/** The room-routing question, fixed so every call is the same shape. */
export const ROOM_ROUTING_INSTRUCTIONS = "Which bot in this room should answer `new_message`? Choose __everyone__ only when the message needs several members to answer.";
/** Every key the state may carry; `recent_messages` is left out when there are none. */
export const ROOM_ROUTING_STATE_KEYS = ["room", "humans_in_room", "bots_in_room", "recent_messages", "new_message"] as const;

const NAME_MAX = 80;
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;
const LINE_MAX = 300;
const MESSAGE_MAX = 1_500;
const BOTS_LISTED_MAX = 30;
/** Flux refuses a state over 2,048 tokens (422 state_too_long). Stay well
 * under it with a deliberately pessimistic estimate: large irrelevant state
 * also makes the classifier worse, not better. */
export const ROOM_ROUTING_STATE_TOKEN_BUDGET = 1_600;
/** The whole request (state plus the bots' descriptions) is kept under this as
 * well, so no part of it can push the call over the limit. */
export const ROOM_ROUTING_REQUEST_TOKEN_BUDGET = 1_900;

/** Pessimistic token estimate: plain ASCII about 3 characters a token, any
 * other character (accents, CJK, emoji) one token or more each. */
export function estimateStateTokens(value: unknown): number {
  const json = JSON.stringify(value) ?? "";
  let ascii = 0;
  let other = 0;
  for (const char of json) {
    if (char.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3) + other;
}

export interface RoomRoutingMember {
  id: string;
  name: string;
  title?: string;
  description?: string;
}

export interface RoomRoutingInput {
  room: string;
  humans: string[];
  /** Active members only, in room order. */
  members: RoomRoutingMember[];
  /** Oldest first; already limited to the room's context window. */
  recent: Array<{ from: string; text: string }>;
  message: { from: string; text: string };
}

export type RoomRoute =
  | { kind: "member"; botId: string; probability: number }
  | { kind: "everyone"; probability: number }
  | { kind: "fallback"; reason: DeciderFailure | "low_confidence" | "no_choice" };

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What one bot is, as an option: "Maya, Product Designer. Owns UI…". */
export function memberOption(member: RoomRoutingMember): string {
  const name = clip(member.name, NAME_MAX) || "Unnamed bot";
  const title = member.title ? clip(member.title, TITLE_MAX) : "";
  const description = member.description ? clip(member.description, DESCRIPTION_MAX) : "";
  return `${name}${title ? `, ${title}` : ""} bot.${description ? ` ${description}` : ""}`;
}

/** The text, or its start and end around an ellipsis when it is too long. */
function clipMiddle(value: string, max: number): string {
  const flat = value.trim();
  const chars = [...flat];
  if (chars.length <= max) return flat;
  const head = Math.ceil(max * 0.7);
  return `${chars.slice(0, head).join("")} … ${chars.slice(chars.length - (max - head - 3)).join("")}`;
}

export function roomRoutingRequest(input: RoomRoutingInput) {
  const options: Record<string, string> = {};
  // Bots' descriptions shrink, then go, before history or the new message do.
  let optionTokens = 0;
  for (const [descMax, titleMax] of [[DESCRIPTION_MAX, TITLE_MAX], [80, 40], [0, 0]] as const) {
    for (const member of input.members) {
      options[member.id] = memberOption({ ...member, title: member.title ? clip(member.title, titleMax) : "", description: member.description ? clip(member.description, descMax) : "" });
    }
    options[EVERYONE_OPTION] = EVERYONE_MEANING;
    optionTokens = estimateStateTokens(options);
    if (optionTokens <= 700) break;
  }
  const base = (messageMax: number, nameMax: number) => ({
    room: clip(input.room, nameMax),
    humans_in_room: input.humans.slice(0, 5).map((human) => clip(human, nameMax)),
    bots_in_room: input.members.slice(0, BOTS_LISTED_MAX).map((member) => clip(member.name, nameMax)),
    new_message: { from: clip(input.message.from, nameMax), text: clipMiddle(input.message.text, messageMax) },
  });
  // The new message and who is in the room come first; history takes what is
  // left, newest lines first. If even the fixed part is too big, shrink it.
  let fixed = base(MESSAGE_MAX, NAME_MAX);
  for (const [messageMax, nameMax] of [[800, 40], [400, 24], [200, 16]] as const) {
    if (estimateStateTokens(fixed) <= ROOM_ROUTING_STATE_TOKEN_BUDGET) break;
    fixed = base(messageMax, nameMax);
  }
  const recent: RoomRoutingInput["recent"] = [];
  for (let index = input.recent.length - 1; index >= 0; index--) {
    const line = input.recent[index]!;
    const text = clip(line.text, LINE_MAX);
    if (!text) continue;
    const candidate = [{ from: clip(line.from, NAME_MAX), text }, ...recent];
    const size = estimateStateTokens({ ...fixed, recent_messages: candidate });
    if (size > ROOM_ROUTING_STATE_TOKEN_BUDGET || size + optionTokens > ROOM_ROUTING_REQUEST_TOKEN_BUDGET) break;
    recent.unshift(candidate[0]!);
  }
  const { new_message, ...head } = fixed;
  const state = { ...head, ...(recent.length ? { recent_messages: recent } : {}), new_message };
  return { state, question: { instructions: ROOM_ROUTING_INSTRUCTIONS, options } };
}

/** Ask once and turn the answer into a route. Never throws. */
export async function decideRoomResponder(
  decider: Pick<Decider, "choose">,
  input: RoomRoutingInput,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RoomRoute> {
  try {
    if (input.members.length < 2) return { kind: "fallback", reason: "no_choice" };
    const { state, question } = roomRoutingRequest(input);
    const result = await decider.choose("roomRouting", state, question, {
      timeoutMs: options.timeoutMs ?? ROOM_ROUTING_TIMEOUT_MS,
      signal: options.signal,
    });
    if (!result.ok) return { kind: "fallback", reason: result.reason };
    const { choice, pTop } = result.answers;
    if (pTop < ROOM_ROUTING_MIN_PROBABILITY) return { kind: "fallback", reason: "low_confidence" };
    if (choice === EVERYONE_OPTION) return { kind: "everyone", probability: pTop };
    if (!input.members.some((member) => member.id === choice)) return { kind: "fallback", reason: "malformed" };
    return { kind: "member", botId: choice, probability: pTop };
  } catch {
    return { kind: "fallback", reason: "malformed" };
  }
}

const FALLBACK_WHY: Record<string, string> = {
  low_confidence: "not sure enough, so the lead answered",
  no_choice: "only one bot in the room",
  plan_required: "not available on this account right now, so the lead answered",
  timeout: "took too long, so the lead answered",
  disabled: "switched off, so the lead answered",
  job_off: "switched off, so the lead answered",
  no_key: "no Flux Router connection, so the lead answered",
};

/** A local-log row saying who was picked and why, for the activity view. No
 * room text, and it is never put in the chat. */
export function routeLogRow(route: RoomRoute, now: Date = new Date()): DeciderLogRow {
  const why = route.kind === "fallback" ? FALLBACK_WHY[route.reason] ?? "could not decide, so the lead answered" : undefined;
  return {
    at: now.toISOString(), seam: "roomRouting", provider: "flux", ok: route.kind !== "fallback",
    choice: route.kind === "member" ? route.botId : route.kind === "everyone" ? EVERYONE_OPTION : null,
    pTop: route.kind === "fallback" ? null : route.probability, margin: null, latencyMs: 0, inputTokens: null, stateHash: "route",
    route: { kind: route.kind, ...(route.kind === "member" ? { botId: route.botId } : {}), ...(why ? { why } : {}) },
  };
}
