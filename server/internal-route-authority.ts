// Which internal routes a CHANNEL PERSON's turn may reach.
//
// The internal surface is the agents-proxy's private API, and most of it is
// the owner's: workspace management (bots, routines, skills), the connectors,
// the computer. Somebody talking to a bot from Slack or Discord holds none of
// those grants, so their turn is refused everything outside this list — which
// is exactly what the refusal sentence says.
//
// What belongs ON the list is the mirror of that sentence: a route that grants
// none of the three and whose effect is confined to the turn's own
// conversation. Peer discovery and delegation are here because a channel
// person's bot may still ask its teammates for help. The oversized-result
// cache is here because it holds the turn's OWN output, parked and paged back
// under the (bot, thread) of the live capability and readable from nowhere
// else (tool-results.ts enforces both). Leaving it off withheld no grant: it
// silently cut a channel person's answer off at the preview and made the tail
// unreachable, where before the overflow limiter existed they were handed the
// whole thing.
//
// This lives outside index.ts so the decision can actually be RUN against a
// real channel principal, which is why the gap went unnoticed: nothing in the
// suite could drive one through the route.
import { isWorkspaceOwner, type HumanPrincipal } from "./human-principals.ts";
import type { InternalCapabilityKind } from "./internal-capabilities.ts";

export const CHANNEL_PERSON_INTERNAL_ROUTES: readonly string[] = [
  "/api/internal/agents",
  "/api/internal/ask-bot",
  "/api/internal/delegate-bot",
  "/api/internal/check-delegation",
  "/api/internal/wait-delegation",
  // the turn's own oversized result, parked and paged back — never anyone else's
  "/api/internal/tool-result",
];

/** One delegation receipt, by id. */
const DELEGATION_RECEIPT = /^\/api\/internal\/delegations\/[\w-]{4,64}$/;

export const CHANNEL_PERSON_INTERNAL_REFUSAL =
  "This channel person has no workspace management, connector, or computer grant.";

export function channelPersonMayUseInternalRoute(path: string, kind: InternalCapabilityKind): boolean {
  // Memory has its own authority model (memoryAccess), applied per route
  // inside the memory handler; this gate must not pre-empt it.
  if (kind === "memory") return true;
  return CHANNEL_PERSON_INTERNAL_ROUTES.includes(path) || DELEGATION_RECEIPT.test(path);
}

/** The refusal this internal request earns, or null when it may proceed. */
export function internalRouteRefusal(input: {
  path: string;
  kind: InternalCapabilityKind;
  principal: HumanPrincipal;
}): string | null {
  if (isWorkspaceOwner(input.principal)) return null;
  return channelPersonMayUseInternalRoute(input.path, input.kind) ? null : CHANNEL_PERSON_INTERNAL_REFUSAL;
}
