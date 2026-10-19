import { describe, expect, it } from "vitest";

import { approvalKey } from "./auto-approve.ts";
import { FIRST_RUN_COPY } from "../src/lib/first-run-copy.ts";

/**
 * THE EMAIL PROMISE, CHECKED AGAINST THE THING THAT WOULD HAVE TO KEEP IT.
 *
 * The first run once told people: "Once you trust me with a kind of email, I
 * can send those myself." Nothing could deliver it: a remembered grant was the
 * bare tool name, and every connected-app call runs through one execute tool,
 * so one grant covered reading mail, sending it and posting to Slack alike.
 *
 * Since 1.0.3 a grant names the one app action the card showed
 * (shared/app-action-grant.ts): "Gmail: send email" and nothing else. That
 * is one action, still not "a kind of email": sending to one person and to
 * another are the same action. So the copy below still promises no kind.
 *
 * It calls one pure function and reads one data module. It starts nothing.
 */
const WRAPPER = "mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL";
const READ_MAIL = { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { query: "newer_than:1d" } }] };
const SEND_MAIL = { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "someone@example.invalid" } }] };
const SEND_OTHER_MAIL = { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "accountant@example.invalid" } }] };
const POST_SLACK = { tools: [{ tool_slug: "SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL", arguments: { channel: "C0" } }] };
const keyFor = (input: unknown) => approvalKey(WRAPPER, JSON.stringify(input), undefined, { toolCall: { name: WRAPPER, input } });

describe("what a remembered approval can actually be narrowed to", () => {
  it("tells reading mail from sending it, and Gmail from Slack", () => {
    expect(keyFor(READ_MAIL)).not.toBe(keyFor(SEND_MAIL));
    expect(new Set([SEND_MAIL, POST_SLACK, READ_MAIL].map(keyFor)).size).toBe(3);
  });

  it("cannot tell one kind of email from another: one action is one grant", () => {
    expect(keyFor(SEND_MAIL)).toBe(keyFor(SEND_OTHER_MAIL));
  });

  it("never offers the wrapper tool itself, the grant that covered every app", () => {
    expect(keyFor(SEND_MAIL)).toBe("app-action:GMAIL_SEND_EMAIL");
    expect(approvalKey(WRAPPER, JSON.stringify(SEND_MAIL))).toBeUndefined();
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

  it("promises no grant finer than one action, the narrowest key that exists", () => {
    for (const line of promises) {
      expect.soft(line, line).not.toMatch(
        /\b(?:a|an|any|each|one|this|that|these|those|some|certain|particular)\s+(?:kind|kinds|type|types|sort|sorts|category|categories)\s+of\b/i,
      );
    }
  });
});
