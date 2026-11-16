// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { EmailSendCard, EmailTrustOfferCard } from "./EmailSendCard";
import type { Message } from "../state/store";
const fixture = vi.hoisted(() => ({ api: vi.fn(async () => ({})), proof: vi.fn(async (post: () => Promise<unknown>, _input: unknown) => post()) }));
vi.mock("../state/store", () => ({ api: fixture.api }));
vi.mock("../lib/fresh-auth", () => ({ respondWithFreshAuth: fixture.proof }));
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(() => { cleanup(); fixture.api.mockClear(); fixture.proof.mockClear(); });
for (const suffix of ["", "\n\nAttachments:\nnotes.txt (12 bytes, SHA-256 fixture)"]) {
  it(`Edit and Save preserve presentation-only email text with ${suffix ? "attachments" : "no attachments"}`, async () => {
    const text = "\nOwner's draft 📨\n\nAttachments:\nThis is still the body.\n\n";
    const message = { card: { requestId: "email-fixture", title: "Email", subtitle: "To: fake@example.invalid\nSubject: Test\n\n" + text + suffix,
      emailSend: { revision: 2, phase: "open", actions: ["edit"], draft: { text: "", presentation: { textLength: text.length, trailingLength: suffix.length } }, links: {} } } } as unknown as Message;
    const app = mount(h(EmailSendCard, { threadId: "fixture-thread", message }));
    const button = (label: string) => [...app.container.querySelectorAll("button")].find(item => item.textContent === label)!;
    await act(async () => button("Edit").click());
    expect(app.container.querySelector("textarea")!.value).toBe(text);
    await act(async () => button("Save").click());
    await settle();
    const [path, init] = fixture.api.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/threads/fixture-thread/respond");
    expect(JSON.parse(init.body as string).emailDraft.text).toBe(text);
  });
}

it("an invalid presentation range refuses editing without submitting an empty replacement", async () => {
  const message = { card: { requestId: "email-fixture", subtitle: "retained words", emailSend: {
    phase: "open", actions: ["edit"], draft: { text: "", presentation: { textLength: 999, trailingLength: 0 } }, links: {}
  } } } as unknown as Message;
  const app = mount(h(EmailSendCard, { threadId: "fixture-thread", message }));
  await act(async () => app.container.querySelector("button")!.click());
  expect(app.container.querySelector("textarea")).toBeNull();
  expect(app.container.querySelector('[role="alert"]')!.textContent).toContain("unavailable");
  expect(fixture.api).not.toHaveBeenCalled();
});

it("renders delivered lifecycle updates and reloaded settled sends without open controls", () => {
  const message = { card: { requestId: "send-fixture", title: "Send email", subtitle: "Reviewed body", options: ["Send"],
    emailSend: { revision: 1, phase: "open", actions: ["send"], draft: { text: "" }, links: {} } } } as unknown as Message;
  const app = mount(h(EmailSendCard, { threadId: "fixture-thread", message }));
  expect(app.container.textContent).toContain("Send");
  for (const phase of ["answered", "settled"] as const) {
    const delivered = { ...message, emailDisplay: { title: "Email", options: [], emailSend: { ...message.card!.emailSend!, phase, actions: [], note: phase === "settled" ? "Sent." : "Sending." } } };
    // JSON round trip models the messages response after reloading the thread.
    app.rerender(h(EmailSendCard, { threadId: "fixture-thread", message: JSON.parse(JSON.stringify(delivered)) }));
    expect(app.container.querySelectorAll("button")).toHaveLength(0);
    expect(app.container.textContent).toContain(phase === "settled" ? "Sent." : "Sending.");
    expect(app.container.textContent).toContain("Reviewed body");
  }
});

it("renders a delivered trust settlement after reloading without Add or Not now", () => {
  const message = { card: { requestId: "email-trust-fixture", title: "Trust", subtitle: "contact@example.invalid",
    emailTrustOffer: { address: "contact@example.invalid", phase: "open" } },
    emailDisplay: { title: "Trust", subtitle: "Added contact@example.invalid", options: [], emailTrustOffer: { address: "contact@example.invalid", phase: "added" } } } as unknown as Message;
  const app = mount(h(EmailTrustOfferCard, { threadId: "fixture-thread", message: JSON.parse(JSON.stringify(message)) }));
  expect(app.container.querySelectorAll("button")).toHaveLength(0);
  expect(app.container.textContent).toContain("Added contact@example.invalid");
});

it("binds a displayed Retry to the original approval identity and fresh-auth card", async () => {
  const message = { card: { requestId: "send-fixture", title: "Send email", subtitle: "Reviewed body", options: ["Send"],
    emailSend: { revision: 1, phase: "open", actions: ["send"], draft: { text: "" }, links: {} } },
    emailDisplay: { requestId: "display-alias", title: "Try sending again", options: ["Retry"],
      emailSend: { revision: 3, phase: "open", actions: ["retry"], draft: { text: "" }, links: {} } } } as unknown as Message;
  const app = mount(h(EmailSendCard, { threadId: "fixture-thread", message }));
  await act(async () => app.container.querySelector("button")!.click());
  const [, init] = fixture.api.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(init.body as string)).toMatchObject({ requestId: "send-fixture", emailRevision: 3, emailAction: "retry" });
  expect(fixture.proof.mock.calls[0]![1]).toMatchObject({ requestId: "send-fixture", card: message.card });
});

it("never reopens a superseded permission card from stale Retry display data", () => {
  const message = { card: { requestId: "send-fixture", title: "Email", subtitle: "Reviewed body", answered: "Allowed", dismissed: true,
    emailSend: { phase: "open", actions: ["send"], draft: { text: "" }, links: {} } },
    emailDisplay: { title: "Try again", options: ["Retry"], emailSend: { phase: "open", actions: ["retry"], draft: { text: "" }, links: {} } } } as unknown as Message;
  const app = mount(h(EmailSendCard, { threadId: "fixture-thread", message }));
  expect(app.container.querySelectorAll("button")).toHaveLength(0);
});
