// M6 client witnesses: W16 client leg (one changeId across retries, CHECKING never OPEN), W14 (Open in Settings writes nothing),
// W18 busy control state, Fable r2 L2 writer copy.
import { describe, expect, it } from "vitest";
import type { SettingCardRecord } from "../../shared/settings-chat";
import { COULD_NOT_CHECK_LINE, controlState, openSettingsAddressFor, sendTap, type CardView } from "./settings-chat";

const card: SettingCardRecord = { cardId: "card-1", threadId: "th-dax", botId: "dax", generation: "1", settingId: "bot.model", settingBot: "dax",
  writerTarget: { kind: "bot" }, cardGen: 1, state: "OPEN", reason: "cheaper", createdAt: 1 };
const view = (over: Partial<CardView> = {}): CardView => ({ card, label: "Model", path: "Settings > Bots > Model", scopeLine: "Dax's model", control: "inline", value: "model-a", expect: "model-a", busy: false, ...over });

describe("M6 client", () => {
  it("W16 client: a lost reply re-sends the SAME changeId; giving up is CHECKING, never OPEN", async () => {
    const sent: string[] = [];
    let calls = 0;
    const fetch = async (_url: string, init: { body: string }) => {
      sent.push((JSON.parse(init.body) as { changeId: string }).changeId);
      if (++calls < 3) throw new Error("transport lost");
      return { status: 200, json: async () => ({ ok: true, card: { ...card, state: "SETTLED", outcome: "changed" } }) };
    };
    const state = await sendTap("card-1", { value: "model-c", expect: "model-a", cardGen: 1 }, { fetch, botName: "Dax" });
    expect(state.kind).toBe("settled");
    expect(new Set(sent).size).toBe(1);
    const lost: string[] = [];
    const never = async (_url: string, init: { body: string }) => { lost.push((JSON.parse(init.body) as { changeId: string }).changeId); return { status: 503, json: async () => ({ ok: false, code: "COULD_NOT_CHECK" }) }; };
    const checking = await sendTap("card-1", { value: "model-c", expect: "model-a", cardGen: 1 }, { fetch: never, botName: "Dax" });
    expect(checking).toMatchObject({ kind: "checking", line: COULD_NOT_CHECK_LINE });
    expect(new Set(lost).size).toBe(1);
    // Try again keeps the changeId from CHECKING
    const again: string[] = [];
    await sendTap("card-1", { value: "model-c", expect: "model-a", cardGen: 1, changeId: (checking as { changeId: string }).changeId },
      { fetch: async (_u: string, init: { body: string }) => { again.push((JSON.parse(init.body) as { changeId: string }).changeId); return { status: 200, json: async () => ({ ok: true, card }) }; }, botName: "Dax" });
    expect(again).toEqual([lost[0]]);
  });

  it("W14: Open in Settings is an address only; building it makes no request", () => {
    let requests = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { requests++; throw new Error("no writes"); }) as typeof fetch;
    try {
      expect(openSettingsAddressFor(view(), "bot")).toBe("murage://settings/bot/dax/model/");
      expect(requests).toBe(0);
    } finally { globalThis.fetch = realFetch; }
  });

  it("W18 client: the control is disabled with the working line while the writer's busy check holds; writer sentences read plainly", async () => {
    expect(controlState(view({ busy: true }), "Dax")).toEqual({ enabled: false, line: "Dax is working. Stop it or wait for the reply." });
    expect(controlState(view(), "Dax")).toEqual({ enabled: true });
    expect(controlState(view({ control: "open", controlNote: "This needs the Murage app on your computer." }), "Dax").enabled).toBe(false);
    const refused = await sendTap("card-1", { value: "model-c", expect: "model-a", cardGen: 1 },
      { fetch: async () => ({ status: 409, json: async () => ({ ok: false, code: "WRITER_REFUSED", error: "the bot is working: stop it before changing models", card }) }), botName: "Dax" });
    expect(refused).toMatchObject({ kind: "open", line: "Dax is working. Stop it or wait for the reply." });
  });
});
