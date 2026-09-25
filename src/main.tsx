import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { RootErrorBoundary } from "./components/RootErrorBoundary";
import { browserChunkReloadDeps, installChunkReload } from "./lib/chunk-reload";
import { inNativeShell, nativeHello } from "./lib/native-shell";
import { routeNativeClicks } from "./lib/open-external";
import { registerServiceWorker } from "./lib/register-sw";
import { applySkin, readPreference, resolveSkin, watchSystemSkin } from "./lib/skins";
import "./styles.css";

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
void nativeHello();

// Links that leave the page, and a[download] anchors, inside the phone app.
// A browser and the desktop never install this listener at all.
if (inNativeShell()) routeNativeClicks();

// A lazy screen whose chunk vanished in a host update reloads once.
installChunkReload(browserChunkReloadDeps());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
