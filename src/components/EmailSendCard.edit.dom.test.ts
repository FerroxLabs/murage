// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, installDOMHarness, mount, settle } from "../testing/dom-harness";
import { EmailSendCard } from "./EmailSendCard";
import type { Message } from "../state/store";
const fixture = vi.hoisted(() => ({ api: vi.fn(async () => ({})) }));
vi.mock("../state/store", () => ({ api: fixture.api }));
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(() => { cleanup(); fixture.api.mockClear(); });
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
