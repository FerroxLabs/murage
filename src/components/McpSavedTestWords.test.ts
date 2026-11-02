// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// A Test on a server that is already saved says what is true: Murage is starting
// it. The first-time wording belongs to a server being added.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "@/lib/i18n";
import { testWaitKey } from "@/lib/mcp-add-flow";
import { savedProbeSentence } from "@/lib/mcp-card-view";
import { en } from "@/locales";
import { allLocalePacks } from "@/locales/testing";
import { SavedTestWait } from "./McpServersPanel";

const words = (elapsed: number) => renderToStaticMarkup(createElement(SavedTestWait, { elapsed }));

describe("the Test wait on a saved server", () => {
  afterEach(() => setLocale("en"));

  it("starts the server, then says it is slow, at every length of wait", () => {
    expect(words(3)).toContain("Starting the server…");
    for (const elapsed of [8, 12, 59, 60, 75, 300]) {
      expect(words(elapsed)).toContain("This is taking longer than usual.");
      expect(words(elapsed)).not.toMatch(/first time|setting up/i);
    }
  });

  it("keeps the first-time wording for a server being added", () => {
    expect([3, 12, 75].map((elapsed) => testWaitKey(elapsed, true))).toEqual(["mcp.card.install.start", "mcp.card.install.setup", "mcp.card.install.still"]);
  });

  it("ends a slow Test without saying it is installing", () => {
    const stillInstalling = { ok: false as const, reason: "still-installing" as const, error: "It is still installing." };
    expect(savedProbeSentence(stillInstalling, "")).toBe("The server did not answer in time.");
    expect(savedProbeSentence({ ok: false, reason: "spawn", error: "Could not start this command." }, "")).toBe("Could not start this command.");
  });

  it("is what the saved card draws", () => {
    const panel = readFileSync(new URL("./McpServersPanel.tsx", import.meta.url), "utf8");
    expect(panel).toContain("<SavedTestWait elapsed={elapsed} />");
    expect(panel).toContain("savedProbeSentence(result, host)");
    expect(panel).not.toContain("mcp.card.install.");
  });

  it("is in every language", async () => {
    const packs = await allLocalePacks();
    for (const [code, pack] of Object.entries(packs) as Array<[string, Record<string, string>]>) {
      for (const key of ["mcp.card.test.slow", "mcp.card.test.noAnswer"]) expect(pack[key], `${code} ${key}`).toBeTruthy();
    }
    expect((en as Record<string, string>)["mcp.card.test.slow"]).toBe("This is taking longer than usual.");
  });
});
