import { describe, expect, it } from "vitest";
import {
  abandonedLinkFailure,
  authorizeFailureSentence,
  CONNECTOR_LINK_LIFETIME_MS,
  panelAuthorizeError,
  connectorFailure,
  connectorRequestKey,
  connectorRequestStatus,
  connectorTimedOutSentence,
  parseConnectorRequests,
} from "./connector-requests.ts";

describe("account-scoped connector requests", () => {
  it("preserves legacy requests and deduplicates canonical account identities", () => {
    expect(parseConnectorRequests({ slugs: [" GMAIL ", "gmail"] })).toEqual([{ slug: "gmail" }]);
    expect(parseConnectorRequests({ items: [
      { slug: "GMAIL", alias: " Work " }, { toolkit: "gmail", account: "work" },
      { slug: "gmail", alias: "Personal" }, "gmail",
    ], slugs: ["ignored"] })).toEqual([
      { slug: "gmail", alias: "Work" }, { slug: "gmail", alias: "Personal" }, { slug: "gmail" },
    ]);
    expect(connectorRequestKey({ slug: "gmail", alias: "Work" })).not.toBe(connectorRequestKey({ slug: "gmail", alias: "Personal" }));
  });

  // Upstream #1602: Composio spells a toolkit that starts with a digit with a
  // leading underscore, and the request card dropped every one of them.
  it("keeps underscore-prefixed toolkit slugs and still drops malformed ones", () => {
    expect(parseConnectorRequests({ slugs: ["_1password", " _21RISK ", "-dash", "", "bad slug"] })).toEqual([{ slug: "_1password" }, { slug: "_21risk" }]);
  });

  it("uses the existing alias validation instead of silently dropping invalid account intent", () => {
    for (const alias of [123, " ", "\ninvalid", "x".repeat(65)]) {
      // Leading whitespace is normalized by Composio, so use an embedded control character.
      const value = alias === "\ninvalid" ? "in\nvalid" : alias;
      expect(() => parseConnectorRequests({ items: [{ slug: "gmail", alias: value }] })).toThrow(/Account alias/);
    }
  });

  it("cannot complete a second-account card from first-account readiness or missing inventory", () => {
    const first = { connected: true, pending: false, status: "ACTIVE", accounts: [{ alias: "Personal", status: "ACTIVE" }] };
    expect(connectorRequestStatus(first, "Work")).toEqual({ connected: false, pending: false, status: "not_connected" });
    expect(connectorRequestStatus({ ...first, accounts: undefined }, "Work").connected).toBe(false);
    expect(connectorRequestStatus(first).connected).toBe(true);
    expect(connectorRequestStatus({ ...first, accounts: [...first.accounts, { alias: " WORK ", status: "INITIATED" }] }, "work")).toEqual({ connected: false, pending: true, status: "INITIATED" });
    expect(connectorRequestStatus({ ...first, accounts: [...first.accounts, { alias: " WORK ", status: "ACTIVE" }] }, "work").connected).toBe(true);
  });
});

// 0.1.62, Bug 1. A sign-in link that ran out was shown as the provider's word
// pasted into a red line ("Connection EXPIRED"), and when the poll gave up the
// card said nothing at all. Every end state is now one plain sentence, and the
// reason travels with the card.
describe("a sign-in that did not finish says why, in plain words", () => {
  const now = Date.UTC(2026, 9, 2, 12, 0, 0);
  const EXPIRED = "The sign-in link expired before it was finished. Try again.";

  it("calls an expired link expired", () => {
    expect(connectorFailure({ status: "EXPIRED", label: "Gmail", now })).toEqual({ kind: "timed-out", sentence: EXPIRED });
  });

  it("calls a failed link that is older than the link's life expired", () => {
    const since = now - CONNECTOR_LINK_LIFETIME_MS - 60_000;
    expect(connectorFailure({ status: "FAILED", label: "Gmail", since, now })).toEqual({ kind: "timed-out", sentence: EXPIRED });
  });

  it("calls a failed link whose reason says it expired, expired", () => {
    expect(connectorFailure({ status: "FAILED", reason: "Link expired", label: "Gmail", now })?.kind).toBe("timed-out");
    expect(connectorFailure({ status: "FAILED", reason: "timed out waiting for the user", label: "Gmail", now })?.kind).toBe("timed-out");
  });

  it("calls a fresh refusal a cancelled or refused sign-in, naming the app", () => {
    expect(connectorFailure({ status: "FAILED", reason: "access_denied", label: "Gmail", since: now - 30_000, now })).toEqual({
      kind: "denied",
      sentence: "Gmail sign-in was cancelled or refused. Try again.",
    });
  });

  it("gives any other fresh failure the generic sentence, never the provider's word", () => {
    for (const status of ["FAILED", "REVOKED", "ERROR"]) {
      const answer = connectorFailure({ status, label: "Gmail", since: now - 30_000, now });
      expect(answer).toEqual({ kind: "failed", sentence: "Couldn't finish connecting Gmail. Try again." });
      expect(answer?.sentence).not.toMatch(new RegExp(status, "i"));
    }
  });

  it("is not a failure while the sign-in is still going, or once it connected", () => {
    for (const status of ["ACTIVE", "INITIATED", "INITIALIZING", "PENDING", "not_connected", undefined]) {
      expect(connectorFailure({ status, label: "Gmail", now })).toBeNull();
    }
  });

  it("writes the final timed-out sentence the card shows when polling ends", () => {
    expect(connectorTimedOutSentence()).toBe(EXPIRED);
  });

  it("says a slow service is slow, not the runtime's exception text", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const abort = new DOMException("The operation was aborted", "AbortError");
    expect(authorizeFailureSentence(timeout, "Gmail")).toBe("Connected apps took too long to answer. Try again.");
    expect(authorizeFailureSentence(abort, "Gmail")).toBe("Connected apps took too long to answer. Try again.");
  });

  it("turns a service error into a sentence, and an unknown one into a generic one", () => {
    expect(authorizeFailureSentence(Object.assign(new Error("<html>nginx</html>"), { status: 502 }), "Gmail")).toMatch(/aren't answering right now/);
    expect(authorizeFailureSentence(new Error("something odd happened at line 12"), "Gmail")).toBe("Couldn't start the Gmail sign-in. Try again.");
  });

  it("keeps a message that is already a plain sentence about the alias", () => {
    const clash = Object.assign(new Error('Account alias "work" is already in use for gmail'), { status: 409 });
    expect(authorizeFailureSentence(clash, "Gmail")).toBe('Account alias "work" is already in use for gmail');
  });

  it("never uses an em dash, a safety word, the vendor's name or a price", () => {
    const all = [
      connectorTimedOutSentence(),
      connectorFailure({ status: "FAILED", label: "Gmail", now })?.sentence,
      connectorFailure({ status: "FAILED", reason: "denied", label: "Gmail", since: now, now })?.sentence,
      authorizeFailureSentence(new DOMException("x", "TimeoutError"), "Gmail"),
      authorizeFailureSentence(new Error("odd"), "Gmail"),
    ].join(" ");
    expect(all).not.toMatch(/—|\bsafe|safety|composio|\$|price/i);
  });

  it("carries the provider's reason and creation time through the request status", () => {
    const service = { connected: false, pending: false, status: "FAILED", statusReason: "access_denied", createdAt: "2026-10-02T11:00:00Z" };
    expect(connectorRequestStatus(service)).toMatchObject({ status: "FAILED", reason: "access_denied", createdAt: "2026-10-02T11:00:00Z" });
    const account = { connected: false, accounts: [{ id: "a", alias: "work", status: "EXPIRED", statusReason: "link expired", createdAt: "2026-10-02T11:00:00Z" }] };
    expect(connectorRequestStatus(account, "work")).toMatchObject({ status: "EXPIRED", reason: "link expired", createdAt: "2026-10-02T11:00:00Z" });
  });
});

