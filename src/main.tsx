// First: crypto.randomUUID exists even on a plain-http private origin (phone over a tailnet name).
import "./lib/random-uuid-polyfill";
// Then: no schema may be built before Zod is told not to probe for eval.
import "./lib/zod-config";
// Next: the Cloud home requires Trusted Types, so the "murage" policy exists before anything writes markup.
import { installTrustedTypes, sanitizerReady } from "./lib/trusted-html";
import { StrictMode, Suspense, lazy, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { homeMeta } from "./lib/cloud-home-meta";
import { RootErrorBoundary } from "./components/RootErrorBoundary";
import { browserChunkReloadDeps, installChunkReload } from "./lib/chunk-reload";
import { bootLocaleReady } from "./lib/i18n";
import { installCallDiagForward } from "./lib/call-diag-forward";
import { inNativeShell, nativeHello } from "./lib/native-shell";
import { routeNativeClicks } from "./lib/open-external";
import { registerServiceWorker } from "./lib/register-sw";
import { applySkin, readPreference, resolveSkin, watchSystemSkin } from "./lib/skins";
import "./styles.css";

installTrustedTypes();

// index.html has already stamped the palette before the stylesheet resolved;
// this repeats it because that inline copy cannot run the migration's storage
// rewrite, and because a browser build without the inline script must still be
// correct before the first React paint.
applySkin(resolveSkin(readPreference()));

// Module scope, not a component: on "auto" the theme must keep tracking the OS
// whether or not Settings is mounted. The handler re-reads the preference, so
// this listener can never override an explicit choice.
watchSystemSkin(applySkin);

// The browser door only. Without a registered worker Chrome never offers to
// install Murage, so the phone gets a link it has to find again rather than an
// app on its home screen. No-ops in Electron and in development.
registerServiceWorker();

// The phone app's feature list. Asked now so that the synchronous checks a
// tap makes (save, open a link) already have the answer; a plain browser
// answers null at once and costs nothing.
installCallDiagForward();
void nativeHello();

// Links that leave the page, and a[download] anchors, inside the phone app.
// A browser and the desktop never install this listener at all.
if (inNativeShell()) routeNativeClicks();

// A lazy screen whose chunk vanished in a host update reloads once.
installChunkReload(browserChunkReloadDeps());

// The Cloud home's door (src/components/cloud/Door.tsx) is only for a page a Cloud home served, so it is its own chunk,
// fetched at once on that page and never on the desktop or a phone. The app renders only inside it, as before.
const doorModule = homeMeta(document).homeId ? import("./components/cloud/Door") : null;
const LazyDoor = doorModule ? lazy(() => doorModule.then((module) => ({ default: module.CloudDoor }))) : null;
const CloudDoor = LazyDoor ? ({ children }: { children: ReactNode }) => <Suspense fallback={null}><LazyDoor>{children}</LazyDoor></Suspense> : null;

// A language other than English is its own chunk (src/locales/index.ts).
// Wait for the one this device starts in (the owner's last choice, else the
// system's) before the first render, but never long: past the cap the app
// paints in English and switches when the pack arrives.
const LOCALE_WAIT_MS = 1500;
// The markup sanitizer (src/lib/trusted-html.ts) loads alongside it, under the same cap, so the first paint can
// already draw mascots and other sanitized markup.
void Promise.race([Promise.all([bootLocaleReady, sanitizerReady()]), new Promise((done) => setTimeout(done, LOCALE_WAIT_MS))]).finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <RootErrorBoundary>
        {CloudDoor ? <CloudDoor><App /></CloudDoor> : <App />}
      </RootErrorBoundary>
    </StrictMode>,
  );
});
