// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from "vitest";
import { TranscriptionUnavailable } from "./flux-voice.ts";
import { transcribeChannelClip } from "./channel-transcribe.ts";
import { MAX_CLIP_BYTES, createVoiceBudget } from "./transcribe-route.ts";

const clip = (bytes = 100, mime = "audio/ogg") => ({ bytes: new Uint8Array(bytes).fill(1), mime });

it("transcribes a clip, trims the text, and charges the budget what the provider billed", async () => {
  const budget = createVoiceBudget(), begin = vi.spyOn(budget, "begin");
  const transcribe = vi.fn(async (_recording: { filename: string; mime?: string }) => ({ text: "  hello there  ", billedSeconds: 12 }));
  expect(await transcribeChannelClip(clip(), { transcribe, budget })).toEqual({ ok: true, text: "hello there" });
  expect(transcribe.mock.calls[0][0]).toMatchObject({ filename: "clip.ogg", mime: "audio/ogg" });
  expect(begin).toHaveBeenCalledTimes(1);
});
it("refuses a clip over the push-to-talk cap, an unknown container and an empty clip before spending anything", async () => {
  const transcribe = vi.fn(async () => ({ text: "x" })), budget = createVoiceBudget(), begin = vi.spyOn(budget, "begin");
  expect(await transcribeChannelClip(clip(MAX_CLIP_BYTES + 1), { transcribe, budget })).toEqual({ ok: false, reason: "too-large" });
  expect(await transcribeChannelClip(clip(10, "video/mp4"), { transcribe, budget })).toEqual({ ok: false, reason: "format" });
  expect(await transcribeChannelClip(clip(0), { transcribe, budget })).toEqual({ ok: false, reason: "empty" });
  expect(transcribe).not.toHaveBeenCalled(); expect(begin).not.toHaveBeenCalled();
});
it("shares the hourly budget: once it is spent the clip is refused as busy and nothing is sent upstream", async () => {
  const budget = createVoiceBudget();
  const first = budget.begin(), second = budget.begin();
  expect(first.ok && second.ok).toBe(true);
  const transcribe = vi.fn(async () => ({ text: "x" }));
  expect(await transcribeChannelClip(clip(), { transcribe, budget })).toEqual({ ok: false, reason: "busy" });
  expect(transcribe).not.toHaveBeenCalled();
});
it("maps a missing key to unconfigured and any other failure to failed, releasing the slot each time", async () => {
  const budget = createVoiceBudget();
  const noKey = vi.fn(async () => { throw new TranscriptionUnavailable("key", "no key"); });
  expect(await transcribeChannelClip(clip(), { transcribe: noKey, budget })).toEqual({ ok: false, reason: "unconfigured" });
  const upstream = vi.fn(async () => { throw new TranscriptionUnavailable("upstream", "down"); });
  expect(await transcribeChannelClip(clip(), { transcribe: upstream, budget })).toEqual({ ok: false, reason: "failed" });
  const boom = vi.fn(async () => { throw new Error("boom"); });
  expect(await transcribeChannelClip(clip(), { transcribe: boom, budget })).toEqual({ ok: false, reason: "failed" });
  expect(await transcribeChannelClip(clip(), { transcribe: async () => ({ text: "   " }), budget })).toEqual({ ok: false, reason: "empty" });
  // Both concurrent slots are free again after those four calls.
  const a = budget.begin(), b = budget.begin();
  expect(a.ok && b.ok).toBe(true);
});
