// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// What the docs, the in-app help and the tool description tell people and bots
// about images. They must say what the code does: images follow the level, with
// a record, for the owner's own conversations and routines, and a card for
// anyone else. A bot that is told "an approval card always shows" warns the
// owner about a card that never comes.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const OLD = "Image generation still asks before it spends.";
const NEW = "Images follow the level: under Full access and No limits they are made without asking in your own conversations and routines, with a record of each, unless you change **Bot settings → Permissions → Images**. A webhook, a contact or anyone else still gets the card.";

describe("the docs and the in-app help", () => {
  it("say images follow the level, not that they always ask", () => {
    const docs = read("apps/docs/content/docs/features/approvals-and-inspector.mdx");
    expect(docs).not.toContain(OLD);
    expect(docs).toContain(NEW);
    // the owner's own channel messages still show the card for images
    expect(docs).toContain("Your own messages from Telegram, Slack or Discord always show the card for images.");
    const help = read("shared/help-index.ts");
    expect(help).not.toContain(OLD);
    expect(help).toContain("Images follow the level: under Full access and No limits they are made without asking in your own conversations and routines");
  });
});

describe("the generate_image tool description", () => {
  const proxy = read("server/drivers/agents-proxy.ts");
  const line = proxy.split("\n").find(text => text.includes('name: "generate_image"')) ?? "";
  it("says the card is shown unless the level or the Images setting lets the bot make images without asking", () => {
    expect(line).toContain("unless this bot's level or its Images setting lets it make images without asking in this turn");
    expect(line).toContain("it leaves a record with the full prompt in the conversation instead and the request is made at once");
    expect(line).not.toContain("Unless the owner has set this bot to make images without asking");
  });
  it("says what applies per turn on each path", () => {
    expect(line).not.toContain("One image request per turn.");
    expect(line).toContain("Where the card is shown, one image request per turn.");
    expect(line).toContain("When images are made without asking, several requests per turn are allowed: wait for each to finish, and never retry an uncertain one with a new request_id.");
  });
});
