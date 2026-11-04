// TENJOBS-APP-GAPS (1.0.17), ten-jobs job 7 "Connect Telegram": the token field takes the cursor on an empty
// setup and Save token goes straight on to the pairing code. Source contracts, as UsagePopover.test.ts: the
// renderer suite runs in node with no DOM.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const src = read("./TelegramSettings.tsx");
const paths = read("../../scripts/ten-jobs/paths.mjs");
const body = (from: string, to: string) => { const a = src.indexOf(from); const b = src.indexOf(to, a + from.length); expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a); return src.slice(a, b); };

describe("job 7: Connect Telegram in four owner steps", () => {
  it("puts the cursor in the token field once, only when nothing is set up", () => {
    // The token field stays a password field, whatever plain attributes sit between the ref and its type.
    expect(src).toMatch(/<input ref=\{tokenInput\}(?: [\w-]+="[^"]*")* type="password"/);
    // Settings landing lands on this same field.
    expect(src).toMatch(/<input ref=\{tokenInput\}(?: [\w-]+="[^"]*")* data-setting-control="telegram-settings-title"/);
    const effect = body("const tokenFocused = useRef(false);", "}, [status, busy, linked]);");
    // Decided on the first status only, configured or not, so a later empty status never pulls focus.
    expect(effect).toMatch(/if \(tokenFocused\.current \|\| !status \|\| busy\) return;\s*tokenFocused\.current = true;\s*if \(status\.configured \|\| linked\) return;/);
    // Never takes focus the owner already put elsewhere.
    expect(effect).toContain("if (active && active !== tokenInput.current && active.closest(\"input, textarea, select, [contenteditable]");
    expect(effect).not.toContain("active !== document.body");
    expect(effect.indexOf("tokenInput.current?.focus();")).toBeGreaterThan(effect.indexOf("const active = document.activeElement;"));
  });

  it("a first token goes on to the pairing code without a second press", () => {
    const save = body("const save = () => run(\"save\"", "const startPair");
    expect(save).toContain("const saved = await refresh(version);");
    expect(save).toContain("const plan = telegramAutoPairPlan(saved, Date.now());");
    expect(save).toContain("if (plan.pair) await pairWork(version, plan.revokeFirst);");
    // A replaced token keeps its saved pairing and never starts a new one.
    expect(save).toContain("if (replaceable) { setNotice(\"Token replaced. Reconnecting with your saved pairing.\"); return; }");
    const replaceAt = save.indexOf("if (replaceable) {");
    expect(replaceAt).toBeGreaterThan(-1);
    expect(replaceAt).toBeLessThan(save.indexOf("await pairWork("));
  });

  it("the Pair with Chief button runs the same pairing work, revoking an expired code first", () => {
    expect(src).toContain("const startPair = () => run(\"pair\", version => pairWork(version, expired));");
    const work = body("const pairWork = async (version: number, revokeFirst: boolean) => {", "const startPair");
    expect(work).toContain("if (revokeFirst) { await api(\"/api/telegram/revoke\"");
    expect(work).toContain("/^[A-Za-z0-9_-]{4,128}$/.test(result.code)");
  });

  it("the gate walk for job 7 no longer presses Pair with Chief", () => {
    const job7 = paths.slice(paths.indexOf("id: 7,"), paths.indexOf("id: 8,"));
    expect(job7).toContain("\"Save token\"");
    expect(job7).not.toContain("\"Pair with Chief\"");
  });
});

describe("job 9: Pair the phone from the sidebar phone button", () => {
  it("walks the sidebar phone button, not the You menu", () => {
    const job9 = paths.slice(paths.indexOf("id: 9,"), paths.indexOf("id: 10,"));
    expect(job9).toContain("name: PHONE_BUTTON }");
    expect(job9).not.toContain("role: \"menuitem\", name: \"Phone\"");
    const button = read("./SidebarPhoneButton.tsx");
    expect(button).toContain("label: \"Phone access off\"");
    expect(button).toContain("label: \"Pair a phone\"");
  });
});
