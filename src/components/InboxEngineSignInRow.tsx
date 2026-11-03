// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ONE NEEDS YOU ROW: A BOT RUNS ON AN ENGINE NOBODY IS SIGNED IN TO (FUIGO-FIRST-SIGNIN-PLACEMENT, 1.0.14).
//
// Flux Router and Fuigo are front and center (Sean 11-02). The row exists only
// because a bot's turns fail (signedOutEngineRows drops an engine no bot uses),
// so its words point at fixing that bot. "Use Fuigo instead" is the main button
// when Fuigo can answer now; with nothing to think with yet, the main button
// opens Models, where the Flux key goes. Signing in to the engine is the second
// action. The wording is the FIRST-ENGINE R3b sign-in wall's
// (designs/FIRST-ENGINE-DESKTOP-REPICK-1014-R3b.md section 6).
import type { ReactNode } from "react";

import { t } from "@/lib/i18n";
import type { LocalEngineLoginBridge } from "@/lib/local-engine-login";
import type { SignedOutEngineRow } from "@/lib/signed-out-engines";
import { EngineSignInButton, primary } from "./EngineSignInButton";

/** "Scout", "Scout and Ember", "Scout, Ember and Ada", "Scout, Ember and 2 more". */
export function engineUsersLabel(names: readonly string[]): string {
  const shown = names.length > 3 ? names.slice(0, 2) : names;
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length <= 1) return shown[0] ?? "";
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** The row's title: the bots come first, the engine only in the line under it (MurageMain 11-02). */
export function engineUsersTitle(names: readonly string[]): string {
  return `${engineUsersLabel(names)} can't answer yet.`;
}

export function engineUsersLine(names: readonly string[], engine: string, fuigoReady: boolean): string {
  const one = names.length === 1;
  const fix = fuigoReady ? "you sign in or use Fuigo instead" : "you sign in, or add your Flux key and then use Fuigo instead";
  return `${engineUsersLabel(names)} ${one ? "runs" : "run"} on ${engine}, so ${one ? "its" : "their"} turns fail until ${fix}.`;
}

export function InboxEngineSignInRow({ engine, fuigoReady, busy = false, onUseFuigo, onOpenModels, onDone, bridge, children }: {
  engine: SignedOutEngineRow;
  /** Fuigo can answer now: a key or a login, and a catalogue that is not empty. */
  fuigoReady: boolean;
  busy?: boolean;
  onUseFuigo(): void;
  onOpenModels(): void;
  onDone(): void;
  /** Test seam, passed to the sign-in button; it defaults to the desktop bridge there. */
  bridge?: LocalEngineLoginBridge | null;
  children?: ReactNode;
}) {
  const names = [...new Set(engine.usedBy.map((user) => user.name))];
  return (
    <li className="rounded-xl border border-warning/30 bg-warning/[0.06] p-4 text-[13px]">
      <p className="font-medium text-ink">{engineUsersTitle(names)}</p>
      <p className="mt-1 text-ink-secondary">{engineUsersLine(names, engine.name, fuigoReady)}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {fuigoReady
          ? <button type="button" data-primary className={primary} disabled={busy} onClick={onUseFuigo}>Use Fuigo instead</button>
          : <button type="button" data-primary className={primary} onClick={onOpenModels}>{t("ux.l2b.health.go.flux")}</button>}
        <EngineSignInButton secondary instanceId={engine.id} name={engine.name} command={engine.signInCommand} onDone={onDone} {...(bridge !== undefined ? { bridge } : {})} />
      </div>
      {children}
    </li>
  );
}
