// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The release door: POST /api/internal/turn-release/v1/verdict, the one route a spawned proxy child talks to before any of its bytes
// may reach an engine (proxy-turn-release.ts). Owners: index.ts owns the HTTP server and calls this handler for that path, unchanged
// in behaviour; consuming-turn-ingress.ts owns the authority behind it; cause22 caps (1.0.21) owns the owner-turn body bound and the
// owner header. It lives here, outside index.ts, so the door a real proxy child meets can be run as it ships, without the whole server
// (cause22-owner-caps-proxy-1021.test.ts): the handler below is the code index.ts runs, not a copy.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { createProxyReleaseAuthority } from "./consuming-turn-ingress.ts";
import { denyConsumingHttp } from "./consuming-turn-response.ts";
import { logSwallowedConsumingError } from "./consuming-error-log.ts";
import type { InternalCapabilities } from "./internal-capabilities.ts";
import { OWNER_TURN_HEADER } from "./owner-turn-caps.ts";
import { readBody } from "./read-body.ts";
import { TURN_RELEASE_WAIT_MS } from "./turn-release-wait.ts";

export interface TurnReleaseDoorPorts {
  capabilities: Pick<InternalCapabilities, "resolve" | "releaseControl">;
  authority: ReturnType<typeof createProxyReleaseAuthority>;
  /** The server's JSON answer (index.ts `json`). */
  json(res: ServerResponse, status: number, body: unknown): void;
}

/** Dedicated control authority. This response terminates at the release client, never at the ordinary tool-response facade or engine
 * stdin. */
export async function handleTurnReleaseDoor(req: IncomingMessage, res: ServerResponse, ports: TurnReleaseDoorPorts): Promise<void> {
  const { capabilities, authority, json } = ports;
  const claim = capabilities.resolve(req.headers.authorization);
  const control = claim && capabilities.releaseControl(claim);
  if (req.method !== "POST" || !claim || !control) {
    logSwallowedConsumingError("http.turn-release:unauthorized", Object.assign(new Error("TURN_RELEASE_UNAUTHORIZED"), {
      code: req.method !== "POST" ? "method" : !claim ? "no-claim" : "no-control" }));
    if (claim) authority.seal(claim);
    return denyConsumingHttp(res);
  }
  const seal = () => authority.seal(claim);
  const deadline = setTimeout(() => { seal(); req.destroy(); }, TURN_RELEASE_WAIT_MS);
  deadline.unref();
  try {
    req.once("aborted", seal);
    res.once("close", () => { if (!res.writableFinished) seal(); });
    res.once("error", seal);
    // MAIN-RULING cause22-no-transport-caps: on the owner's turn the door reads a body of any size. A turn that is not the owner's keeps
    // its 16 MiB + 1024 limit (MAIN 2026-11-22T20:25:47Z: not a cause22 cap). Each 200 answer tells the child whose turn it serves.
    const body = await readBody(req, authority.ownerTurn(claim) ? Number.POSITIVE_INFINITY : 16 * 1024 * 1024 + 1024);
    if (body && typeof body === "object" && (body as { operation?: unknown }).operation === "upstream") {
      authority.reserveUpstream(claim, body);
      if (authority.ownerTurn(claim)) res.setHeader(OWNER_TURN_HEADER, "1");
      return json(res, 200, { reserved: true });
    }
    const envelope = authority.verdict(claim, body);
    if (authority.ownerTurn(claim)) res.setHeader(OWNER_TURN_HEADER, "1");
    return json(res, 200, envelope);
  } catch (error) {
    logSwallowedConsumingError("http.turn-release", error);
    seal();
    // cause22: the refusing check's own verdict travels to the door's answer (the budget line and its header on a budget stop).
    return denyConsumingHttp(res, undefined, error);
  } finally { clearTimeout(deadline); }
}
