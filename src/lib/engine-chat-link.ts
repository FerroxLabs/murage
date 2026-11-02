// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The chat links a bot may write for engine sign-in, set-up and plans (ENGINE-SIGNIN-SIMPLE-1014, "Chat, no bot power").
// Message text starts nothing: a link can only show a box or a Settings page, and only a press in there starts anything.
//
//   murage://engine/sign-in?engine=<word>   murage://engine/set-up?engine=<word>   murage://plan/chatgpt   murage://plan/supergrok
//
// Exactly these shapes, lowercase, with nothing added. The word table is fixed; a driver outside it gets no link.
// Main's murage:// handler (electron/cloud-door-link.mjs) does not take them, so a link from outside the app does nothing.

export const ENGINE_CHAT_LINK_DRIVERS: ReadonlyMap<string, string> = new Map([
  ["claude", "claudeAgent"],
  ["codex", "codex"],
  ["grok", "grokAgent"],
  ["kimi", "kimiAgent"],
  ["cursor", "cursorAgent"],
]);

/** The id of the heading in SubscriptionSignIn.tsx: Settings lands on Use a plan you already have. */
export const PLAN_SIGNIN_ANCHOR = "signin-heading";

export type EngineChatLinkTarget =
  | { kind: "sign-in" | "set-up"; driverKind: string }
  | { kind: "plan"; provider: "chatgpt" | "supergrok" };

const ENGINE_LINK = /^murage:\/\/engine\/(sign-in|set-up)\?engine=([a-z]+)$/;
const PLAN_LINK = /^murage:\/\/plan\/(chatgpt|supergrok)$/;

/** The target of an exact chat link, or null for anything else. */
export function parseEngineChatLink(href: unknown): EngineChatLinkTarget | null {
  if (typeof href !== "string") return null;
  const plan = PLAN_LINK.exec(href);
  if (plan) return { kind: "plan", provider: plan[1] as "chatgpt" | "supergrok" };
  const engine = ENGINE_LINK.exec(href);
  const driverKind = engine ? ENGINE_CHAT_LINK_DRIVERS.get(engine[2]!) : undefined;
  return engine && driverKind ? { kind: engine[1] as "sign-in" | "set-up", driverKind } : null;
}

/** What a press shows. Every step only shows something. */
export type EngineChatLinkStep =
  | { show: "sign-in" | "signed-in" | "set-up"; instanceId: string }
  | { show: "settings"; section: "engines" }
  | { show: "settings"; section: "models"; anchor: string };

type LinkInstance = { instanceId: string; driverKind: string; enabled?: boolean; snapshot: { state: string; authenticated?: boolean } };

export function engineChatLinkStep(link: EngineChatLinkTarget, instances: readonly LinkInstance[]): EngineChatLinkStep {
  if (link.kind === "plan") return { show: "settings", section: "models", anchor: PLAN_SIGNIN_ANCHOR };
  const matching = instances.filter((instance) => instance.driverKind === link.driverKind && instance.enabled !== false);
  // None, or several to choose between: the Engines page shows each one with its own button.
  if (matching.length !== 1) return { show: "settings", section: "engines" };
  const { instanceId, snapshot } = matching[0]!;
  // A missing CLI has nothing to sign in to yet, so a sign-in link lands on the same card as set-up.
  if (link.kind === "set-up" || snapshot.state !== "available") return { show: "set-up", instanceId };
  return { show: snapshot.authenticated === true ? "signed-in" : "sign-in", instanceId };
}
