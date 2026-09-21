// The fixture that was missing. Nothing in this suite could drive a CHANNEL
// PERSON through an internal route, so the allowlist guarding that surface
// was never asserted by anything — and a route that had to be on it was left
// off with no test to notice.
//
// These tests build a real verified channel binding, bind a real task thread
// to it, and put the real decision function in front of real paths. The last
// one goes further and runs the actual overflow path — the agents proxy's
// bounded result, the real cache, the real gate — for a channel person.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { boundedAgentResult, AGENT_RESULT_CAP_CHARS } from "./drivers/agents-result.ts";
import {
  bindHumanThread,
  linkHumanBinding,
  observeVerifiedHuman,
  resolveHumanBinding,
  threadHumanPrincipal,
} from "./human-principals.ts";
import {
  CHANNEL_PERSON_INTERNAL_REFUSAL,
  internalRouteRefusal,
} from "./internal-route-authority.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { Store } from "./store.ts";
import { TOOL_RESULT_PREVIEW_CHARS, ToolResults } from "./tool-results.ts";

beforeEach(() => {
  closeDatabase();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
});

/** A bot, its owner thread, and a second thread bound to a real linked
 * channel person — the two principals the internal gate has to tell apart. */
function principals() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot();
  const bindingId = observeVerifiedHuman({
    platform: "slack",
    connectionId: "fixture-connection",
    authorityId: "TEAM",
    userId: "U-CHANNEL-PERSON",
  });
  linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: 1, as: "person" });
  const channelTask = store.createTask(bot.id, "Channel conversation", false)!;
  bindHumanThread(channelTask.threadId, resolveHumanBinding(bindingId));
  const channel = threadHumanPrincipal(channelTask.threadId);
  const owner = threadHumanPrincipal(bot.threadId);
  expect(owner.personId).toBe("workspace-owner");
  expect(channel.personId).not.toBe("workspace-owner");
  return { store, bot, ownerThreadId: bot.threadId, channelThreadId: channelTask.threadId, owner, channel };
}

describe("internal routes, by principal", () => {
  it("lets the workspace owner through everywhere the internal surface goes", () => {
    const { owner } = principals();
    for (const path of ["/api/internal/routines", "/api/internal/computer-control", "/api/internal/connectors/request"]) {
      expect(internalRouteRefusal({ path, kind: "agents", principal: owner })).toBeNull();
    }
  });

  it("refuses a channel person the workspace, connector and computer routes", () => {
    const { channel } = principals();
    expect(internalRouteRefusal({ path: "/api/internal/routines", kind: "agents", principal: channel }))
      .toBe(CHANNEL_PERSON_INTERNAL_REFUSAL);
    expect(internalRouteRefusal({ path: "/api/internal/computer-control", kind: "computer", principal: channel }))
      .toBe(CHANNEL_PERSON_INTERNAL_REFUSAL);
    expect(internalRouteRefusal({ path: "/api/internal/connectors/request", kind: "connectors", principal: channel }))
      .toBe(CHANNEL_PERSON_INTERNAL_REFUSAL);
  });

  it("still lets a channel person's bot find and use its teammates", () => {
    const { channel } = principals();
    for (const path of [
      "/api/internal/agents",
      "/api/internal/ask-bot",
      "/api/internal/delegate-bot",
      "/api/internal/check-delegation",
      "/api/internal/wait-delegation",
      "/api/internal/delegations/d-01234567",
    ]) {
      expect(internalRouteRefusal({ path, kind: "agents", principal: channel })).toBeNull();
    }
  });

  it("leaves memory to its own authority rather than this gate", () => {
    const { channel } = principals();
    expect(internalRouteRefusal({ path: "/api/internal/memory/recall", kind: "memory", principal: channel })).toBeNull();
  });

  // Astra's finding 6. The overflow limiter caps an agents-tool result at
  // 24,000 characters and parks the tail — but the park and the page-back are
  // both this one path, and it was not on the allowlist. A channel person got
  // the preview and nothing else.
  it("lets a channel person park and page back their own oversized result", () => {
    const { channel } = principals();
    expect(internalRouteRefusal({ path: "/api/internal/tool-result", kind: "agents", principal: channel })).toBeNull();
  });
});

describe("an oversized agents-tool result for a channel person", () => {
  it("survives the gate whole: the tail is parked and readable, not lost", async () => {
    const { bot, channelThreadId, channel } = principals();
    const toolResults = new ToolResults();
    const tail = "the part that only the tail contains";
    const text = `${"z".repeat(AGENT_RESULT_CAP_CHARS + 5_000)}${tail}`;

    // Exactly what the route does: refuse by principal first, then save under
    // the live capability's own (bot, thread).
    const save = async (retained: string, truncated: boolean) => {
      const refusal = internalRouteRefusal({ path: "/api/internal/tool-result", kind: "agents", principal: channel });
      if (refusal) throw new Error(refusal);
      return toolResults.save({ botId: bot.id, threadId: channelThreadId }, retained, truncated);
    };

    const shown = await boundedAgentResult(text, save);
    expect(shown).not.toContain("is not retrievable");
    const notice = /tool_result_read with id "(r-[0-9a-f-]{36})" and offset (\d+)/.exec(shown);
    expect(notice).not.toBeNull();

    // And the page-back is the same gated path, so read it the same way.
    const readRefusal = internalRouteRefusal({ path: "/api/internal/tool-result", kind: "agents", principal: channel });
    expect(readRefusal).toBeNull();
    let offset = Number(notice![2]);
    let paged = "";
    for (let page = 0; page < 10; page += 1) {
      const result = toolResults.read({ botId: bot.id, threadId: channelThreadId }, notice![1], offset);
      if (!result) break;
      paged += result.text;
      if (result.nextOffset >= result.length) break;
      offset = result.nextOffset;
    }
    expect(shown.slice(0, TOOL_RESULT_PREVIEW_CHARS) + paged).toContain(tail);
  });

  it("still refuses that same cache to a channel person on someone else's conversation", () => {
    const { bot, ownerThreadId, channelThreadId } = principals();
    const toolResults = new ToolResults();
    const saved = toolResults.save({ botId: bot.id, threadId: ownerThreadId }, "the owner's own parked result");
    // Widening the allowlist grants the route, never another thread's content.
    expect(toolResults.read({ botId: bot.id, threadId: channelThreadId }, saved.id, 0)).toBeNull();
    expect(toolResults.read({ botId: bot.id, threadId: ownerThreadId }, saved.id, 0)?.text)
      .toBe("the owner's own parked result");
  });
});

// The wiring. server/index.ts starts a listening server on import, so this
// one cannot be executed here; it is asserted at the source instead, with
// whole-line comments stripped first so it matches code and never prose.
describe("server/index.ts wiring", () => {
  const code = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  it("asks this module rather than carrying its own copy of the allowlist", () => {
    expect(code).toContain("internalRouteRefusal({ path, kind: requiredKind, principal: threadHumanPrincipal(internalClaim.threadId) })");
    expect(code).not.toContain('"/api/internal/wait-delegation"].includes(path)');
    expect(code).not.toContain("This channel person has no workspace management");
  });
});
