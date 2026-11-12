// The Inbox's "Engines to sign in to" row on a Cloud home: one button, no command, no terminal. In an owner's browser it opens the
// vendor's own sign-in on the home (one tab to the vendor, one paste back); in the Cloud window it asks the local window, the same
// route the new-bot offer takes (runOfferSignIn). Codex, Grok and Kimi sign in per bot: one bot is used without asking, several
// get the Connect panel's picker. Claude is the home's own, so any bot will do.
import { useState } from "react";

import { releaseSignInTab, reserveSignInTab } from "@/lib/signin-tab";
import { BotChoice } from "@/components/cloud/BotChoice";
import { BrowserSignInDialog, browserSignInHere, runOfferSignIn, type BrowserSignInTarget } from "@/components/cloud/BotSignInOffer";
import { cloudSignInPlan, type SignedOutEngineRow } from "@/lib/signed-out-engines";
import { isCloudHome } from "@/lib/cloud-workspace";
import { onCloudHomePage } from "@/lib/owner-code";
import { engineLoginNeedsBot, type EngineLoginEngine } from "@/lib/engine-login-terminal";
import { api } from "@/state/store";

const button = "rounded-md bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-inset disabled:opacity-50";
export const NO_BOTS_COPY = "This home has no bots yet. Add one, then sign in here.";
export const signInButtonLabel = (name: string) => `Sign in to ${name}`;

type Bot = { id: string; name: string };
export type CloudEnv = { cloud: boolean; homePage: boolean; bridge: boolean };
export const cloudEnv = (): CloudEnv => ({ cloud: isCloudHome(), homePage: onCloudHomePage(), bridge: typeof window !== "undefined" && typeof window.muragecloud?.requestSignIn === "function" });

/** Which bot a click signs in: the only one, any one for Claude (home-wide), or null when the owner must choose. */
export function botForSignIn(engine: string, bots: readonly Bot[]): Bot | "choose" | null {
  if (bots.length === 0) return null;
  if (bots.length === 1 || !engineLoginNeedsBot(engine as EngineLoginEngine, "login", null)) return bots[0]!;
  return "choose";
}

export interface InboxEngineSignInViewProps { row: Pick<SignedOutEngineRow, "id" | "name" | "driverKind">; env: CloudEnv; busy: boolean; error: string; choices: Bot[] | null; onSignIn(): void; onChoose(bot: Bot): void; onCancel(): void }

export function InboxEngineSignInView({ row, env, busy, error, choices, onSignIn, onChoose, onCancel }: InboxEngineSignInViewProps) {
  const plan = cloudSignInPlan(row, env);
  if (!plan) return null;
  if (plan.kind === "words") return <p className="mt-2 text-ink-secondary">{plan.text}</p>;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {choices ? <BotChoice bots={choices} onChoose={onChoose} onCancel={onCancel} /> : <div><button type="button" className={button} disabled={busy} onClick={onSignIn}>{signInButtonLabel(row.name)}</button></div>}
      {error ? <p role="alert" className="text-danger">{error}</p> : null}
    </div>
  );
}

/** The stateful row. `onDone` re-reads the setup view, so the row goes the moment the sign-in took. */
export function InboxEngineSignIn({ row, onDone }: { row: SignedOutEngineRow; onDone(): void }) {
  const env = cloudEnv();
  const kind = row.driverKind ?? row.id;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [choices, setChoices] = useState<Bot[] | null>(null);
  const [browser, setBrowser] = useState<BrowserSignInTarget | null>(null);
  const start = async (bot: Bot) => {
    setChoices(null);
    await runOfferSignIn(bot.id, kind, { setBusy, setError, openBrowser: () => setBrowser({ bot, engine: kind, label: row.name }) });
  };
  const signIn = async () => {
    // The click opens the empty tab now; the vendor's link is pointed at it when it arrives.
    if (browserSignInHere(kind)) reserveSignInTab();
    setBusy(true); setError("");
    let bots: Bot[];
    try { bots = ((await api("/api/cloud/engine-signins")) as { bots?: Bot[] }).bots ?? []; }
    catch { setBusy(false); releaseSignInTab(); setError("Something went wrong. Try again."); return; }
    setBusy(false);
    const pick = botForSignIn(kind, bots);
    if (pick === null) { releaseSignInTab(); setError(NO_BOTS_COPY); }
    else if (pick === "choose") setChoices(bots);
    else await start(pick);
  };
  return (
    <>
      <InboxEngineSignInView row={row} env={env} busy={busy} error={error} choices={choices} onSignIn={() => void signIn()} onChoose={(bot) => void start(bot)} onCancel={() => { releaseSignInTab(); setChoices(null); }} />
      {browser ? <BrowserSignInDialog target={browser} onClose={() => { setBrowser(null); onDone(); }} /> : null}
    </>
  );
}
