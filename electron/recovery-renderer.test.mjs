// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { expect, test } from "vitest";

const read = name => readFileSync(new URL(`./recovery/${name}`, import.meta.url), "utf8");
const visibleButtons = document => [...document.querySelectorAll("button[data-action]")].filter(button => !button.closest("[hidden]"));

for (const encryptedAvailable of [false, true]) {
  test(`stopped index renders restart as the sole primary action with encrypted backup ${encryptedAvailable}`, async () => {
    const dom = new JSDOM(read("index.html"), { runScripts: "outside-only" });
    try {
      const { window } = dom, calls = [];
      let state = { available: true, encryptedAvailable, separateAvailable: true, captureAvailable: true,
        context: { oneTimeStep: true }, selection: { separate: true }, review: { files: 1 } };
      window.murageRecovery = { action: async name => { calls.push(name); return state; } };
      window.eval(read("messages.js"));
      window.eval(read("renderer.js"));
      await new Promise(resolve => setImmediate(resolve));
      const shown = visibleButtons(window.document);
      expect(shown.filter(button => button.classList.contains("primary")).map(button => button.textContent)).toEqual(["Open Murage again"]);
      expect(shown.filter(button => button.dataset.action === "retry")).toHaveLength(1);
      const restart = shown.find(button => button.dataset.action === "retry");
      expect(restart.disabled).toBe(false);
      expect(shown.find(button => button.dataset.action === "diagnostics")?.disabled).toBe(false);
      restart.click();
      expect(restart.disabled).toBe(true);
      await new Promise(resolve => setImmediate(resolve));
      expect(calls).toEqual(["state", "retry"]);
      expect(restart.disabled).toBe(false);

      // Rendering ordinary recovery again restores its controls and single retry.
      state = { available: true, encryptedAvailable, context: {} };
      restart.click();
      await new Promise(resolve => setImmediate(resolve));
      const ordinary = visibleButtons(window.document);
      expect(ordinary.filter(button => button.dataset.action === "retry").map(button => button.textContent)).toEqual(["Retry startup"]);
      expect(ordinary.some(button => button.dataset.action === "choose-backup")).toBe(true);
      expect(ordinary.some(button => button.dataset.action === "choose-encrypted-backup")).toBe(encryptedAvailable);
    } finally { dom.window.close(); }
  });
}
