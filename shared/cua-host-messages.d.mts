export const HOST_DESKTOP: "murage:host-desktop";
export const HOST_DESKTOP_READY: "murage:host-desktop-ready";
export const CUA_GENERATION: "murage:cua-generation";
export const CUA_STUCK: "murage:cua-stuck";
export const CUA_INTEGRITY: "murage:cua-integrity";
export type HostDesktopState = "locked" | "active" | "unknown";
export type WithdrawCause = "disable" | "restart" | "integrity" | "quit" | "update";
export const HOST_DESKTOP_STATES: readonly HostDesktopState[];
export const WITHDRAW_CAUSES: readonly WithdrawCause[];
export type HostMessage =
  | { type: typeof HOST_DESKTOP; state: HostDesktopState }
  | { type: typeof HOST_DESKTOP_READY }
  | { type: typeof CUA_GENERATION; live: string | null }
  | { type: typeof CUA_GENERATION; withdrawn: string; cause: WithdrawCause }
  | { type: typeof CUA_GENERATION; retired: string; exitConfirmed: true }
  | { type: typeof CUA_STUCK; generation: string }
  | { type: typeof CUA_INTEGRITY; generation: string };
export function desktopStateFromLock(lockState: unknown): HostDesktopState;
export function hostDesktopMessage(state: unknown): { type: typeof HOST_DESKTOP; state: HostDesktopState };
export function hostDesktopReadyMessage(): { type: typeof HOST_DESKTOP_READY };
export function liveMessage(generation: string | null | undefined): { type: typeof CUA_GENERATION; live: string | null };
export function withdrawnMessage(generation: string, cause: WithdrawCause): { type: typeof CUA_GENERATION; withdrawn: string; cause: WithdrawCause };
export function retiredMessage(generation: string): { type: typeof CUA_GENERATION; retired: string; exitConfirmed: true };
export function stuckMessage(generation: string): { type: typeof CUA_STUCK; generation: string };
export function integrityMessage(generation: string): { type: typeof CUA_INTEGRITY; generation: string };
export function parseHostMessage(message: unknown): HostMessage | null;
