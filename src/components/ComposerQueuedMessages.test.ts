// The queued-send card, and where it sits.
//
// Placement is the load-bearing part and the reason this file reads the
// Composer's SOURCE as well as rendering the component: the composer is now
// a COLUMN (textarea on top, controls row beneath, send/mic pushed right
// with ml-auto). A queued card dropped into the controls row would shove
// that cluster off its baseline, and a queued card left at the transcript
// tail scrolls away from the button that cancels it. The component itself
// cannot see either mistake, so the order is pinned here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { QueuedComposerMessages } from "./ComposerQueuedMessages";

const COMPONENTS_DIR = dirname(fileURLToPath(import.meta.url));
const composerSource = readFileSync(join(COMPONENTS_DIR, "Composer.tsx"), "utf8");

describe("QueuedComposerMessages", () => {
  it("keeps pending sends visibly attached to the composer", () => {
    const html = renderToStaticMarkup(createElement(QueuedComposerMessages, {
      items: [{ queueId: "q1", text: "follow up after this" }],
      onCancel: vi.fn(),
    }));

    expect(html).toContain('aria-label="Queued messages"');
    expect(html).toContain("follow up after this");
    expect(html).toContain("Queued for the next turn");
    expect(html).toContain('aria-label="Cancel queued message"');
  });

  it("renders nothing at all when the queue is empty", () => {
    expect(renderToStaticMarkup(createElement(QueuedComposerMessages, {
      items: [],
      onCancel: vi.fn(),
    }))).toBe("");
  });
});

describe("its place in the composer column", () => {
  const columnAt = composerSource.indexOf(
    'className="relative z-[1] flex flex-col gap-1.5 rounded-3xl bg-raised px-2 py-1.5"',
  );
  const queueAt = composerSource.indexOf("<QueuedComposerMessages");
  const textareaAt = composerSource.indexOf("<textarea");
  const controlsRowAt = composerSource.indexOf('<div className="ml-auto flex items-center gap-1">');

  it("is inside the composer column at all", () => {
    expect(columnAt).toBeGreaterThan(-1);
    expect(queueAt).toBeGreaterThan(columnAt);
  });

  it("is the first child of that column: above the textarea and above the controls row", () => {
    expect(textareaAt).toBeGreaterThan(queueAt);
    expect(controlsRowAt).toBeGreaterThan(textareaAt);
  });

  it("leaves the send/mic cluster on its ml-auto trailing alignment", () => {
    // The queue card must not be nested inside this row — if it were, the
    // cluster would no longer be the row's only ml-auto child.
    expect(controlsRowAt).toBeGreaterThan(-1);
    expect(composerSource.slice(controlsRowAt)).not.toContain("<QueuedComposerMessages");
  });

  it("no longer trails the transcript in either chat surface", () => {
    // The card owns the queue now. Two renderings of one list is how the
    // cancel button and the thing it cancels drift apart.
    for (const view of ["ChatView.tsx", "GroupView.tsx"]) {
      const source = readFileSync(join(COMPONENTS_DIR, view), "utf8");
      expect(source).not.toContain("pendingQueued");
    }
  });
});
