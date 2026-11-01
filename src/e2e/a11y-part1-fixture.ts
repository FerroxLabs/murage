// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The page a11y-part1.human.spec.ts drives: the real stylesheet and the real focus trap, with one of each control the
// overhaul builds. The palette comes from ?skin=light|dark.
import "../styles.css";
import { trapFocus, type FocusTrap, type TrapContainer } from "../lib/focus-trap";

const skin = new URLSearchParams(location.search).get("skin") === "light" ? "light" : "dark";
document.documentElement.dataset.skin = skin;
document.documentElement.lang = "en";

const root = document.getElementById("root")!;
root.innerHTML = `
<main class="min-h-screen bg-app p-6 text-ink">
  <h1 class="text-lg font-semibold">Accessibility check</h1>
  <p class="mt-2 text-ink-secondary">Every control the overhaul builds, once.</p>
  <div class="mt-4 flex flex-wrap items-center gap-3">
    <button id="open" type="button" class="rounded-lg bg-accent px-3 py-1.5">Open help</button>
    <button id="tap" type="button" class="tap-target rounded-lg bg-raised px-2 text-sm">Go</button>
    <a id="inline-link" class="tap-area text-sm text-accent-text" href="#allow">Allow once</a>
    <span id="badge" class="rounded-full bg-accent px-1.5 text-xs font-bold" aria-label="Needs you, 3 waiting">3</span>
    <span id="chip" class="rounded-md bg-warning-soft px-2 text-sm text-warning">Asks first</span>
    <span id="mark" class="status-mark" data-tone="success" role="img" aria-label="Finished">✓</span>
    <label id="sr-label" class="inline-flex items-center gap-2 px-1 text-sm"><input id="sr" type="checkbox" class="sr-only">Remember this</label>
    <button id="landing" type="button" class="rounded-lg bg-card px-3 py-1.5" data-landing>Working folder</button>
    <span id="spin" class="animate-spin inline-block size-3 rounded-full bg-ink-secondary" aria-hidden="true"></span>
  </div>
  <section id="panel" class="help-panel-in mt-6 w-80 rounded-xl bg-panel p-4" role="dialog" aria-modal="true" aria-label="Help" hidden>
    <button id="p-first" type="button" class="rounded-lg bg-raised px-2">Ask</button>
    <input id="p-input" aria-label="Your question" class="mx-2 rounded-lg bg-inset px-2">
    <button id="p-close" type="button" class="rounded-lg bg-raised px-2">Close</button>
  </section>
</main>`;

const panel = document.getElementById("panel")!;
let trap: FocusTrap | null = null;
const close = () => {
  panel.hidden = true;
  trap?.release();
  trap = null;
};
document.getElementById("open")!.addEventListener("click", () => {
  panel.hidden = false;
  trap = trapFocus(panel as unknown as TrapContainer, { onEscape: close });
});
document.getElementById("p-close")!.addEventListener("click", close);
(window as unknown as { __a11yReady: boolean }).__a11yReady = true;
