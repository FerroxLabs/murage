// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F4 C2: the sticky "Sign <bot> in to <engine> and use it" offer. The offer itself is worked out from the live sign-in
// lines (a bot on Fuigo, another bot signed in to the engine), so it stays until the bot is signed in. The only thing kept
// on the home is the owner's "Not now": a small per-bot record of the engines whose offer was dismissed for good.
// Names only: no token, key or account is ever written here.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SIGNIN_ENGINE_LABELS } from "./engine-signins.ts";

export const SIGNIN_OFFERS_FILE = "cloud-signin-offers.json";

export interface SignInOffers {
  dismissed(botId: string): string[];
  dismiss(botId: string, engine: string): boolean;
  forget(botId: string): void;
}

/** A tiny JSON record at `path`, written whole and renamed into place. A missing or unreadable file reads as nothing dismissed. */
export function createSignInOffers(path: string): SignInOffers {
  const read = (): Record<string, string[]> => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string[]> = {};
      for (const [bot, engines] of Object.entries(parsed)) if (Array.isArray(engines)) out[bot] = engines.filter((e): e is string => typeof e === "string" && e in SIGNIN_ENGINE_LABELS);
      return out;
    } catch { return {}; }
  };
  const write = (value: Record<string, string[]>) => {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, path);
  };
  return {
    dismissed: botId => read()[botId] ?? [],
    dismiss(botId, engine) {
      if (!(engine in SIGNIN_ENGINE_LABELS)) return false;
      const all = read();
      all[botId] = [...new Set([...(all[botId] ?? []), engine])].sort();
      try { write(all); return true; } catch { return false; }
    },
    forget(botId) {
      if (!existsSync(path)) return;
      const all = read();
      if (!(botId in all)) return;
      delete all[botId];
      try { write(all); } catch { /* the record is a convenience; a failed cleanup leaves a dismissal for a bot that is gone */ }
    },
  };
}
