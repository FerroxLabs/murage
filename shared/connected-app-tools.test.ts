// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { plainConnectedAppText } from "./connected-app-tools";

// Windows customer pass, 0.1.60 (D8): an approval card and its pending panel
// read "composio__COMPOSIO_SEARCH_TOOLS". Product copy never names the
// connection service, and a tool id is not words.
it("names the connection service's own tools in plain words", () => {
  expect(plainConnectedAppText("composio__COMPOSIO_SEARCH_TOOLS")).toBe("Look up which app tools to use");
  expect(plainConnectedAppText("mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL")).toBe("Run a connected-app action");
  expect(plainConnectedAppText("COMPOSIO_MANAGE_CONNECTIONS")).toBe("Manage a connected app's sign-in");
  expect(plainConnectedAppText("composio__COMPOSIO_GET_TOOL_SCHEMAS")).toBe("Read a connected-app tool's details");
  expect(plainConnectedAppText("composio__COMPOSIO_REMOTE_WORKBENCH")).toBe("Run code for a connected app");
  expect(plainConnectedAppText("composio__COMPOSIO_SOMETHING_NEW")).toBe("Use your connected apps");
});

it("names an app's own action by the app", () => {
  expect(plainConnectedAppText("mcp__composio__GMAIL_SEND_EMAIL")).toBe("Connected app: Gmail send email");
});

it("rewrites the name inside a longer line and leaves other text alone", () => {
  expect(plainConnectedAppText("Approved: composio__COMPOSIO_SEARCH_TOOLS {\"q\":\"notion\"}")).toBe("Approved: Look up which app tools to use {\"q\":\"notion\"}");
  expect(plainConnectedAppText("ls -la notes")).toBe("ls -la notes");
});

it("is applied where engine events become messages, so cards, activity, Inbox and tray all read it", async () => {
  const { readFileSync } = await import("node:fs");
  const index = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  expect(index).toMatch(/const pushMessage = \(raw[^)]*\) => \{[\s\S]{0,300}plainConnectedAppMessage\(raw\)/);
});
