import { describe, expect, it } from "vitest";

import { approvalKey } from "./auto-approve.ts";
import { FIRST_RUN_COPY } from "../src/lib/first-run-copy.ts";

/**
 * THE EMAIL PROMISE, CHECKED AGAINST THE THING THAT WOULD HAVE TO KEEP IT.
 *
 * The first run used to tell people: "Once you trust me with a kind of
 * email, I can send those myself." It shipped for as long as it did because
 * two tests REQUIRED that exact sentence, so the only way to correct it was
 * to break them. Nobody checked whether anything could deliver it.
 *
 * Nothing can. A remembered grant is keyed by `approvalKey`, and for
 * anything that is not a command tool that key IS the tool name. Every
 * connected-app call the assistant makes, reading mail or sending it, Gmail
 * or Slack, arrives as one wrapper tool. So one grant covers all of it and
 * no grant covers less than all of it. "A kind of email" is not a thing the
 * permission system has a name for.
 *
 * This test is the reason the copy tests can now assert a property instead
 * of a sentence: the fact the property is about is checked here, against the
 * real function, rather than asserted in prose. If somebody ever makes
 * approvals per-slug, the first assertion fails, and that is the day the
 * copy is allowed to promise something narrower.
 *
 * It calls one pure function and reads one data module. It starts nothing.
 */
const WRAPPER = "COMPOSIO_MULTI_EXECUTE_TOOL";
const READ_MAIL = '{"tools":[{"tool_slug":"GMAIL_FETCH_EMAILS","arguments":{"query":"newer_than:1d"}}]}';
const SEND_MAIL = '{"tools":[{"tool_slug":"GMAIL_SEND_EMAIL","arguments":{"to":"someone@example.invalid"}}]}';
const SEND_OTHER_MAIL = '{"tools":[{"tool_slug":"GMAIL_SEND_EMAIL","arguments":{"to":"accountant@example.invalid"}}]}';
const POST_SLACK = '{"tools":[{"tool_slug":"SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL","arguments":{"channel":"C0"}}]}';

describe("what a remembered approval can actually be narrowed to", () => {
  it("cannot tell reading mail from sending it", () => {
    expect(approvalKey(WRAPPER, READ_MAIL)).toBe(approvalKey(WRAPPER, SEND_MAIL));
  });

  it("cannot tell one kind of email from another, or Gmail from Slack", () => {
    const keys = [SEND_MAIL, SEND_OTHER_MAIL, POST_SLACK].map((summary) => approvalKey(WRAPPER, summary));
    expect(new Set(keys).size, "connected-app calls no longer share one grant").toBe(1);
  });

  it("keys on the whole tool name, which is the grant a person is offered", () => {
    expect(approvalKey(WRAPPER, SEND_MAIL)).toBe(WRAPPER);
  });
});

describe("what the first run is therefore allowed to promise about email", () => {
  const promises = [
    FIRST_RUN_COPY.apps.apps.trust,
    FIRST_RUN_COPY.routines["more-routines"].rows[0].why,
  ];

  it("says approval comes first, and says it where mail is asked for", () => {
    for (const line of promises) expect.soft(line, line).toMatch(/\byou approve\b/i);
  });

  it("promises no grant finer than the one key that exists", () => {
    for (const line of promises) {
      expect.soft(line, line).not.toMatch(
        /\b(?:a|an|any|each|one|this|that|these|those|some|certain|particular)\s+(?:kind|kinds|type|types|sort|sorts|category|categories)\s+of\b/i,
      );
    }
  });
});
