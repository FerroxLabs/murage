// The approval buttons' feedback, as rendered and as wired.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovalBusyLabel, ApprovalConfirmLine, PRESSED, approvalButton } from "./ApprovalFeedback";

const read = (file: string) => readFileSync(join(__dirname, file), "utf8");

describe("approval feedback pieces", () => {
  it("shows the existing spinner and the short working label in the tapped button", () => {
    const busy = renderToStaticMarkup(createElement(ApprovalBusyLabel, { busy: true }, "Allow once"));
    expect(busy).toContain("animate-spin");
    expect(busy).toContain("Sending…");
    // the action label stays in the accessible name; only the working text is visible
    expect(busy).toContain('<span class="sr-only">Allow once</span>');
    expect(busy).toMatch(/aria-hidden="true">Sending…/);
    const idle = renderToStaticMarkup(createElement(ApprovalBusyLabel, { busy: false }, "Allow once"));
    expect(idle).toContain("Allow once");
    expect(idle).not.toContain("animate-spin");
  });

  it("says the phone is confirming, in one polite status line, only while the prompt is up", () => {
    const up = renderToStaticMarkup(createElement(ApprovalConfirmLine, { prompting: true }));
    expect(up).toContain("Waiting for your phone to confirm it&#x27;s you.");
    expect(up).toContain('role="status"');
    // the live region is in the page before it has text, so the text is announced when it arrives
    const idle = renderToStaticMarkup(createElement(ApprovalConfirmLine, { prompting: false }));
    expect(idle).toContain('role="status"');
    expect(idle).not.toContain("phone");
  });

  it("has a pressed style that keeps the hover easing and drops the scale under reduced motion", () => {
    expect(PRESSED).toContain("active:scale-[0.97]");
    expect(PRESSED).toContain("background-color");
    expect(PRESSED).toContain("motion-reduce:active:scale-100");
  });

  it("a decision button keeps focus: aria-disabled, never the disabled attribute", () => {
    const markup = renderToStaticMarkup(createElement("button", approvalButton({ busy: "allow", sent: false }, "allow", "x")));
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toMatch(/\sdisabled/);
  });

  it("static busy state under reduced motion: the global rule swaps the spin for a pulse", () => {
    const css = read("../styles.css");
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{[^]*?\.animate-spin \{\s*animation: reduced-loader-pulse/);
  });
});

describe.each([
  ["InboxRequest.tsx", ["allow", "allow-task", "deny"]],
  ["PendingApproval.tsx", ["deny", "program", "task", "routine", "exact", "allow"]],
] as const)("%s wiring", (file, choices) => {
  const source = read(file);
  it("runs every decision through the shared controller and holds the other buttons", () => {
    expect(source).toContain("useDecisionFeedback");
    expect(source).toContain("ApprovalBusyLabel");
    expect(source).toContain("ApprovalConfirmLine");
    for (const choice of choices) expect(source).toContain(`"${choice}"`);
    expect(source).toContain("approvalButton(");
    expect(source).not.toMatch(/disabled=\{held/);
  });
  it("uses the fresh-auth device prompt hook and settles on success and on error", () => {
    expect(source).toMatch(/devicePrompt|onDevicePrompt/);
    expect(source).toContain("settle");
  });
});

describe("fresh-auth reports the device prompt", () => {
  it("brackets the native approval call", () => {
    const source = read("../lib/fresh-auth.ts");
    expect(source).toContain("onDevicePrompt");
    expect(source).toMatch(/onDevicePrompt\?\.\(true\)[^]*callNative\("approveWithDevice"[^]*onDevicePrompt\?\.\(false\)/);
  });
});

describe("browser approval card", () => {
  it("holds its buttons while an answer is in flight", () => {
    const source = read("ApprovalCard.tsx");
    expect(source).toContain("useDecisionFeedback");
    expect(source).toContain("data-choice");
    expect(source).toContain("approvalButton(");
  });
});
