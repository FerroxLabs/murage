// The launcher's view of its one native plugin, `MurageShell`: ShellPlugin.swift
// over ShellCoordinator (iOS P17), ShellPlugin.java over Shell (Android P21).
// Types only, so tests load this without Capacitor.
import type { PluginListenerHandle } from "@capacitor/core";

/** LaunchPolicy.swift CloseReason and CloseReason.java, in the same order. */
export const CLOSE_REASONS = ["unreachable", "insecure", "signedOut", "signOut", "launcher", "updateRequired", "accessoff", "hosterror"] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

/**
 * Every code a plugin call rejects with (OpenFailure and ScanFailure in
 * ShellCoordinator.swift; the literals in Shell.java, ShellPlugin.java and
 * QrScanner.java). Any call may answer `unavailable` when it did not come
 * from the bundled page.
 *   state():  unreadable
 *   open():   unreachable, insecure, accessoff, hosterror, unreadable, busy, bad_origin, bad_credential, no_launcher
 *   scan():   cancelled, camera_denied (iOS only), unavailable
 *   remove(): unreadable
 */
export const SHELL_ERRORS = [
  "unreachable",
  "insecure",
  "accessoff",
  "hosterror",
  "unreadable",
  "busy",
  "bad_origin",
  "bad_credential",
  "no_launcher",
  "cancelled",
  "camera_denied",
  "unavailable",
] as const;
export type ShellError = (typeof SHELL_ERRORS)[number];

export interface SavedWorkspace {
  origin: string;
  name: string;
  /** Epoch milliseconds. */
  lastConnected: number;
}

export interface Closed {
  origin: string;
  reason: CloseReason;
}

/**
 * TailscaleStatus.swift and TailscaleStatus.java. null is unknown: the
 * launcher then keeps its general wording. `connected`: a Tailscale address
 * (contract/tailscale-address.json) on an interface that is up. `installed`
 * is never false on iOS, where Tailscale documents no URL scheme to ask about.
 */
export interface TailscaleState {
  installed: boolean | null;
  connected: boolean | null;
}

export const TAILSCALE_UNKNOWN: TailscaleState = Object.freeze({ installed: null, connected: null });

/** Each field a boolean or null; anything else native might send is unknown. */
export function readTailscale(raw: unknown): TailscaleState {
  const field = (key: keyof TailscaleState): boolean | null => {
    const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined;
    return typeof value === "boolean" ? value : null;
  };
  return { installed: field("installed"), connected: field("connected") };
}

export interface ShellState {
  /** Most recently connected first. */
  workspaces: SavedWorkspace[];
  active: string | null;
  /** A close that happened while no launcher page was listening; handed over once. */
  closed: Closed | null;
  platform: "ios" | "android";
  tailscale: TailscaleState;
}

export type OpenMode = "full" | "basic";

export interface MurageShellPlugin {
  /** Rejects `unreadable` when the saved list can't be read (a locked phone): never an empty list. */
  state(): Promise<ShellState>;
  /** Resolves only with a pairing link (native checks PairingLink.parse), trimmed. */
  scan(): Promise<{ text: string }>;
  /** Native checks the host before loading; unsupported hosts return their capability without opening a workspace. */
  open(options: { origin: string; credential?: string }): Promise<{ mode: OpenMode; hostCapability?: number }>;
  /** An origin that does not parse was never saved, so it resolves. */
  remove(options: { origin: string }): Promise<void>;
  /** Tailscale itself when the phone can open it, else its App Store or Play page. */
  openTailscale(): Promise<void>;
  addListener(event: "workspaceClosed", listener: (closed: Closed) => void): Promise<PluginListenerHandle>;
  addListener(event: "notice", listener: (notice: { code: string }) => void): Promise<PluginListenerHandle>;
}

/** Capacitor rejects with an Error carrying native's code; anything else is undefined. */
export function errorCode(error: unknown): ShellError | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return (SHELL_ERRORS as readonly unknown[]).includes(code) ? (code as ShellError) : undefined;
}
