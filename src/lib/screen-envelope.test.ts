// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildFeedbackRequest,
  buildScreenEnvelope,
  checkFeedbackRequest,
  checkScreenEnvelope,
  ENVELOPE_LIMITS,
  envelopeForScreen,
  FEEDBACK_CHOICE_WORDS,
  FEEDBACK_CHOICES,
  FEEDBACK_REQUEST_FIELDS,
  feedbackSurface,
  isFeedbackChoice,
  REMOVED,
  resolveHelpScreen,
  scrubSecrets,
  type HelpScreenInput,
} from "./screen-envelope";
import { hx } from "@/components/help/help-copy";

const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../../shared/screen-envelope.schema.json", import.meta.url)), "utf8"));
const FAKE_KEYS = ["sk-ant-FAKEFAKEFAKEFAKEFAKE1234", "ghp_FAKEFAKEFAKEFAKEFAKEFAKE1", "AKIAFAKEFAKEFAKE1234", "xoxb-FAKE-FAKE-FAKE-FAKE-FAKE-1"]; // secret-scan: fixture

describe("screen envelope", () => {
  it("a chat screen with a draft and a key on screen produces an envelope without either", () => {
    const draft = "my draft about the merger, password=hunter2hunter2";
    // What a careless caller might hand over: the whole state, transcript and draft included.
    const careless = {
      activeView: "chat",
      bot: { id: "bot-1", name: "Nova" },
      connected: true,
      drafts: { "bot-1": draft },
      messages: [{ text: `here is my key ${FAKE_KEYS[0]}` }],
      config: { apiKey: FAKE_KEYS[1] },
    } as unknown as HelpScreenInput;
    const envelope = envelopeForScreen(resolveHelpScreen(careless), hx);
    const wire = JSON.stringify(envelope);
    expect(wire).not.toContain("merger");
    expect(wire).not.toContain("hunter2");
    for (const key of FAKE_KEYS) expect(wire).not.toContain(key);
    expect(envelope.screen).toBe("chat:bot-1");
    expect(envelope.title).toBe("Nova");
    expect(envelope.state).toEqual({ botId: "bot-1" });
    expect(envelope.controls.map((c) => c.address)).toEqual(["murage://bots/bot-1/settings/permissions", "murage://bots/bot-1/settings"]);
    expect(checkScreenEnvelope(envelope)).toBeNull();
  });

  it("scrubs a key out of a bot name used as the title", () => {
    const envelope = envelopeForScreen(resolveHelpScreen({ activeView: "chat", bot: { id: "b", name: `Bot ${FAKE_KEYS[2]}` } }), hx);
    expect(envelope.title).toBe(`Bot ${REMOVED}`);
  });

  it("sends a secret-shaped id as \"removed\"", () => {
    const envelope = buildScreenEnvelope({ screen: `chat:${FAKE_KEYS[0]}`, title: "x", botId: FAKE_KEYS[0], selectedCard: FAKE_KEYS[2] });
    expect(envelope.screen).toBe("removed");
    expect(envelope.state.botId).toBe("removed");
    expect(envelope.state.selectedCard).toBe("removed");
    expect(JSON.stringify(envelope)).not.toContain("FAKE");
  });

  it("names the screen from the view, overlays first", () => {
    const base: HelpScreenInput = { activeView: "chat", bot: { id: "b1", name: "Max" }, connected: true };
    expect(resolveHelpScreen({ ...base, settingsPage: "usage" }).screen).toBe("settings:usage");
    expect(resolveHelpScreen({ ...base, settingsPage: "nope" }).screen).toBe("settings:general");
    expect(resolveHelpScreen({ ...base, botSettingsOpen: true }).screen).toBe("bot:b1");
    expect(resolveHelpScreen({ ...base, pluginsOpen: true }).screen).toBe("apps");
    expect(resolveHelpScreen({ ...base, activeView: "all-chats" }).screen).toBe("chats");
    expect(resolveHelpScreen({ ...base, activeView: "team-map" }).screen).toBe("map");
    expect(resolveHelpScreen({ ...base, activeView: "routines" }).screen).toBe("routines");
    expect(resolveHelpScreen({ ...base, group: { id: "g1", name: "Launch" }, bot: null }).screen).toBe("group:g1");
    expect(resolveHelpScreen({ ...base, noEngines: true }).screen).toBe("no-engines");
    const first = resolveHelpScreen({ ...base, firstRun: { next: "flux", chiefBotId: "b1", blocked: ["chat"] } });
    expect(first.screen).toBe("first-run:flux");
    expect(first.gates.map((g) => g.id)).toEqual(["first-run:chat"]);
    expect(resolveHelpScreen({ ...base, firstRun: { next: "flux", chiefBotId: "other", blocked: [] } }).screen).toBe("chat:b1");
    expect(resolveHelpScreen({ ...base, connected: false }).gates.map((g) => g.id)).toEqual(["offline"]);
  });

  it("drops anything that does not fit the allowlist instead of sending it", () => {
    const envelope = buildScreenEnvelope({
      screen: "chat:bot 1 with spaces",
      title: "x".repeat(500),
      botId: "has spaces",
      openFolds: ["advanced", "not ok!"],
      selectedCard: "card:123",
      gates: [{ id: "engine", reason: "No engine" }, { id: "bad id!", reason: "x" }],
      controls: [{ id: "level", label: "Level", address: "https://evil.example" }],
    });
    expect(envelope.screen).toBe("unknown");
    expect(envelope.title.length).toBe(ENVELOPE_LIMITS.title);
    expect(envelope.state).toEqual({ openFolds: ["advanced"], selectedCard: "card:123", gates: [{ id: "engine", reason: "No engine" }] });
    expect(envelope.controls).toEqual([]);
    expect(checkScreenEnvelope(envelope)).toBeNull();
  });

  it("refuses unknown fields at every level", () => {
    const ok = { screen: "today", title: "Today", state: {}, controls: [] };
    expect(checkScreenEnvelope(ok)).toBeNull();
    expect(checkScreenEnvelope({ ...ok, messages: ["hi"] })).toMatch(/unknown field messages/);
    expect(checkScreenEnvelope({ ...ok, state: { draft: "x" } })).toMatch(/unknown field state.draft/);
    expect(checkScreenEnvelope({ ...ok, state: { gates: [{ id: "a", reason: "b", body: "c" }] } })).toMatch(/unknown field state.gates.body/);
    expect(checkScreenEnvelope({ ...ok, controls: [{ id: "a", label: "b", address: "murage://x", value: "secret" }] })).toMatch(/unknown field controls.value/);
  });

  it("matches the shared schema's fields and limits", () => {
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(["controls", "screen", "state", "title"]);
    expect(Object.keys(schema.properties.state.properties).sort()).toEqual(["botId", "gates", "openFolds", "page", "section", "selectedCard"]);
    expect(schema.properties.state.additionalProperties).toBe(false);
    expect(schema.properties.controls.items.additionalProperties).toBe(false);
    expect(schema.properties.state.properties.gates.items.additionalProperties).toBe(false);
    expect(schema.properties.screen.maxLength).toBe(ENVELOPE_LIMITS.screen);
    expect(schema.properties.title.maxLength).toBe(ENVELOPE_LIMITS.title);
    expect(schema.properties.controls.maxItems).toBe(ENVELOPE_LIMITS.controls);
    expect(schema.properties.controls.items.properties.label.maxLength).toBe(ENVELOPE_LIMITS.label);
    expect(schema.properties.state.properties.gates.items.properties.reason.maxLength).toBe(ENVELOPE_LIMITS.reason);
  });
});