describe("review round 1: choosing the account behind a label", () => {
  it("F9: prefers an active account over a newer dead attempt with the same label", () => {
    const service = { connected: true, accounts: [
      { id: "new", alias: "Work", status: "FAILED", createdAt: "2026-10-02T11:59:00Z" },
      { id: "old", alias: "work", status: "ACTIVE", createdAt: "2026-09-01T10:00:00Z" },
    ] };
    expect(connectorRequestStatus(service, "work")).toMatchObject({ connected: true, status: "ACTIVE" });
  });

  it("F9: then a pending one, then the newest", () => {
    const pending = { accounts: [
      { id: "a", alias: "work", status: "EXPIRED", createdAt: "2026-10-02T11:59:00Z" },
      { id: "b", alias: "work", status: "INITIATED", createdAt: "2026-10-01T10:00:00Z" },
    ] };
    expect(connectorRequestStatus(pending, "work")).toMatchObject({ pending: true, status: "INITIATED" });
    const dead = { accounts: [
      { id: "a", alias: "work", status: "FAILED", statusReason: "old one", createdAt: "2026-09-01T10:00:00Z" },
      { id: "b", alias: "work", status: "EXPIRED", statusReason: "newest", createdAt: "2026-10-02T11:00:00Z" },
    ] };
    expect(connectorRequestStatus(dead, "work")).toMatchObject({ status: "EXPIRED", reason: "newest" });
  });
});

describe("review round 1: a link nobody finished (F5)", () => {
  const now = Date.UTC(2026, 9, 2, 12, 0, 0);
  it("ends as timed out once the card's own start is past the link's life plus a short grace", () => {
    const authorizedAt = now - CONNECTOR_LINK_LIFETIME_MS - 2 * 60_000;
    expect(abandonedLinkFailure({ authorizedAt, now })).toEqual({ kind: "timed-out", sentence: connectorTimedOutSentence() });
  });

  it("does not end a link that is still inside its life, or one with no recorded start", () => {
    expect(abandonedLinkFailure({ authorizedAt: now - 60_000, now })).toBeNull();
    expect(abandonedLinkFailure({ authorizedAt: now - CONNECTOR_LINK_LIFETIME_MS - 1_000, now })).toBeNull(); // inside the grace
    expect(abandonedLinkFailure({ authorizedAt: undefined, now })).toBeNull();
  });
});

describe("review round 1: what the panel's authorize route shows (F16)", () => {
  it("never shows the vendor's name or a bare HTTP status for a provider failure", () => {
    for (const raw of ["Composio authorization: HTTP 500", "Composio does not manage auth for toolkit twitter", "<html>bad gateway</html>"]) {
      const shown = panelAuthorizeError(new Error(raw), "gmail");
      expect(shown.message).not.toMatch(/composio|HTTP \d/i);
      expect(shown.message).toMatch(/Try again\.$/);
    }
  });

  it("keeps the alias prompts the panel acts on", () => {
    const prompt = Object.assign(new Error("Add an account alias so the existing connection is not replaced"), { status: 400 });
    const clash = Object.assign(new Error('Account alias "work" is already in use for gmail'), { status: 409 });
    expect(panelAuthorizeError(prompt, "gmail")).toBe(prompt);
    expect(panelAuthorizeError(clash, "gmail")).toBe(clash);
  });

  it("keeps the status so the route answers with it", () => {
    const shown = panelAuthorizeError(new DOMException("x", "TimeoutError"), "gmail");
    expect((shown as { status?: number }).status).toBe(504);
  });
});
