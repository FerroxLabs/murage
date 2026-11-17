import { describe, expect, it } from "vitest";

import { SETUP_OWN_RECORD_KEYS, setupCardKey } from "../shared/setup-card.ts";
import {
  type SetupLiveState,
  type SetupState,
  SETUP_DETECT_ANSWER,
  type SetupStep,
  deriveSetupState,
  emptySetupState,
  setupView,
} from "../shared/setup.ts";
import { setupConversationPlan } from "./setup-conversation.ts";

const BUNDLED = { id: "fuigo", name: "Fuigo", installed: false };
const live = (patch: Partial<SetupLiveState> = {}): SetupLiveState => ({
  ownerName: "Sean",
  agents: [BUNDLED],
  signedOutAgents: [],
  flux: { configured: false, conflict: false, looksValid: false },
  bundledEngine: { ready: true },
  chiefInstanceId: "",
  chiefAnsweredBy: [],
  chiefRefusal: null,
  chiefUsesFlux: false,
  crewSize: 0,
  connectedApps: 0,
  connectedAppIds: [],
  botReplyExists: false,
  routines: { total: 0, briefId: null, briefRan: false },
  ...patch,
});
function state(patch: Partial<Record<SetupStep, { skipped?: boolean; note?: string; done?: boolean }>> = {}): SetupState {
  const base = emptySetupState(1_000);
  const steps = { ...base.steps };
  for (const [step, recorded] of Object.entries(patch)) steps[step as SetupStep] = { done: false, ...recorded };
  return { ...base, steps };
}
const DETECTED = { note: SETUP_DETECT_ANSWER };
const view = (machine: SetupLiveState, recorded: SetupState) => setupView(deriveSetupState(recorded, machine, 2_000), machine);
const plan = (machine: SetupLiveState, recorded: SetupState, present: string[], settled: string[] = []) =>
  setupConversationPlan(view(machine, recorded), new Set(present), new Set(settled));
const keys = (cards: { key: string }[]) => cards.map((card) => card.key);

const HELLO = setupCardKey("hello", "welcome");
const DETECT = setupCardKey("detect", "bare");
const FLUX = setupCardKey("flux", "key");
const NO_KEY = setupCardKey("flux", "no-key");
const NOTIFY = setupCardKey("flux", "notify");
const HIRE = setupCardKey("chat", "hire");
const JOBS = setupCardKey("chat", "jobs");
const afterFlux = state({ detect: DETECTED, flux: { skipped: true } });

describe("D1 plan order on a fresh machine", () => {
  it("hello, detect, flux, flux:notify, chat:hire, chat:jobs", () => {
    const order: string[] = [];
    const present = new Set<string>([HELLO]);
    const settled = new Set<string>();
    const step = (recorded: SetupState) => {
      for (const card of plan(live(), recorded, [...present], [...settled]).append) {
        order.push(card.key);
        present.add(card.key);
      }
    };
    step(state());
    step(state({ detect: DETECTED }));
    step(afterFlux);
    settled.add(NOTIFY);
    step(afterFlux);
    settled.add(HIRE);
    step(afterFlux);
    expect(order).toEqual([DETECT, FLUX, NO_KEY, NOTIFY, HIRE, JOBS]);
  });
});

describe("D2 withheld until the one before is settled", () => {
  it("chat:jobs waits for chat:hire, and chat:hire for flux:notify", () => {
    const first = plan(live(), afterFlux, [HELLO, DETECT, FLUX, NO_KEY]);
    expect(keys(first.append)).toEqual([NOTIFY]);
    const noHire = plan(live(), afterFlux, [HELLO, DETECT, FLUX, NO_KEY, NOTIFY]);
    expect(keys(noHire.append)).toEqual([]);
    const hire = plan(live(), afterFlux, [HELLO, DETECT, FLUX, NO_KEY, NOTIFY], [NOTIFY]);
    expect(keys(hire.append)).toEqual([HIRE]);
    const stillNoJobs = plan(live(), afterFlux, [HELLO, DETECT, FLUX, NO_KEY, NOTIFY, HIRE], [NOTIFY]);
    expect(keys(stillNoJobs.append)).toEqual([]);
    const jobs = plan(live(), afterFlux, [HELLO, DETECT, FLUX, NO_KEY, NOTIFY, HIRE], [NOTIFY, HIRE]);
    expect(keys(jobs.append)).toEqual([JOBS]);
  });
});

describe("D3 an upgrade mid first run", () => {
  it("a transcript that already holds chat:jobs never gets notify or hire", () => {
    const result = plan(live(), afterFlux, [HELLO, DETECT, FLUX, NO_KEY, JOBS]);
    expect(keys(result.append)).not.toContain(NOTIFY);
    expect(keys(result.append)).not.toContain(HIRE);
  });
});

describe("D3b finished or skipped conversations", () => {
  it("never get any of the three new cards", () => {
    const skippedChat = state({ detect: DETECTED, flux: { skipped: true }, chat: { skipped: true } });
    const finished = state({ detect: DETECTED, flux: { skipped: true }, chat: { skipped: true }, flow: { skipped: true } });
    for (const recorded of [skippedChat, finished]) {
      const result = plan(live({ moveIn: { grok: 2 } }), recorded, [HELLO, DETECT]);
      for (const key of SETUP_OWN_RECORD_KEYS) expect(keys(result.append)).not.toContain(key);
    }
  });
});

describe("D4 steps never settle or unsettle the three cards", () => {
  it("only POST /api/setup/card settles them", () => {
    const result = plan(live(), afterFlux, [HELLO, DETECT, FLUX, NO_KEY, NOTIFY, HIRE], [NOTIFY]);
    for (const key of SETUP_OWN_RECORD_KEYS) {
      expect(result.settle).not.toContain(key);
      expect(result.unsettle).not.toContain(key);
    }
  });
});

describe("F5 detect:move-grok", () => {
  const MOVE = setupCardKey("detect", "move-grok");
  it("is planned only when the count is above 0, once, after the detect card", () => {
    expect(keys(plan(live({ moveIn: { grok: 0 } }), state({ detect: DETECTED }), [HELLO, DETECT]).append)).not.toContain(MOVE);
    const found = plan(live({ moveIn: { grok: 3 } }), state(), [HELLO, DETECT]);
    expect(keys(found.append)).toEqual([MOVE]);
    expect(keys(plan(live({ moveIn: { grok: 3 } }), state(), [HELLO, DETECT, MOVE]).append)).toEqual([]);
  });
  it("is planned right after hello on a blank machine", () => {
    const blank = live({ agents: [], moveIn: { grok: 1 } });
    expect(keys(plan(blank, state(), [HELLO]).append)).toContain(MOVE);
  });
  it("never once flux:key is present", () => {
    expect(keys(plan(live({ moveIn: { grok: 2 } }), state({ detect: DETECTED }), [HELLO, DETECT, FLUX]).append)).not.toContain(MOVE);
  });
});