describe("feedback request", () => {
  it("names the surface, never taking an unknown one for the desktop", () => {
    expect(feedbackSurface(true, false)).toBe("desktop");
    expect(feedbackSurface(false, false)).toBe("phone");
    expect(feedbackSurface(undefined, false)).toBe("phone");
    expect(feedbackSurface(true, true)).toBe("cloud");
  });

  const envelope = envelopeForScreen(resolveHelpScreen({ activeView: "routines", connected: true }), hx);

  it("carries only the envelope, the choice's fixed sentence, the surface and the time", () => {
    const request = buildFeedbackRequest({ envelope, choice: "cant-find", surface: "desktop", now: new Date("2026-11-02T12:00:00Z") });
    expect(Object.keys(request).sort()).toEqual([...FEEDBACK_REQUEST_FIELDS].sort());
    expect(request.words).toBe("I couldn't find something on this screen.");
    expect(request.createdAt).toBe("2026-11-02T12:00:00.000Z");
    expect(checkFeedbackRequest(request)).toBeNull();
  });

  it("sends only a fixed sentence per choice, never text the owner typed (1.0.12)", () => {
    expect([...FEEDBACK_CHOICES]).toEqual(["complicated", "cant-do", "cant-find"]);
    for (const choice of FEEDBACK_CHOICES) {
      const request = buildFeedbackRequest({ envelope, choice, surface: "phone", now: new Date() });
      expect(request.words).toBe(FEEDBACK_CHOICE_WORDS[choice]);
      expect(checkFeedbackRequest(request)).toBeNull();
    }
    expect(isFeedbackChoice("cant-do")).toBe(true);
    for (const bad of ["", "other", "My key is sk-ant-FAKEFAKEFAKEFAKEFAKE1234", "__proto__", "constructor", 1, null]) { // secret-scan: fixture
      expect(isFeedbackChoice(bad)).toBe(false);
      expect(() => buildFeedbackRequest({ envelope, choice: bad as never, surface: "desktop", now: new Date() })).toThrow(/unknown feedback choice/);
    }
    expect(Object.isFrozen(FEEDBACK_CHOICE_WORDS)).toBe(true);
  });

  it("refuses a request with an unknown field, owner words or a bad surface", () => {
    const request = buildFeedbackRequest({ envelope, choice: "complicated", surface: "cloud", now: new Date() });
    expect(checkFeedbackRequest({ ...request, messages: "the whole chat" })).toMatch(/unknown field messages/);
    expect(checkFeedbackRequest({ ...request, replyEmail: "a@b.c" })).toMatch(/unknown field replyEmail/);
    expect(checkFeedbackRequest({ ...request, words: "  " })).toBe("words");
    expect(checkFeedbackRequest({ ...request, words: "I typed this myself" })).toBe("words");
    expect(checkFeedbackRequest({ ...request, words: `${request.words} ` })).toBe("words");
    expect(checkFeedbackRequest({ ...request, words: "x".repeat(2001) })).toBe("words");
    expect(checkFeedbackRequest({ ...request, surface: "laptop" })).toBe("surface");
  });

  it("still scrubs secret shapes out of envelope text", () => {
    expect(scrubSecrets("Authorization: Bearer abcdefghijklmnop1234")).not.toContain("abcdefghijklmnop1234");
    expect(scrubSecrets("password: hunter2hunter2")).toBe(`password: ${REMOVED}`);
    expect(scrubSecrets("the token box was confusing")).toBe("the token box was confusing");
  });
});
