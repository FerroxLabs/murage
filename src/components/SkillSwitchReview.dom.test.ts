// MAIN RULING design F §1.1: switch fixtures include the reviewed verdict binding; OPEN for GrokBuild approval.
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// Private server review producer and rendered proof consumer owner: skill-switch lane.
import { webcrypto, createHash } from "node:crypto";
import { createElement as h, act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDOMHarness, mount, cleanup } from "../testing/dom-harness";
import { SkillRequestPreview } from "./SkillRequestPreview";
import { privateSkillReviewDigest } from "@/lib/skill-switch-review";
import { api } from "@/state/store";
import type { SkillRequestCardData } from "../../shared/skill-request";
vi.mock("@/state/store", () => ({ api: vi.fn() }));
let restore: () => void;
beforeEach(() => { restore = installDOMHarness(); vi.stubGlobal("crypto", webcrypto); });
afterEach(() => { cleanup(); restore(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
const text = "Private fixture skill instructions";
const request: SkillRequestCardData = { version: 1, requestId: "fixture-request", botId: "fixture-bot", threadId: "fixture-thread", stagedId: "", action: "delete", verdictHash:"a".repeat(64), findings:[], name: "sample-skill", sha256: createHash("sha256").update(text).digest("hex"), createdAt: 0 };
async function drain(check: () => void) {
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); check(); });
}
it("Grok H2: private text is fetched on the owner surface, hashed, rendered, and forgotten on unmount", async () => {
  let release!: (body: unknown) => void;
  vi.mocked(api).mockReturnValue(new Promise(resolve => { release = resolve; }));
  const view = mount(h(SkillRequestPreview, { request, messageId: "fixture-message" }));
  expect(view.container.textContent).not.toContain(text);
  expect(privateSkillReviewDigest(request, "fixture-message")).toBeUndefined();
  expect(api).toHaveBeenCalledWith("/api/threads/fixture-thread/skill-switch-review/fixture-message", expect.objectContaining({ cache: "no-store" }));
  await act(async () => { release({ request: { ...request, preview: text } }); });
  await drain(() => expect(view.container.textContent).toContain(text));
  expect(privateSkillReviewDigest(request, "fixture-message")).toBe(request.sha256);
  expect(request.preview).toBeUndefined();
  view.unmount(); expect(privateSkillReviewDigest(request, "fixture-message")).toBeUndefined();
});
it.each(["refused", "hash-changed"])("Grok H2: %s private review never enables approval or paints body bytes", async failure => {
  if (failure === "refused") vi.mocked(api).mockRejectedValue({ status: 403 });
  else vi.mocked(api).mockResolvedValue({ request: { ...request, preview: text + " changed" } });
  const view = mount(h(SkillRequestPreview, { request, messageId: "fixture-refused" }));
  await drain(() => expect(view.container.textContent).toContain("Open Murage"));
  expect(view.container.textContent).not.toContain(text);
  expect(privateSkillReviewDigest(request, "fixture-refused")).toBeUndefined();
});

it.each([409, 422, 503, "transport", "hash"])("M3 private review: %s explains failure and retries safely while mounted", async failure => {
  if (failure === "hash") vi.mocked(api).mockResolvedValueOnce({ request: { ...request, preview: text + " changed" } });
  else vi.mocked(api).mockRejectedValueOnce(failure === "transport" ? new TypeError("fetch failed") : { status: failure });
  const view = mount(h(SkillRequestPreview, { request, messageId: "fixture-retry" }));
  const expected = failure === 409 || failure === 422 || failure === "hash" ? "changed" : "could not be loaded";
  await drain(() => expect(view.container.textContent).toContain(expected));
  expect(view.container.textContent).not.toContain("Open Murage on your computer");
  expect(privateSkillReviewDigest(request, "fixture-retry")).toBeUndefined();
  expect(view.container.textContent).not.toContain(text);
  let release!: (body: unknown) => void;
  vi.mocked(api).mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  const retry = view.container.querySelector("button")!;
  expect(retry?.textContent).toBe("Retry private review");
  await act(async () => retry.click());
  expect(view.container.textContent).toContain("Loading the private skill review");
  expect(privateSkillReviewDigest(request, "fixture-retry")).toBeUndefined();
  await act(async () => release({ request: { ...request, preview: text } }));
  await drain(() => expect(view.container.textContent).toContain(text));
  expect(privateSkillReviewDigest(request, "fixture-retry")).toBe(request.sha256);
  expect(api).toHaveBeenCalledTimes(2);
});
