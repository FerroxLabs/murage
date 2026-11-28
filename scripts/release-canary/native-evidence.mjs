// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function sha256(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

export function feedWitness(events, channel, payload) {
  const atom = events.findIndex(event => event.route === "atom" && event.status === 200);
  const latest = events.findIndex((event, i) => i > atom && event.route === "latest" && event.status === 200);
  const yml = events.findIndex((event, i) => i > latest && event.route === "asset" && event.name === channel && event.status === 200);
  const transfer = events.slice(yml + 1).filter(event => event.route === "asset" && event.name === payload);
  if (atom < 0 || latest < 0 || yml < 0 || events.some(event => event.route === "denied") ||
      !transfer.some(event => event.status === 200 || event.status === 206)) throw Error("FEED");
  return transfer.some(event => event.status === 200) ? "full" : "range";
}

export function memoryState({ status, body }) {
  if (status === 503) return "STARTING";
  if (status !== 200 || body?.app !== "murage" || !body.launch) return "UNKNOWN";
  const { upgrade, memoryIntegrity: integrity } = body;
  if (integrity?.hold || upgrade?.held === true) return "HELD";
  if (upgrade?.checking === true) return "CHECKING";
  if (integrity?.integrityPending === true || integrity?.replayHeld === true) return "PENDING";
  if (upgrade?.checking === false && upgrade?.held === false &&
      integrity?.integrityPending === false && integrity?.replayHeld === false && integrity.hold === null) return "SETTLED";
  return "UNKNOWN";
}

export async function waitForMemory(read, elapsed, pause, limit, statesSeen = []) {
  while (elapsed() < limit) {
    const state = await read();
    if (!statesSeen.includes(state)) statesSeen.push(state);
    if (state === "SETTLED" && elapsed() < limit) return { settled_s: Math.ceil(elapsed()), states_seen: statesSeen };
    if (state === "HELD") break;
    await pause();
  }
  throw Error("MEMORY_STUCK");
}

export function turnWitness(messages, events, token) {
  const final = messages.findLast(row => row.role === "bot" && row.kind === "text" && row.actorKind !== "murage");
  if (!final?.turnId || final.text?.trim() !== token) return null;
  const terminal = events.findLast(event => event.type === "turn.completed" && event.turnId === final.turnId);
  return terminal?.ok === true && !terminal.stopReason ? final.id : null;
}
