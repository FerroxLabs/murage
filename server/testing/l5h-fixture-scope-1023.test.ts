// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L5H fixture scope (bld1023-hooks-lineage r9): the results chat added module state to index.ts that the production dispatch reaches
// (the minute pass flags, the unwired ResultAudiencePort, the lazy EventResults and AppTriggerStore caches, the host object literal).
// The real dispatch fixture binds that dispatch from the extracted source, so every one of those names needs its state port with the
// production default, or every internal-dispatch case (g2-dependency-contracts, internal-dispatch-fixture) fails before it runs. The six scope
// rows check only that each name resolves; the host row below checks the host's values.
// One row per site (bld1023-hooks-lineage-r9/SITES.md), each through the real binding entry point internalDispatchAuthorityFixture.
// The host row (r10) reads the bound eventResultHost back through the same binding: every member of the index.ts literal is there and
// answers from this fixture's store (bot, missing bot, whole thread() state, a created Results chat read back with its route), so an empty
// or stubbed host fails it even though its name still resolves. r12: inside the bound dispatch it also replays a card (writeCard twice,
// one card id: production patches it in place, HostPorts.writeCard), commits the results origin and surfaces a held result, all read
// back from the Store. Base is the unmodified prior tip, no stub: there the replay threw in the fixture's patchMessage port, which only
// knew rows seeded in the consuming database (bld1023-hooks-lineage-r12/WITNESS-DESIGN.md).
import { threadHumanPrincipal } from "../human-principals.ts";
import { clearInternalAuthorityFixtures } from "./internal-authority-fixture.ts";
import { afterEach, expect, it } from "vitest";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { consumingFixture } from "./consuming-fixture.ts";
import { internalDispatchAuthorityFixture } from "./internal-dispatch-fixture.ts";
import type { HostPorts } from "../event-results.ts";

const SITES = ["eventResultPassBusy", "eventResultReplayRequested", "resultAudiencePort", "eventResultsCache", "eventResultHost", "appTriggerStoreCache"] as const;

const fixtures: ReturnType<typeof consumingFixture>[] = [];
afterEach(async () => { await clearInternalAuthorityFixtures(); for (const f of fixtures.splice(0)) f.close(); });

it.each(SITES)("the real dispatch binding resolves %s from its state port", async site => {
  const f = consumingFixture(undefined, { empty: true, botId: "scope-bot", threadId: "scope-thread" }); fixtures.push(f);
  const { botId, threadId, dispatchGeneration: generation } = f.binding.identity;
  const capabilities = new InternalCapabilities(); capabilities.begin(botId, threadId, generation, threadHumanPrincipal(threadId, f.f.db));
  let failure: unknown;
  try { await internalDispatchAuthorityFixture(f, capabilities, { provenance: true, initiator: { k: "owner-typed" }, generation }); } catch (error) { failure = error; }
  expect(String(failure ?? ""), site).not.toMatch(new RegExp(`\\b${site}\\b`));
  expect(failure).toBeUndefined();
});

const HOST_MEMBERS = ["bot", "createResultsTask", "guardResultsThread", "newThreadId", "now", "surfaceHeld", "thread", "writeCard"];
it("the real dispatch binding carries every production eventResultHost callback, answering from the fixture's store", async () => {
  const f = consumingFixture(undefined, { empty: true, botId: "scope-bot", threadId: "scope-thread" }); fixtures.push(f);
  const { botId, threadId, dispatchGeneration: generation } = f.binding.identity;
  const capabilities = new InternalCapabilities(); capabilities.begin(botId, threadId, generation, threadHumanPrincipal(threadId, f.f.db));
  let host: Record<string, unknown> | undefined; let failure: unknown; let dispatchAuthoritySetup: Awaited<ReturnType<typeof internalDispatchAuthorityFixture>>["dispatchAuthoritySetup"] | undefined;
  try {
    ({ dispatchAuthoritySetup } = await internalDispatchAuthorityFixture(f, capabilities, { provenance: true, initiator: { k: "owner-typed" }, generation }));
    // the bound closure resolves eventResultHost exactly as the production dispatch does (from its state port) and hands it back
    const bound = await dispatchAuthoritySetup.bind("async () => eventResultHost", {});
    host = await (bound.dispatch as unknown as () => Promise<Record<string, unknown> | undefined>)();
  } catch (error) { failure = error; }
  expect(Object.keys(host ?? {}).filter(key => typeof host?.[key] === "function").sort(), String(failure ?? "")).toEqual(HOST_MEMBERS);
  const ports = host as unknown as HostPorts;
  const results = String(ports.newThreadId());
  const answers = { now: typeof ports.now(), id: /^[0-9a-f-]{36}$/.test(results), bot: ports.bot(botId), gone: ports.bot("no-such-bot"), thread: ports.thread(botId, threadId),
    missing: ports.thread(botId, "no-such-thread"), created: ports.createResultsTask(botId, "Results", results, "route-scope"), routed: ports.thread(botId, results) };
  // the store effects run inside the bound dispatch, where production calls them (a replayed card, the results origin, a held result)
  const effectsBound = await dispatchAuthoritySetup!.bind(`async (botId, threadId) => {
    const outcome = write => { try { write(); return "ok"; } catch (error) { return String(error); } };
    const first = outcome(() => eventResultHost.writeCard(botId, threadId, { id: "evres-scope-run", text: "one" }));
    const replay = outcome(() => eventResultHost.writeCard(botId, threadId, { id: "evres-scope-run", text: "two" }));
    eventResultHost.guardResultsThread(threadId, botId, "auto-scope"); eventResultHost.surfaceHeld(botId, threadId, "no-audience");
    const origin = appTriggerStore().origin(threadId);
    return { first, replay, text: store.messageById(threadId, "evres-scope-run")?.text, cards: store.messagesFor(threadId).filter(message => message.id === "evres-scope-run").length,
      origin: origin && { kind: origin.kind, routineId: origin.routineId, homeId: origin.homeId }, unread: store.taskByThread(botId, threadId)?.unread };
  }`, {});
  const effects = await (effectsBound.dispatch as unknown as (botId: string, threadId: string) => Promise<unknown>)(botId, results);
  expect({ ...answers, effects }).toEqual({ now: "number", id: true, bot: { shared: false }, gone: undefined, thread: { exists: true, ownUnshared: true }, missing: { exists: false }, created: true, routed: { exists: true, resultsRoute: "route-scope", ownUnshared: true },
    effects: { first: "ok", replay: "ok", text: "two", cards: 1, origin: { kind: "results", routineId: "auto-scope", homeId: "desktop" }, unread: true } });
});
