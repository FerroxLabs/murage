// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Chat cards most conversations never show, loaded the first time one does
// (spec §6). Putting a site online and setting up the browser are each a
// card a bot raises now and then, and so is a connected app's sign-in; their code (the Netlify connect flow, the
// published-sites list, the browser checks) rides its own chunk instead of
// the first paint, the way ProjectSinceYouLeftLazy does it.
import { Suspense, type ComponentProps } from "react";
import { LazyBoundary, retryableLazy } from "./LazyBoundary";
import type { PublishCard as PublishCardView } from "./PublishCard";
import type { BrowserSetupCard as BrowserSetupCardView } from "./BrowserSetupCard";
import type { McpSignInCard as McpSignInCardView } from "./McpSignInCard";

const Publish = retryableLazy(() => import("./PublishCard").then((module) => ({ default: module.PublishCard })));
const McpSignIn = retryableLazy(() => import("./McpSignInCard").then((module) => ({ default: module.McpSignInCard })));
const BrowserSetup = retryableLazy(() => import("./BrowserSetupCard").then((module) => ({ default: module.BrowserSetupCard })));

export function PublishCard(props: ComponentProps<typeof PublishCardView>) {
  return <LazyBoundary inline onRetry={Publish.retry}><Suspense fallback={null}><Publish.Component {...props} /></Suspense></LazyBoundary>;
}

export function BrowserSetupCard(props: ComponentProps<typeof BrowserSetupCardView>) {
  return <LazyBoundary inline onRetry={BrowserSetup.retry}><Suspense fallback={null}><BrowserSetup.Component {...props} /></Suspense></LazyBoundary>;
}

export function McpSignInCard(props: ComponentProps<typeof McpSignInCardView>) {
  return <LazyBoundary inline onRetry={McpSignIn.retry}><Suspense fallback={null}><McpSignIn.Component {...props} /></Suspense></LazyBoundary>;
}
