import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { UseAsReferenceButton, referenceErrorMessage } from "./UseAsReferenceButton";
import { registerComposerReferenceTarget } from "@/lib/image-reference";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const request = async () => ({});
const source = { kind: "attachment" as const, attachmentId: "11111111-1111-4111-8111-111111111111.png" };

it("offers nothing without a usable source or an open composer for the image's conversation", () => {
  expect(renderToStaticMarkup(createElement(UseAsReferenceButton, { source, name: "a.png", request }))).toBe("");
  cleanups.push(registerComposerReferenceTarget({ threadId: "thread-a", draftId: "bot:a:thread-a" }));
  expect(renderToStaticMarkup(createElement(UseAsReferenceButton, { source: null, name: "a.png", request }))).toBe("");
  // A saved file of another conversation is never offered to this composer.
  expect(renderToStaticMarkup(createElement(UseAsReferenceButton, { source, threadId: "thread-b", name: "a.png", request }))).toBe("");
});

it("renders an accessible action with a live status region while the conversation is open", () => {
  cleanups.push(registerComposerReferenceTarget({ threadId: "thread-a", draftId: "bot:a:thread-a" }));
  for (const threadId of [undefined, "thread-a"]) {
    const html = renderToStaticMarkup(createElement(UseAsReferenceButton, { source, ...(threadId ? { threadId } : {}), name: "sketch.png", request }));
    expect(html).toContain("Use as reference");
    expect(html).toContain('aria-label="Use sketch.png as a reference image in your next message"');
    expect(html).toContain('type="button"');
    expect(html).toContain('role="status"'); expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-image-reference-action="idle"');
  }
});

it("keeps the harness explanation, bounded, and falls back to a plain sentence", () => {
  expect(referenceErrorMessage(new Error("Reference 1: That image is not in this conversation. No reference image was prepared."))).toContain("not in this conversation");
  expect(referenceErrorMessage(new Error("x".repeat(500)))).toHaveLength(300);
  expect(referenceErrorMessage("boom")).toBe("The image could not be added as a reference.");
});
