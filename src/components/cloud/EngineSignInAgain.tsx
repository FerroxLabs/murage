// A Cloud home, a customer's own engine sign-in refused a turn (401 or 403): the card's own "sign in again" way forward.
// A button where this page has a route for the engine (runOfferSignIn: the Cloud window asks the local window, an owner's browser
// opens the vendor's sign-in on the home); one plain line naming the real place where that is the only route; nothing where
// no place offers the sign-in at all (so the card never promises a click that is not there).
import { useState } from "react";

import { BrowserSignInDialog, runOfferSignIn, type BrowserSignInTarget } from "@/components/cloud/BotSignInOffer";
import { BROWSER_SIGNIN_ENGINES, canSignInHere } from "@/lib/cloud-signin-status";
import { onCloudHomePage } from "@/lib/owner-code";

export type SignInAgainEnv = { homePage: boolean; bridge: boolean };
export type SignInAgainPlan = "button" | "computer" | "none";

export const signInAgainEnv = (): SignInAgainEnv => ({ homePage: onCloudHomePage(), bridge: typeof window !== "undefined" && typeof window.muragecloud?.requestSignIn === "function" });

/** The Murage app on a computer offers the sign-in (Connect panel) for these engines, so a browser with no route of its own points there. */
export function signInAgainPlan(engine: string, env: SignInAgainEnv): SignInAgainPlan {
  // The Cloud window can hand the sign-in to the local window only for the engines that window signs in.
  if (env.bridge) return canSignInHere(engine) ? "button" : "none";
  if (!env.homePage) return "button";
  if (BROWSER_SIGNIN_ENGINES.includes(engine)) return "button";
  return canSignInHere(engine) ? "computer" : "none";
}

/** The card's body line for a plan: the button's own line, the computer line, or the plain refresh news. */
export function signInAgainCopy(plan: SignInAgainPlan, label: string, buttonLine: string): string {
  return plan === "button" ? buttonLine : plan === "computer" ? signInAgainComputerLine(label) : signInAgainNoRouteLine(label);
}
export const signInAgainComputerLine = (label: string): string => `Your ${label} sign-in needs a refresh. Open Murage on your computer to sign in again.`;
/** The card's own line when no place offers the sign-in: the refresh news without the "sign in again" promise. */
export const signInAgainNoRouteLine = (label: string): string => `Your ${label} sign-in needs a refresh.`;

export function EngineSignInAgainView({ plan, busy, error, onSignIn, dialog }: { plan: SignInAgainPlan; busy: boolean; error: string; onSignIn(): void; dialog?: React.ReactNode }) {
  if (plan !== "button") return null; // the card's own line carries the computer / no-route words
  return (
    <div className="mt-3 flex flex-col gap-2">
      {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
      <div>
        <button type="button" disabled={busy} data-engine-sign-in-again onClick={onSignIn}
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-control px-3.5 py-2 text-[13px] font-medium text-ink hover:bg-inset disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
          Sign in again
        </button>
      </div>
      {dialog}
    </div>
  );
}

export function EngineSignInAgain({ bot, engine, label }: { bot: { id: string; name: string }; engine: string; label: string }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [browser, setBrowser] = useState<BrowserSignInTarget | null>(null);
  const plan = signInAgainPlan(engine, signInAgainEnv());
  return (
    <EngineSignInAgainView plan={plan} busy={busy} error={error}
      onSignIn={() => void runOfferSignIn(bot.id, engine, { setBusy, setError, openBrowser: () => setBrowser({ bot, engine, label }) })}
      dialog={browser ? <BrowserSignInDialog target={browser} onClose={() => setBrowser(null)} /> : null} />
  );
}
