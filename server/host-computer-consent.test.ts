// The one-time confirmation before a bot on Auto first acts on this computer:
// who is asked, who is grandfathered, and what is (and is not) remembered.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import {
  awaitHostComputerConsent,
  cancelHostComputerConsentForThread,
  dismissStaleHostConsentCards,
  grandfatheredHostComputerConsent,
  hostConsentState,
  HOST_CONSENT_TOOL,
  resolveHostComputerConsent,
} from "./host-computer-consent.ts";
import type { ApprovalBus } from "./peer-approval.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const bus = (store: Store): ApprovalBus => ({ store, broadcast: () => {} });
const consentCards = (store: Store, threadId: string) => store.messagesFor(threadId).filter((m) => m.card?.tool === HOST_CONSENT_TOOL);
const allowedHostCard = (answered: string) => ({
  role: "bot" as const, kind: "options" as const,
  card: { title: "Local computer approval", subtitle: "click", options: ["Allow", "Deny"], requestId: `r-${answered}`, tool: "mcp__computer__click", approvalScope: "local-computer" as const, answered },
});

describe("who is asked", () => {
  it("asks only a bot on Auto, and only where Auto reaches this computer", () => {
    expect(hostConsentState({ computer: undefined }, "darwin")).toBe("ask");
    expect(hostConsentState({ computer: undefined, hostComputerConsent: "declined" }, "darwin")).toBe("declined");
    expect(hostConsentState({ computer: undefined, hostComputerConsent: "allowed" }, "darwin")).toBe("allowed");
    // The owner chose This computer: that choice is the consent.
    expect(hostConsentState({ computer: "local" }, "darwin")).toBe("not-needed");
    expect(hostConsentState({ computer: "cloud" }, "darwin")).toBe("not-needed");
    // Auto never reaches the host on Linux or Windows.
    expect(hostConsentState({ computer: undefined }, "linux")).toBe("not-needed");
    expect(hostConsentState({ computer: undefined }, "win32")).toBe("not-needed");
  });

  it("grandfathers only a bot that has already used this computer", () => {
    const none = new Set<string>();
    const base = { threadId: "t1", tasks: [{ threadId: "t1", autoApprove: false }, { threadId: "t2", autoApprove: false }] } as Pick<BotRecord, "threadId" | "tasks">;
    expect(grandfatheredHostComputerConsent({ ...base, computer: undefined }, none)).toBe("ask");
    expect(grandfatheredHostComputerConsent({ ...base, computer: "local" }, none)).toBe("allowed");
    expect(grandfatheredHostComputerConsent({ ...base, computer: undefined, autoApprove: true }, none)).toBe("allowed");
    expect(grandfatheredHostComputerConsent({ ...base, computer: undefined, tasks: [{ ...base.tasks![0]!, autoApprove: true }] as BotRecord["tasks"] }, none)).toBe("allowed");
    // Auto mode on a bot that is on a cloud box never saw the local warning.
    expect(grandfatheredHostComputerConsent({ ...base, computer: "cloud", autoApprove: true }, none)).toBe("ask");
    expect(grandfatheredHostComputerConsent({ ...base, computer: undefined }, new Set(["t2"]))).toBe("allowed");
    expect(grandfatheredHostComputerConsent({ ...base, computer: undefined }, new Set(["someone-else"]))).toBe("ask");
  });
});

