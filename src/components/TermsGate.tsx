// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE TERMS GATE. Nothing behind it is mounted until the server has answered
// that the current terms are accepted: a failed check keeps the gate up (with
// Retry), never opens it. The screens themselves (TermsScreens.tsx) load on
// demand, so the first-paint budget does not carry them; the fallback is the
// same brand frame as "loading" (the app icon on the app background),
// never a frame of the app.
import { lazy, Suspense, type ReactNode } from "react";

import { SignedOutCard } from "@/components/SignedOutCard";
import { api, useStore } from "@/state/store";
import { BrandFrame } from "@/components/BrandFrame";
import { TERMS_HINT_AFTER_FAILURES, useTerms } from "@/lib/terms";

const TermsScreen = lazy(() => import("./TermsScreens").then((m) => ({ default: m.TermsScreen })));
const TermsUnreachable = lazy(() => import("./TermsScreens").then((m) => ({ default: m.TermsUnreachable })));

const blank = <BrandFrame />;

/** Renders the app only once the terms are accepted. */
export function TermsGate({ children }: { children: ReactNode }) {
  const { status, phase, accept, retry, recheck, failures } = useTerms(api);
  const { state } = useStore();
  // A browser whose session ended cannot clear a terms check by retrying: show
  // the way back (Pair again) from the gate itself. The app stays unmounted.
  if (phase !== "clear" && state.signedOut) return <SignedOutCard />;
  if (phase === "clear") return <>{children}</>;
  // The brand frame, not the app: a frame of the app before the screen would be the bug.
  if (phase === "loading") return blank;
  // A failed check keeps the gate up: only an answer from the server clears it.
  if (phase === "unreachable") return <Suspense fallback={blank}><TermsUnreachable onRetry={retry} hint={failures >= TERMS_HINT_AFTER_FAILURES} /></Suspense>;
  return <Suspense fallback={blank}><TermsScreen updated={Boolean(status && !status.accepted && status.acceptedVersion)} onAccept={accept} onRecheck={recheck} /></Suspense>;
}
