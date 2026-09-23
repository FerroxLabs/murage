import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics", () => ({ track: () => {}, analyticsEnabled: () => false }));
// The store's import graph reads `window` at module scope; this suite runs in node.
(globalThis as unknown as { window?: unknown }).window ??= {};
const { NewTeamDialogBody, newTeamBotDetail } = await import("./NewTeamDialog");
const { SidebarCreateMenu } = await import("./Sidebar");
import type { Bot } from "@/state/store";

const bot = (id: string, extra: Partial<Bot> = {}): Bot =>
  ({ id, name: id[0].toUpperCase() + id.slice(1), messages: [], modelSelection: { instanceId: "i" }, ...extra }) as unknown as Bot;
const moss = bot("moss");
const rex = bot("rex", { section: "Operations" });
const kessler = bot("kessler", { section: "Operations", chiefOfStaff: true });

const text = (html: string) => html.replace(/<[^>]+>/g, "\n").split("\n").map((s) => s.trim()).filter(Boolean);

function body(overrides: Partial<Parameters<typeof NewTeamDialogBody>[0]> = {}) {
  return renderToStaticMarkup(createElement(NewTeamDialogBody, {
    bots: [moss, rex, kessler],
    existing: ["Operations"],
    canLead: () => true,
    draft: { name: "", picked: new Set<string>(), lead: undefined, instructions: "" },
    busy: false,
    error: null,
    onName: vi.fn(), onToggle: vi.fn(), onLead: vi.fn(), onInstructions: vi.fn(), onCreate: vi.fn(), onClose: vi.fn(),
    ...overrides,
  }));
}

describe("the + menu", () => {
  const menu = (archivedCount: number) => renderToStaticMarkup(createElement(SidebarCreateMenu, {
    archivedCount, onNewBot: vi.fn(), onNewTeam: vi.fn(), onNewChannel: vi.fn(), onNewProject: vi.fn(), onExport: vi.fn(), onArchived: vi.fn(),
  }));

  it("names each thing it makes, in order, with the rest below a line", () => {
    const html = menu(3);
    // "New Project" sits next to "New Channel", because a project IS a
    // channel with a purpose and the two are chosen in the same breath.
    expect(text(html)).toEqual(["New Bot", "New Team", "New Channel", "A chat with some bots.",
      "New Project", "A piece of work with its own goal, files and chat.", "Export bots…", "Archived bots", "3"]);
    expect(html.indexOf("New Project")).toBeLessThan(html.indexOf('role="separator"'));
    expect(html.indexOf('role="separator"')).toBeLessThan(html.indexOf("Export bots…"));
  });

  it("shows Archived bots only when there are some", () => {
    expect(text(menu(0))).toEqual(["New Bot", "New Team", "New Channel", "A chat with some bots.",
      "New Project", "A piece of work with its own goal, files and chat.", "Export bots…"]);
  });
});

describe("the New Team dialog", () => {
  it("starts with a name field and the bots, and says why it cannot create yet", () => {
    const html = body();
    expect(html).toContain('aria-label="Team name"');
    expect(html).toContain("Bots in this team");
    expect(html).not.toContain('aria-label="Team lead"');
    expect(html).toContain("Give the team a name.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Create Team<\/button>/);
  });

  it("refuses a name that is already a team", () => {
    expect(body({ draft: { name: "operations", picked: new Set(["moss"]), lead: undefined, instructions: "" } })).toContain(
      "There is already a team called Operations.",
    );
  });

  it("names where a chosen bot is now and that it moves", () => {
    expect(newTeamBotDetail(rex, false)).toBe("Now in Operations");
    expect(newTeamBotDetail(rex, true)).toBe("Now in Operations. Moves to this team.");
    expect(newTeamBotDetail(kessler, true)).toBe("Leads Operations. Moves to this team.");
    expect(newTeamBotDetail(moss, true)).toBeUndefined();
    expect(body({ draft: { name: "Research", picked: new Set(["rex"]), lead: undefined, instructions: "" } })).toContain("Now in Operations. Moves to this team.");
  });

  it("offers a lead among the chosen bots and explains one that cannot lead", () => {
    const html = body({
      canLead: (b) => b.id !== "moss",
      draft: { name: "Research", picked: new Set(["moss", "rex"]), lead: undefined, instructions: "" },
    });
    expect(html).toContain('aria-label="Team lead"');
    expect(html).toContain('<option value="moss" disabled="">Moss (can&#x27;t lead yet)</option>');
    expect(html).toContain('<option value="rex">Rex</option>');
    expect(html).toContain("Moss can&#x27;t lead yet. Choose an engine with Murage delegation support first.");
    expect(html).toMatch(/<button[^>]*>Create Team · 2 bots<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Create Team · 2 bots/);
  });

  it("defaults the lead to a chosen bot that already leads", () => {
    const html = body({ draft: { name: "Research", picked: new Set(["kessler", "moss"]), lead: undefined, instructions: "" } });
    expect(html).toMatch(/<option value="kessler" selected="">Kessler<\/option>/);
  });

  it("shows a failure from the harness in place of the hint", () => {
    const html = body({ error: "A team can have only one lead.", draft: { name: "Research", picked: new Set(["moss"]), lead: undefined, instructions: "" } });
    expect(html).toMatch(/text-danger[^>]*>A team can have only one lead\.</);
  });
});
