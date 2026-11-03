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

  it("shows a line still being sent as Sending, with nothing to cancel yet", () => {
    const html = renderToStaticMarkup(createElement(QueuedComposerMessages, {
      items: [{ queueId: "sending:s1", text: "typed while it worked", sending: true }],
      onCancel: vi.fn(),
    }));
    expect(html).toContain("typed while it worked");
    expect(html).toContain("Sending");
    expect(html).not.toContain("Cancel queued message");
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
    'className={cn("relative z-[1] flex gap-1.5 bg-raised py-1.5"',
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

describe("QueuedComposerMessages: a refused send", () => {
  it("shows the words with why they were not sent, and Send again and Dismiss", () => {
    const html = renderToStaticMarkup(createElement(QueuedComposerMessages, {
      items: [{ queueId: "q9", text: "the room could not start this", refused: { notice: "refused" } }],
      onCancel: vi.fn(),
      onResend: vi.fn(),
    }));
    expect(html).toContain("the room could not start this");
    expect(html).toContain('data-testid="refused-send"');
    expect(html).toContain("Not sent");
    expect(html).toContain("Send again");
    expect(html).toContain("Dismiss");
    expect(html).not.toContain("Cancel queued message");
  });
});

// 1.0.14 QUEUED-RAW-ATTACHMENT-TAG: the queued line holds the composed prompt
// (composeMessage adds the attachment tags). It shows what the transcript
// bubble shows: the words, then images and files as chips. The tag and the
// local path never reach the screen, and the stored text is left as it was.
describe("QueuedComposerMessages: attachments in a queued line", () => {
  const imagePath = "/home/user/.mybot/attachments/3f2a9c1e-b7d4.png";
  const filePath = "/home/user/Documents/brief-notes.pdf";

  it("shows an attached image as a thumbnail, never the tag or the path", () => {
    const html = renderToStaticMarkup(createElement(QueuedComposerMessages, {
      items: [{ queueId: "q1", text: `look at this\n\n<attached-image path="${imagePath}" />` }],
      onCancel: vi.fn(),
    }));
    expect(html).toContain("look at this");
    expect(html).toContain("<img");
    expect(html).toContain("/api/attachments/3f2a9c1e-b7d4.png");
    expect(html).not.toContain("attached-image");
    expect(html).not.toContain(imagePath);
    expect(html).toContain("Queued for the next turn");
  });

  it("shows an attached file as a chip with its name, never the tag or the path", () => {
    const html = renderToStaticMarkup(createElement(QueuedComposerMessages, {
      items: [{ queueId: "q2", text: `<attached-file path="${filePath}" />` }],
      onCancel: vi.fn(),
    }));
    expect(html).toContain("brief-notes.pdf");
    expect(html).not.toContain("attached-file");
    expect(html).not.toContain(filePath);
    // only a chip: no empty dashed bubble under it
    expect(html).not.toContain("border-dashed");
  });

  it("hides the pasted-text wrapper and keeps the pasted words", () => {
    const html = renderToStaticMarkup(createElement(QueuedComposerMessages, {
      items: [{ queueId: "q3", text: `see below\n\n<pasted-text index="1">\nline one\n</pasted-text>` }],
      onCancel: vi.fn(),
    }));
    expect(html).toContain("see below");
    expect(html).toContain("line one");
    expect(html).not.toContain("pasted-text");
  });

  it("leaves plain text as typed", () => {
    const text = "also run the tests\n  and the linter";
    const html = renderToStaticMarkup(createElement(QueuedComposerMessages, {
      items: [{ queueId: "q4", text }],
      onCancel: vi.fn(),
    }));
    expect(html).toContain(text);
    expect(html).not.toContain("<img");
  });

  it("changes only what is drawn: the item keeps its composed text for Send again and Inject now", () => {
    const text = `look\n\n<attached-image path="${imagePath}" />`;
    const item = { queueId: "q5", text, refused: { notice: "refused" as const } };
    renderToStaticMarkup(createElement(QueuedComposerMessages, { items: [item], onCancel: vi.fn(), onResend: vi.fn() }));
    expect(item.text).toBe(text);
    // Send again hands the original item, composed text and all, to the handler
    const onResend = vi.fn();
    const found: Array<{ children?: unknown; onClick?: () => void }> = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== "object" || !("props" in node)) return;
      const props = (node as { props: { children?: unknown; onClick?: () => void } }).props;
      if (props.onClick && props.children === "Send again") found.push(props);
      walk(props.children);
    };
    walk(QueuedComposerMessages({ items: [item], onCancel: vi.fn(), onResend }));
    expect(found).toHaveLength(1);
    found[0]!.onClick!();
    expect(onResend).toHaveBeenCalledWith(item);
    expect(onResend.mock.calls[0]![0].text).toBe(text);
    // wiring checks: Send again re-sends the stored entry's text, not anything the chip drew
    expect(composerSource).toMatch(/type: "send", botId: bot\.id, text: again\.text/);
    expect(composerSource).toMatch(/type: "sendGroup", groupId: group\.id, text: again\.text/);
    // Inject now names queue ids; the server keeps the words it was sent
    expect(composerSource).toContain("queueIds: queuedMessages.map((entry) => entry.queueId)");
  });
});