describe("the card", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });

  it("shows one card for concurrent actions and remembers the owner's Allow", async () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const first = awaitHostComputerConsent(bus(store), bot, bot.threadId, 5_000);
    const second = awaitHostComputerConsent(bus(store), bot, bot.threadId, 5_000);
    const cards = consentCards(store, bot.threadId);
    expect(cards).toHaveLength(1);
    const remembered: Array<[string, string]> = [];
    expect(resolveHostComputerConsent(cards[0]!.card!.requestId!, "allow", (id, consent) => remembered.push([id, consent]))).toBe(true);
    expect(await first).toBe("allowed");
    expect(await second).toBe("allowed");
    expect(remembered).toEqual([[bot.id, "allowed"]]);
    expect(consentCards(store, bot.threadId)[0]!.card).toMatchObject({ answered: "allow", dismissed: false });
    // A settled card is no longer anyone's to answer.
    expect(resolveHostComputerConsent(cards[0]!.card!.requestId!, "allow", () => {})).toBe(false);
  });

  it("remembers Deny as declined", async () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const waiting = awaitHostComputerConsent(bus(store), bot, bot.threadId, 5_000);
    const remembered: string[] = [];
    resolveHostComputerConsent(consentCards(store, bot.threadId)[0]!.card!.requestId!, "deny", (_id, consent) => remembered.push(consent));
    expect(await waiting).toBe("declined");
    expect(remembered).toEqual(["declined"]);
  });

  it("keeps the card open when an action stops waiting, so a later answer still counts", async () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    expect(await awaitHostComputerConsent(bus(store), bot, bot.threadId, 20)).toBe("waiting");
    const [card] = consentCards(store, bot.threadId);
    expect(card!.card!.answered).toBeUndefined();
    // a retry joins the same card rather than opening another
    const retry = awaitHostComputerConsent(bus(store), bot, bot.threadId, 5_000);
    expect(consentCards(store, bot.threadId)).toHaveLength(1);
    const remembered: string[] = [];
    expect(resolveHostComputerConsent(card!.card!.requestId!, "allow", (_id, consent) => remembered.push(consent))).toBe(true);
    expect(await retry).toBe("allowed");
    expect(remembered).toEqual(["allowed"]);
  });

  it("closes the card unanswered when the turn stops, and remembers nothing", async () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const waiting = awaitHostComputerConsent(bus(store), bot, bot.threadId, 5_000);
    const [card] = consentCards(store, bot.threadId);
    cancelHostComputerConsentForThread(bot.threadId);
    expect(await waiting).toBe("waiting");
    expect(consentCards(store, bot.threadId)[0]!.card).toMatchObject({ answered: "deny", dismissed: true });
    expect(resolveHostComputerConsent(card!.card!.requestId!, "allow", () => { throw new Error("must not remember"); })).toBe(false);
    // the next action asks again with a fresh card
    void awaitHostComputerConsent(bus(store), bot, bot.threadId, 10);
    expect(consentCards(store, bot.threadId)).toHaveLength(2);
    cancelHostComputerConsentForThread(bot.threadId);
  });

  it("settles a card a previous run left open", () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    store.appendMessage(bot.threadId, { role: "bot", kind: "options", card: { title: "Let @x use this computer?", subtitle: "", options: ["Allow", "Deny"], requestId: "stale", tool: HOST_CONSENT_TOOL } });
    expect(dismissStaleHostConsentCards(bus(store))).toBe(1);
    expect(consentCards(store, bot.threadId)[0]!.card).toMatchObject({ answered: "deny", dismissed: true });
  });
});

describe("grandfathering on load", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });

  it("starts a new bot at ask", () => {
    const store = new Store(selection);
    expect(store.createBot({}, { seedMessages: false }).hostComputerConsent).toBe("ask");
  });

  it("evaluates each existing bot once, from what it has already done", () => {
    const store = new Store(selection);
    const fresh = store.createBot({ name: "Fresh" }, { seedMessages: false });
    const autoMode = store.createBot({ name: "Auto mode" }, { seedMessages: false });
    const usedIt = store.createBot({ name: "Used it" }, { seedMessages: false });
    const deniedIt = store.createBot({ name: "Denied it" }, { seedMessages: false });
    const explicit = store.createBot({ name: "Explicit" }, { seedMessages: false });
    store.appendMessage(usedIt.threadId, allowedHostCard("allow"));
    store.appendMessage(deniedIt.threadId, allowedHostCard("deny"));
    // what a build before this one wrote: no hostComputerConsent at all
    const botsFile = join(DATA_DIR, "bots.json");
    const legacy: BotRecord[] = JSON.parse(readFileSync(botsFile, "utf8"));
    for (const record of legacy) {
      delete record.hostComputerConsent;
      if (record.id === autoMode.id) { record.autoApprove = true; record.tasks![0]!.autoApprove = true; }
      if (record.id === explicit.id) record.computer = "local";
    }
    writeFileSync(botsFile, JSON.stringify(legacy));

    const reloaded = new Store(selection);
    expect(reloaded.bot(fresh.id)?.hostComputerConsent).toBe("ask");
    expect(reloaded.bot(autoMode.id)?.hostComputerConsent).toBe("allowed");
    expect(reloaded.bot(usedIt.id)?.hostComputerConsent).toBe("allowed");
    expect(reloaded.bot(deniedIt.id)?.hostComputerConsent).toBe("ask");
    expect(reloaded.bot(explicit.id)?.hostComputerConsent).toBe("allowed");
    const persisted: BotRecord[] = JSON.parse(readFileSync(botsFile, "utf8"));
    expect(persisted.find((record) => record.id === autoMode.id)?.hostComputerConsent).toBe("allowed");

    // Once evaluated, later evidence never grants it silently: only the
    // owner's own answer on the card does.
    reloaded.appendMessage(fresh.threadId, allowedHostCard("allow"));
    expect(new Store(selection).bot(fresh.id)?.hostComputerConsent).toBe("ask");
  });
});
