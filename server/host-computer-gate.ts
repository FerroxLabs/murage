// The harness half of the Windows computer-use fences (DESIGN 1022-cua-windows D10, D15, D17, D20).
// Owners: the Windows builder lane (build-1022-cua-windows) owns this module; electron main owns the other side of every
// message (shared/cua-host-messages.mjs). The host route (server/index.ts `/api/internal/host-computer`) folds
// `hostGateRefusal` into its `authorized()`, so every term is checked at entry, after the per-action card, every 100 ms
// while a call runs, and by the broker right before the action is sent.
import {
  CUA_GENERATION,
  HOST_DESKTOP,
  HOST_DESKTOP_READY,
  hostDesktopReadyMessage,
  integrityMessage,
  parseHostMessage,
  stuckMessage,
} from "../shared/cua-host-messages.mjs";
import { botUsesHostComputer } from "./local-routing.ts";
import type { LocalComputerConnection } from "./local-computer.ts";
import { HostComputerBroker } from "./host-computer-broker.ts";

export type HostGateRefusal =
  | { code: "host-locked" }
  | { code: "host-off"; cause: "bot-off" | "disable" | "restart" | "integrity" | "quit" | "update" };

type WithdrawCause = "disable" | "restart" | "integrity" | "quit" | "update";

/** One harness process's view. Every harness process starts here: desktop unknown (= refuse), no live generation. */
export function createHostGateState() {
  let hostDesktop: "locked" | "active" | "unknown" = "unknown";
  let liveGeneration: string | null = null;
  const withdrawn = new Map<string, WithdrawCause>();
  return {
    get hostDesktop() { return hostDesktop; },
    get liveGeneration() { return liveGeneration; },
    withdrawnCause: (generation: string) => withdrawn.get(generation),
    /** The registered handler for main's messages. true when the message was one of ours. */
    onHostMessage(message: unknown): boolean {
      const parsed = parseHostMessage(message);
      if (!parsed) return false;
      if (parsed.type === HOST_DESKTOP) { hostDesktop = parsed.state; return true; }
      if (parsed.type === CUA_GENERATION) {
        if ("live" in parsed) {
          // a generation main already withdrew in this harness never becomes live again
          liveGeneration = parsed.live !== null && withdrawn.has(parsed.live) ? null : parsed.live;
        } else if ("withdrawn" in parsed) {
          withdrawn.set(parsed.withdrawn, parsed.cause);
          if (liveGeneration === parsed.withdrawn) liveGeneration = null;
        }
        return true;
      }
      return parsed.type === HOST_DESKTOP_READY;
    },
  };
}
export type HostGateState = ReturnType<typeof createHostGateState>;

/** The one harness-process state (a new harness process starts fresh, so it starts unknown with no live generation). */
export const hostGate = createHostGateState();

/** The harness's one handler for main's messages: the gate state first, then the broker's own generation fence
 * (DESIGN 1022-cua-windows C4: `withdrawn:G` refuses new calls on G and keeps its claim; `retired:G` with
 * exitConfirmed closes G's sessions, answers its waiting calls and clears its claim). true when the message was ours. */
export function handleHostMessage(message: unknown, broker: Pick<HostComputerBroker, "withdrawGeneration" | "retireGeneration">, state: HostGateState = hostGate): boolean {
  if (!state.onHostMessage(message)) return false;
  const parsed = parseHostMessage(message);
  if (parsed?.type === CUA_GENERATION) {
    if ("withdrawn" in parsed) broker.withdrawGeneration(parsed.withdrawn);
    else if ("retired" in parsed) broker.retireGeneration(parsed.retired, { exitConfirmed: parsed.exitConfirmed });
  }
  return true;
}

/** The harness's one broker (server/index.ts). Its two hooks tell main about generation G at once: a failed integrity
 * check (`murage:cua-integrity {G}`, D6 b) and a driver child lost under a started action (`murage:cua-stuck {G}`, C8 /
 * D16 a), so main runs the D15 stop and the claim clears on `retired:G`. A descriptor without a generation posts nothing. */
export function createHostComputerBroker(post: ((message: object) => void) | undefined, start?: ConstructorParameters<typeof HostComputerBroker>[0]): HostComputerBroker {
  const tell = (message: object) => { try { post?.(message); } catch { /* main re-reads the driver state on its own clock */ } };
  return new HostComputerBroker(start, {
    onIntegrity: generation => { if (generation) tell(integrityMessage(generation)); },
    onUnconfirmedLoss: generation => { if (generation) tell(stuckMessage(generation)); },
  });
}

/** The harness tells main it is listening, so main re-sends the desktop state and `live` (D10 a, D20). */
export function announceHostGateReady(post: ((message: object) => void) | undefined): void {
  try { post?.(hostDesktopReadyMessage()); } catch { /* main re-sends on the next server start */ }
}

/** Which gate term refuses this call now, or null when every term holds.
 *  - selection (D17 a, all platforms): the bot's CURRENT setting, read from the store, still puts it on this computer;
 *  - generation (D15/D20, win32): the descriptor the turn uses names G, main named G live in THIS harness, G not withdrawn;
 *  - desktop (D10, win32, tools/call only): the desktop is `active`. */
export function hostGateRefusal({
  state = hostGate,
  method,
  connection,
  currentGeneration,
  botComputer,
  boundComputer,
  hostPlatform = process.platform,
}: {
  state?: HostGateState;
  method: string;
  connection: LocalComputerConnection;
  currentGeneration: () => string | undefined;
  botComputer: () => Parameters<typeof botUsesHostComputer>[0] | null;
  /** The bot's setting when the grant was made (undefined = Auto). */
  boundComputer?: Parameters<typeof botUsesHostComputer>[0];
  hostPlatform?: NodeJS.Platform;
}): HostGateRefusal | null {
  const computer = botComputer();
  // the bot is gone, or the owner has taken this computer away since the grant was made
  if (computer === null || (botUsesHostComputer(boundComputer, hostPlatform) && !botUsesHostComputer(computer, hostPlatform))) {
    return { code: "host-off", cause: "bot-off" };
  }
  if (connection.platform !== "win32") return null;
  const generation = connection.generation;
  const withdrawnCause = generation ? state.withdrawnCause(generation) : undefined;
  if (!generation || withdrawnCause) return { code: "host-off", cause: withdrawnCause ?? "restart" };
  if (state.liveGeneration !== generation || currentGeneration() !== generation) return { code: "host-off", cause: "restart" };
  if (method === "tools/call" && state.hostDesktop !== "active") return { code: "host-locked" };
  return null;
}
