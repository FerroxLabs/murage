// The launcher (spec §3.1, and the first-run spec): welcome, scan, typed pairing, saved computers,
// can't-reach, "this address isn't secure" and re-pair. The workspace itself
// is a native screen that covers this page (spec §2). launcher.ts decides,
// render.ts draws.
import "./styles.css";

import { listenForRecovery } from "./recovery-events";
import { createLauncher } from "./launcher";
import { render } from "./render";
import { shell } from "./shell";

const root = document.getElementById("app")!;
// The Tailscale watch (first run) reads nothing while the app is in the background.
const launcher = createLauncher(shell, (view, act, draft, keep) => render(root, view, act, draft, keep), Date.now, () => document.visibilityState === "visible");

// A page kept for back/forward keeps its listener; a page that goes lets go of it.
addEventListener("pagehide", (event) => {
  if (!event.persisted) {
    stopRecovery();
    void launcher.dispose();
  }
});

// Coalesce native resume and visibility events from the same foreground change.
const stopRecovery = listenForRecovery(document, window, () => navigator.onLine, () => { void launcher.resume(); });

void launcher.boot();
