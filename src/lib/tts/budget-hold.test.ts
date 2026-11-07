// VOICE-402-STOP, the window's half: once the harness says the Flux key's
// budget is used up, auto-speak and call mode stop sending speech requests
// for the next messages, instead of about three per message.
import { afterEach, describe, expect, it, vi } from "vitest";

import { Speaker, VOICE_BUDGET_HOLD_MS } from "./index";

const LINE = "Voice is paused: this Flux key has reached its budget. It starts again when the budget changes.";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

function budgetSpent() {
  const speech: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/prepare")) return json({ ready: true, utterances: ["One.", "Two.", "Three."] });
      speech.push(String(init?.body));
      return json({ error: LINE, code: "voice_budget_reached" }, 402);
    }),
  );
  return speech;
}

describe("the budget hold", () => {
  it("40 messages after a budget 402 send 1 speech request, not about 120", async () => {
    const speech = budgetSpent();
    let now = 1_000;
    const speaker = new Speaker(() => now, () => {});
    for (let i = 0; i < 40; i += 1) {
      await speaker.speak(`Message ${i}. Two. Three.`, { messageId: `m${i}` });
      now += 1_000;
    }
    expect(speech.length).toBeLessThanOrEqual(2);
    expect(speaker.state.error).toBe(LINE);
  });

  it("asks again once the hold ends, and a picker preview asks at once", async () => {
    const speech = budgetSpent();
    let now = 1_000;
    const speaker = new Speaker(() => now, () => {});
    await speaker.speak("One. Two. Three.", { messageId: "a" });
    const first = speech.length;
    await speaker.speak("One. Two. Three.", { messageId: "voice-preview:cedar" });
    expect(speech.length).toBeGreaterThan(first);
    const second = speech.length;
    await speaker.speak("One. Two. Three.", { messageId: "b" });
    expect(speech.length).toBe(second);
    now += VOICE_BUDGET_HOLD_MS + 1;
    await speaker.speak("One. Two. Three.", { messageId: "c" });
    expect(speech.length).toBeGreaterThan(second);
  });
});
