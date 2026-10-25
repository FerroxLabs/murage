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

describe("U36 send notices", () => {
  it("say why a press was not sent, from the language packs, with the words still in the box", () => {
    expect(composerSendNoticeText({ kind: "not-saved" })).toBe("Your words are still here. This device could not record the send, so nothing went out. Press Send again in a moment.");
    expect(composerSendNoticeText({ kind: "earlier-arrived" })).toBe("Your earlier message already reached the bot. Your edited words are still here, ready to send as a new message.");
    expect(composerSendNoticeText({ kind: "check-failed" })).toBe("Your words are still here. Murage could not yet confirm whether your earlier message arrived. Press Send again in a moment.");
  });
});

describe("the composer's send", () => {
  const start = composerSource.indexOf("const send = () => {");
  const send = composerSource.slice(start, composerSource.indexOf("// native dictation", start));

  it("checks the size before it dispatches anything or clears the draft", () => {
    expect(start).toBeGreaterThan(-1);
    const check = send.indexOf("if (messageIsTooLarge(t)) {");
    expect(check).toBeGreaterThan(-1);
    for (const later of ['type: "sendGroup"', 'type: "send",', "replyToIntake(", "beginDraftSend("]) {
      expect(send.indexOf(later), later).toBeGreaterThan(check);
    }
    // up to the block's own closing brace, past the notice object literal
    const refusal = send.slice(check, send.indexOf("\n    }", check));
    expect(refusal).toContain('setSendNotice({ kind: "too-large", sizeBytes: messageTextBytes(t) });');
    expect(refusal).toContain("return;");
  });

  it("turns a 413 from the harness into the same inline notice on every send path", () => {
    // Room send and direct send: the two paths that carry the person's text.
    //
    // TWO, NOT THREE. The setup question's answer used to be a third send —
    // it replaced the direct send while a question was open, which is M1 —
    // and it is now a fire-and-forget call made BESIDE the direct send, on a
    // sentence the direct send's own handler is already holding the draft
    // for. Restoring the draft there would fight the send that succeeded, and
    // a setup card that did not appear is not a message that did not send.
    // Both paths share one failure handler (show the size notice). U36: the words never left the box (its
    // record), so nothing is restored.
    expect(send.match(/onError: failedSend/g)).toHaveLength(2);
    expect(send.match(/refusedForSize\(error\)/g)).toHaveLength(1);
    expect(send).not.toContain("restoreDraft(");
    // a setup card that did not hear it is said quietly; it never fails the send
    expect(send).toContain("{ alongside: true }).then(() => setIntakeNotice(null), () => setIntakeNotice(INTAKE_NOT_RECORDED))");
  });

  it("shows the notice above the textarea and points the textarea at it", () => {
    const noticeAt = composerSource.indexOf("<ComposerSendNotice");
    expect(noticeAt).toBeGreaterThan(-1);
    expect(composerSource.indexOf("<textarea")).toBeGreaterThan(noticeAt);
    expect(composerSource).toContain("aria-invalid={sendNotice ? true : undefined}");
    expect(composerSource).toContain("aria-describedby={sendNotice ? sendNoticeId : undefined}");
  });
});
