// The composer's answer to a message it will not send.
//
// Smoke round 1 typed a 4 MB message and pressed Enter: the text stayed in
// the box, nothing was sent, and nothing on screen said why. This file pins
// the answer the composer now gives.
//
// Same shape as every component test here (see PushToTalk.test.ts): a node
// environment with no jsdom, markup through `renderToStaticMarkup`, and the
// Composer's SOURCE read where the order of a few statements is the whole
// contract — the check must run before the draft is cleared, or the text is
// gone by the time the notice explains it. The real renderer is proven by
// src/e2e/composer-size-limit.human.spec.ts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MESSAGE_TEXT_MAX_BYTES } from "../../shared/message-limits";
import { ComposerSendNotice, composerSendNoticeText } from "./ComposerSendNotice";

const COMPONENTS_DIR = dirname(fileURLToPath(import.meta.url));
const composerSource = readFileSync(join(COMPONENTS_DIR, "Composer.tsx"), "utf8");

describe("ComposerSendNotice", () => {
  it("renders nothing when the last send was not refused", () => {
    expect(renderToStaticMarkup(createElement(ComposerSendNotice, { id: "n", notice: null, onDismiss: vi.fn() }))).toBe("");
  });

  it("is an alert that states the size and the limit in human units, and says the text is kept", () => {
    const html = renderToStaticMarkup(createElement(ComposerSendNotice, {
      id: "composer-notice",
      notice: { kind: "too-large", sizeBytes: 4 * 1024 * 1024 + 23 },
      onDismiss: vi.fn(),
    }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('id="composer-notice"');
    expect(html).toContain("Not sent: this message is 4 MB, and one message can be up to 1 MB.");
    expect(html).toContain("Your text is still here.");
    expect(html).toContain('aria-label="Dismiss"');
  });

  it("never tells a person their over-limit message is the size of the limit", () => {
    expect(composerSendNoticeText({ kind: "too-large", sizeBytes: MESSAGE_TEXT_MAX_BYTES + 1 }))
      .toContain("this message is 1.1 MB, and one message can be up to 1 MB");
  });

  it("says the harness refused it when the 413 came back from the server", () => {
    expect(composerSendNoticeText({ kind: "refused", sizeBytes: 900 * 1024 }))
      .toBe("Not sent: Murage refused this message because it is too large (900 KB). Shorten it or split it into smaller messages. Your text is still here.");
  });
});

describe("the composer's send", () => {
  const start = composerSource.indexOf("const send = () => {");
  const send = composerSource.slice(start, composerSource.indexOf("// native dictation", start));

  it("checks the size before it dispatches anything or clears the draft", () => {
    expect(start).toBeGreaterThan(-1);
    const check = send.indexOf("if (messageIsTooLarge(t)) {");
    expect(check).toBeGreaterThan(-1);
    for (const later of ['type: "sendGroup"', 'type: "send",', "replyToIntake(", 'setText("")']) {
      expect(send.indexOf(later), later).toBeGreaterThan(check);
    }
    // up to the block's own closing brace, past the notice object literal
    const refusal = send.slice(check, send.indexOf("\n    }", check));
    expect(refusal).toContain('setSendNotice({ kind: "too-large", sizeBytes: messageTextBytes(t) });');
    expect(refusal).toContain("return;");
  });

  it("turns a 413 from the harness into the same inline notice on every send path", () => {
    // room send, direct send, and the setup question's answer
    expect(send.match(/refusedForSize\(error\)/g)).toHaveLength(3);
    expect(send.match(/restoreDraft\(sentDraft\)/g)).toHaveLength(3);
  });

  it("shows the notice above the textarea and points the textarea at it", () => {
    const noticeAt = composerSource.indexOf("<ComposerSendNotice");
    expect(noticeAt).toBeGreaterThan(-1);
    expect(composerSource.indexOf("<textarea")).toBeGreaterThan(noticeAt);
    expect(composerSource).toContain("aria-invalid={sendNotice ? true : undefined}");
    expect(composerSource).toContain("aria-describedby={sendNotice ? sendNoticeId : undefined}");
  });
});
