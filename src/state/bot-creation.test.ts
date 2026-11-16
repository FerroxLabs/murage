// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { acceptCreatedBot } from "./bot-creation";
import { asAnswer } from "./answer-tag";
import { initialState, reducer, type Action, type Bot } from "./store";

const bot = { id: "new-bot", name: "Vega", computer: "local", messages: [] } as unknown as Bot;
const notice = "That computer is not available here, so this assistant started on this computer.";

describe("bot creation computer notice", () => {
  it("forwards the complete creation response before settling success", () => {
    const source = readFileSync(new URL("./store.tsx", import.meta.url), "utf8");
    const start = source.lastIndexOf('case "newBot":');
    const creation = source.slice(start, source.indexOf('case "duplicateBot":', start));
    expect(creation).toMatch(/\.then\(\(answer\) => \{\s*acceptCreatedBot\(rawDispatch, answer\);\s*action\.onSettled\?\.\(null\);/);
  });

  it("carries the server notice into the store for feedback and this bot's Computer settings", () => {
    const dispatch = vi.fn<(action: Action) => void>();
    acceptCreatedBot(dispatch, asAnswer({ bot, computerNotice: notice }));
    expect(dispatch.mock.calls[0][0]).toMatchObject({ type: "botAdded", bot });
    expect(dispatch.mock.calls[0][0]).toHaveProperty("source", "http");
    expect(dispatch.mock.calls[1][0]).toEqual({ type: "botComputerNotice", botId: bot.id, message: notice });
    const state = reducer({ ...initialState, botComputerNotices: { older: "Earlier notice" } }, dispatch.mock.calls[1][0]);
    expect(state.botComputerNotices).toEqual({ older: "Earlier notice", [bot.id]: notice });
  });

  it("adds the bot without a notice when the response has none", () => {
    const dispatch = vi.fn<(action: Action) => void>();
    acceptCreatedBot(dispatch, asAnswer({ bot }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "botAdded", bot }));
  });
});
