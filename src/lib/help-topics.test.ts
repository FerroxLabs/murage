// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 H1: the 24 help topics, each with one link that opens it; the nine rewritten v7 topics; no "Learn more".
import { describe, expect, it } from "vitest";
import { HELP_TOPICS, helpTopic, helpTopicLink, helpTopicBody } from "./help-topics";
import { parseSettingsAddress } from "./settings-address";

describe("help topics (H1)", () => {
  it("has 24 topics and 24 links, one each, ids unique", () => {
    expect(HELP_TOPICS).toHaveLength(24);
    expect(new Set(HELP_TOPICS.map((t) => t.id)).size).toBe(24);
    for (const topic of HELP_TOPICS) {
      const link = helpTopicLink(topic.id);
      expect(link, topic.id).toMatch(/^murage:\/\/settings\//);
      expect(parseSettingsAddress(link), topic.id).not.toBeNull();
      expect(helpTopic(topic.id)?.id).toBe(topic.id);
    }
  });
  it("no topic or title reads Learn more", () => {
    for (const topic of HELP_TOPICS) {
      expect(`${topic.title} ${topic.body}`.toLowerCase()).not.toContain("learn more");
    }
  });
  it("keeps the nine rewritten v7 topics", () => {
    const body = (id: string) => helpTopicBody(id, true);
    expect(body("start")).toContain("FluxRouter");
    expect(body("engines")).toContain("does not sign Codex in");
    expect(body("models")).toContain("clears the app choices saved for that bot");
    expect(body("apps")).toContain("Works now");
    expect(body("approvals")).toContain("A chat with a guest in it stays at Ask");
    expect(body("skills")).toContain("fixed size");
    expect(body("routines")).toContain("After a restore every routine is off");
    expect(body("memory")).toContain("nothing is deleted");
    expect(body("backups")).toContain("does not hold sign-ins to AI engines or messaging apps");
  });
  it("states the voice exceptions and the per-bot voice service", () => {
    const voice = helpTopicBody("voice", true);
    expect(voice).toContain("Emergency");
    expect(voice).toContain("booked for a set time");
    expect(voice).toContain("saved once");
  });
  it("lists the No limits turn kinds and the never-covered three in approvals", () => {
    const approvals = helpTopicBody("approvals", true);
    expect(approvals).toContain("routines, trigger links from other apps and work other bots hand it");
    expect(approvals).toContain("A bot that may only draft never runs at No limits");
  });
  it("the shortcut word comes from one string for Mac and Windows", () => {
    expect(helpTopicBody("overview", true)).toContain("⌘K");
    expect(helpTopicBody("overview", false)).toContain("Ctrl K");
    expect(helpTopicBody("overview", false)).not.toContain("⌘");
    expect(helpTopic("overview")?.body).toContain("{mod}");
  });
});
