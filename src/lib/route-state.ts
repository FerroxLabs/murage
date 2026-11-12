// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SETTINGS-LOCKED-1019.md 4.1: where one route (an engine, and the account or key it runs on) stands, in one word with
// one line and at most one fix. One function, so Settings, the picker, Needs you, first run and the chat cards all say
// the same thing. `selectable` and `tone` are independent: a warning never blocks a route that still runs.
// First match wins, in the table's order. The words live in the Settings lazy pack (settings.route.*) and are read with sw().
import { sw } from "./settings-words";
import { homeSetUpLine } from "./cloud-signin-status";
import type { InstanceInfo, ModelSelection } from "@/state/store";

export type RouteStateName = "off" | "install" | "repair" | "renew" | "signIn" | "checking" | "creditUnknown" | "noKey" | "keyProblem" | "addCredit" | "lowCredit" | "ready";
export type RouteTone = "muted" | "blocked" | "warning" | "ready";
export type RouteFixAction = "turnOn" | "install" | "repair" | "renew" | "signIn" | "addCredit";

/** What the route runs on. Absent means the engine's own sign-in. */
export interface RouteConnection {
  kind: "account" | "flux" | "key" | "local";
  /** A name the engine has verified. Never a guess: an unverified account says only "signed in". */
  account?: string;
  /** Models this computer serves, for `local`. */
  localModels?: number;
}

/** Flux credit (4.2). `unknown` is its own state and is never shown as $0. */
export interface RouteCredit {
  state: "ok" | "low" | "out" | "unknown" | "failed" | "noKey" | "keyProblem";
  /** "included" when the credit that ran out is the included allowance rather than a paid balance. */
  kind?: "included" | "paid";
  /** A balance exactly as read, already formatted. Shown only when the server gave one. */
  balance?: string;
  /** Epoch ms of the reading. Required to be trusted: none, or older than five minutes, counts as unknown. A refresh that failed is `failed`. */
  asOf?: number;
}

export type RouteInstance = Pick<InstanceInfo, "instanceId" | "displayName" | "driverKind" | "enabled" | "snapshot">;

export interface RouteState {
  state: RouteStateName;
  selectable: boolean;
  tone: RouteTone;
  line: string;
  /** The one button that gets this route working, or null. `name` is what a screen reader hears. */
  fix: { action: RouteFixAction; label: string; name: string } | null;
}

/** A credit reading older than this is not trusted (4.2). */
export const CREDIT_MAX_AGE_MS = 5 * 60 * 1000;

const fixFor = (action: RouteFixAction, engine: string): NonNullable<RouteState["fix"]> => ({
  action,
  label: sw(`settings.route.fix.${action}`),
  name: sw(`settings.route.fixName.${action}`, { engine }),
});

/** Codex can also be used through a ChatGPT account added under Accounts and keys, so its sign-in line says so. */
const isCodex = (instance: RouteInstance) => instance.driverKind === "codex";

/** Whether this route spends Flux credit: the connection says so, or the engine is our own Fuigo with no key of its own. */
export function isFluxRouted(instance: RouteInstance, connection?: RouteConnection | null): boolean {
  if (connection) return connection.kind === "flux";
  return instance.driverKind === "fuigoAgent";
}

export function routeState(
  selection: ModelSelection | null | undefined,
  instance: RouteInstance,
  connection?: RouteConnection | null,
  credit?: RouteCredit | null,
  now: number = Date.now(),
): RouteState {
  const engine = instance.displayName;
  const snap = instance.snapshot;
  // The selection names the route being read. Today a route's state depends on its engine, its connection and its credit alone,
  // so the selection is carried for callers (the picker, a bot's Model card) and for a later per-model reading.
  void selection;

  if (instance.enabled === false) {
    return { state: "off", selectable: false, tone: "muted", line: sw("settings.route.off", { engine }), fix: fixFor("turnOn", engine) };
  }
  if (snap.state === "unavailable" && snap.setupAction !== "repair") {
    return { state: "install", selectable: false, tone: "blocked", line: sw("settings.route.install", { engine }), fix: fixFor("install", engine) };
  }
  if (snap.setupAction === "repair") {
    return { state: "repair", selectable: false, tone: "blocked", line: sw("settings.route.repair", { engine }), fix: fixFor("repair", engine) };
  }
  if (snap.renewSignIn === true) {
    return { state: "renew", selectable: true, tone: "warning", line: sw("settings.route.renew", { engine }), fix: fixFor("renew", engine) };
  }
  if (snap.authenticated === false) {
    const line = sw("settings.route.signIn", { engine }) + (isCodex(instance) ? ` ${sw("settings.route.signInCodex")}` : "");
    return { state: "signIn", selectable: false, tone: "blocked", line, fix: fixFor("signIn", engine) };
  }

  const flux = isFluxRouted(instance, connection);
  // A reading with no timestamp, a future-proof nonsense one, or one that failed is not a reading: it is Checking (4.2).
  const fresh = !!credit && Number.isFinite(credit.asOf) && now - (credit.asOf as number) <= CREDIT_MAX_AGE_MS;
  const creditState = credit && fresh && credit.state !== "failed" ? credit.state : "unknown";

  if (snap.authUnverified === true) {
    return { state: "checking", selectable: true, tone: "muted", line: sw("settings.route.checkingSignIn", { engine }), fix: null };
  }
  // No reading is said plainly, never an endless Checking: a missing, stale or failed reading is not available right now.
  if (flux && creditState === "noKey") {
    return { state: "noKey", selectable: true, tone: "warning", line: sw("settings.route.noFluxKey", { engine }), fix: null };
  }
  if (flux && creditState === "keyProblem") {
    return { state: "keyProblem", selectable: true, tone: "warning", line: sw("settings.route.fluxKeyProblem"), fix: null };
  }
  if (flux && creditState === "unknown") {
    return { state: "creditUnknown", selectable: true, tone: "muted", line: sw("settings.route.creditUnavailable"), fix: null };
  }
  if (flux && creditState === "out") {
    const base = sw(credit?.kind === "included" ? "settings.route.creditOutIncluded" : "settings.route.creditOut");
    const line = credit?.balance ? `${base} ${sw("settings.route.balance", { balance: credit.balance })}` : base;
    return { state: "addCredit", selectable: false, tone: "blocked", line, fix: fixFor("addCredit", engine) };
  }
  if (flux && creditState === "low") {
    return { state: "lowCredit", selectable: true, tone: "warning", line: sw("settings.route.creditLow", { engine }), fix: fixFor("addCredit", engine) };
  }

  let line: string;
  if (connection?.kind === "flux" || (!connection && flux)) line = sw("settings.route.ready.flux");
  else if (connection?.kind === "key") line = sw("settings.route.ready.key");
  else if (connection?.kind === "local") line = connection.localModels === 1 ? sw("settings.route.ready.local1") : sw("settings.route.ready.local", { n: connection.localModels ?? 0 });
  else if (connection?.account) line = sw("settings.route.ready.account", { account: connection.account });
  else if (snap.setUpOnHome === true) line = homeSetUpLine(engine);
  else line = snap.authenticated === true ? sw("settings.route.ready.signedIn") : sw("settings.route.ready.plain");
  return { state: "ready", selectable: true, tone: "ready", line, fix: null };
}
