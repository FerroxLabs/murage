import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { linkedPersonChoices, MemoryPeople, personShareRows, shareAudienceLabel, verifiedAccountLabel, type HumanBinding, type ShareableAudience } from "./MemoryPeople";

const owner = "workspace-owner";
const bindings: HumanBinding[] = [
  { id: "telegram-a", origin: { platform: "telegram", connectionId: "connection-a", authorityId: "authority-a", userId: "123" }, personId: null, revision: 1, active: true, state: "link-required" },
  { id: "discord-b", origin: { platform: "discord", connectionId: "connection-b", authorityId: "authority-b", userId: "456" }, personId: "person-b", revision: 3, active: true, state: "linked" },
];
const audiences: ShareableAudience[] = [
  { id: "room-1", kind: "room", label: "Launch room" },
  { id: "team-1", kind: "team", label: "General" },
  { id: "bot-1", kind: "bot", label: "Private bot" },
  { id: "preferences-owner", kind: "preferences", label: "person:workspace-owner" },
];

describe("verified people controls", () => {
  it("uses verified origin identifiers and never a display name as account proof", () => {
    expect(verifiedAccountLabel(bindings[0].origin)).toBe("Telegram account · user ID 123 · authority authority-a");
    const html = renderToStaticMarkup(createElement(MemoryPeople, { people: { ownerPersonId: owner, bindings }, disabled: false, onLink: async () => {}, onRefresh: async () => {} }));
    expect(html).toContain("user ID 123"); expect(html).toContain("authority authority-a");
    expect(html).toContain("This is my account"); expect(html).toContain("Separate person"); expect(html).toContain("Same person as"); expect(html).toContain("Unlink");
    expect(html).toContain("display name as proof");
  });
  it("only offers another active non-owner verified account for an explicit same-person link", () => {
    expect(linkedPersonChoices(bindings, owner, "telegram-a")).toEqual([{ personId: "person-b", label: "Discord account · user ID 456 · authority authority-b" }]);
    expect(linkedPersonChoices([{ ...bindings[0], active: false }, bindings[1], { ...bindings[1], id: "discord-c" }], owner, "telegram-a")).toEqual([{ personId: "person-b", label: "Discord account · user ID 456 · authority authority-b" }]);
  });
  it("offers only group audiences to separate people and marks grants from server read-back alone", () => {
    const people = { ownerPersonId: owner, bindings: [...bindings, { ...bindings[1], id: "slack-b", origin: { ...bindings[1].origin, platform: "slack" as const, userId: "U456" } }, { ...bindings[1], id: "owner-c", personId: owner }, { ...bindings[1], id: "gone-d", personId: "person-d", active: false }],
      shares: [{ personId: "person-b", scopeId: "room-1", granted: true, revision: 1 }, { personId: "person-b", scopeId: "team-1", granted: false, revision: 2 }, { personId: "person-b", scopeId: "missing", granted: true, revision: 1 }] };
    const rows = personShareRows(people, audiences);
    expect(rows.map(row => row.personId)).toEqual(["person-b"]);
    expect(rows[0].label).toBe("Discord account · user ID 456 · authority authority-b and Slack account · user ID U456 · authority authority-b");
    expect(rows[0].granted.map(audience => audience.id)).toEqual(["room-1", "missing"]);
    expect(shareAudienceLabel(rows[0].granted[1])).toBe("Audience: Unavailable audience");
    expect(rows[0].available.map(audience => audience.id)).toEqual(["team-1"]);
    expect(shareAudienceLabel(audiences[0])).toBe("Room: Launch room");
  });
  it("shows share controls only when the server reports current shares", () => {
    const base = { disabled: false, audiences, onLink: async () => {}, onShare: async () => {}, onRefresh: async () => {} };
    expect(renderToStaticMarkup(createElement(MemoryPeople, { ...base, people: { ownerPersonId: owner, bindings } }))).not.toContain("Shared audiences");
    const html = renderToStaticMarkup(createElement(MemoryPeople, { ...base, people: { ownerPersonId: owner, bindings, shares: [{ personId: "person-b", scopeId: "room-1", granted: true, revision: 1 }] } }));
    expect(html).toContain("Shared audiences for Discord account"); expect(html).toContain("Room: Launch room"); expect(html).toContain("Stop sharing");
    expect(html).toContain("Share audience"); expect(html).toContain("Team: General"); expect(html).not.toContain("Private bot"); expect(html).not.toContain("person:workspace-owner");
    const none = renderToStaticMarkup(createElement(MemoryPeople, { ...base, people: { ownerPersonId: owner, bindings, shares: [] } }));
    expect(none).toContain("recalls only their own conversations and preferences");
  });
});
