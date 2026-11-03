// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shape checks for the snapshot replies the store applies whole (PHONE-HYDRATE-BAD-BODY, 11-02). A phone on a
// reconnect got a /api/routines reply with no `runs`; the store handed `undefined` to the reducer and the whole UI
// stopped drawing. Each check returns the fields it found or throws, so a bad reply keeps the current state and the
// part's own retry asks again. An HTML page, `{}`, `null` or a field of the wrong type all count as bad.

export class MalformedReplyError extends Error {
  constructor(path: string, field: string) {
    super(`${path} answered without a usable ${field}; keeping what is on screen and asking again`);
    this.name = "MalformedReplyError";
  }
}

type Body = Record<string, unknown>;

function objectBody(path: string, body: unknown): Body {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new MalformedReplyError(path, "body");
  return body as Body;
}

function list<T>(path: string, body: Body, field: string): T[] {
  const value = body[field];
  if (!Array.isArray(value)) throw new MalformedReplyError(path, field);
  return value as T[];
}

/** An optional list: absent is fine (an older server), anything else that is not a list is not. */
function optionalList<T>(path: string, body: Body, field: string): T[] | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  return list<T>(path, body, field);
}

export function routinesReply<R, U>(body: unknown): { routines: R[]; runs: U[] } {
  const path = "/api/routines";
  const reply = objectBody(path, body);
  return { routines: list<R>(path, reply, "routines"), runs: list<U>(path, reply, "runs") };
}

export function instancesReply<I>(body: unknown): { instances: I[]; shellEnvironment: unknown; engineNote: string | undefined } {
  const path = "/api/instances";
  const reply = objectBody(path, body);
  return {
    instances: list<I>(path, reply, "instances"),
    shellEnvironment: reply.shellEnvironment,
    engineNote: typeof reply.engineNote === "string" ? reply.engineNote : undefined,
  };
}

/** Every /api/config answer, desktop or scoped, names the surface and carries the connected apps block the Settings pages read;
 * an error object or `{}` has neither, and applying it would replace a working config with an empty one. */
export function configReply<C>(body: unknown): C {
  const path = "/api/config";
  const reply = objectBody(path, body);
  if (typeof reply.surface !== "string") throw new MalformedReplyError(path, "surface");
  if (!reply.composio || typeof reply.composio !== "object" || Array.isArray(reply.composio)) throw new MalformedReplyError(path, "connected apps block");
  return reply as C;
}

/** GET /api/threads/:id/open-cards. A missing card list is not an empty one: applying it would clear the held cards. */
export function openCardsReply<M>(body: unknown): { activeLeafId: string | undefined; openCards: M[]; pending: boolean } {
  const path = "/api/threads/open-cards";
  const reply = objectBody(path, body);
  return {
    activeLeafId: typeof reply.activeLeafId === "string" ? reply.activeLeafId : undefined,
    openCards: list<M>(path, reply, "openCards"),
    pending: reply.pending === true,
  };
}

export function webhooksReply<W, A>(body: unknown): { webhooks: W[]; attempts: A[]; ingress: unknown } {
  const path = "/api/webhooks";
  const reply = objectBody(path, body);
  return { webhooks: list<W>(path, reply, "webhooks"), attempts: optionalList<A>(path, reply, "attempts") ?? [], ingress: reply.ingress };
}

/** The sidebar roster: `bots` must be a list; `groups` may be absent on an older server, never another type. */
export function sidebarReply(body: unknown): Body {
  const path = "/api/bots";
  const reply = objectBody(path, body);
  list(path, reply, "bots");
  optionalList(path, reply, "groups");
  return reply;
}
