// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// D11: "clicking a bot's name does not toggle it; only the round check does".
// Every member list (New team, Manage members and lead) makes the WHOLE row
// one checkbox control, so the name, the avatar, the second line and the
// check all sit inside the element that toggles.
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Bot } from "@/state/store";
import { BotPickerList } from "./BotPickerList";
import { TeamSettingsDialogBody, type TeamSettingsDialogBodyProps } from "./TeamSettingsDialog";

const bot = (id: string, name: string, extra: Partial<Bot> = {}) =>
  ({ id, name, color: "green", modelSelection: { instanceId: "x", model: "m" }, messages: [], ...extra }) as unknown as Bot;

type Props = Record<string, unknown> & { children?: ReactNode };
/** Collect every host element's props. Nested components (the avatar, the
 *  check icon) are left closed: they hold no control of their own. */
function hostElements(node: ReactNode, found: Array<{ type: string; props: Props }> = []): Array<{ type: string; props: Props }> {
  if (Array.isArray(node)) { for (const child of node) hostElements(child, found); return found; }
  if (!isValidElement(node)) return found;
  const props = node.props as Props;
  if (typeof node.type !== "string") return found;
  if (typeof node.type === "string") found.push({ type: node.type, props });
  hostElements(props.children, found);
  return found;
}
const textOf = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!isValidElement(node)) return "";
  const props = node.props as Props;
  if (typeof node.type !== "string") return "";
  return textOf(props.children);
};

function rowsOf(tree: ReactNode) {
  return hostElements(tree).filter((element) => element.props.role === "checkbox");
}

describe("bot member rows toggle from anywhere on the row", () => {
  it("New team: the name is inside the one button that toggles, and it is a real button", () => {
    const toggled: string[] = [];
    const tree = BotPickerList({ bots: [bot("miso", "Miso"), bot("poppy", "Poppy")], picked: new Set(["poppy"]), onToggle: (id) => toggled.push(id), emptyHint: "none", detail: (b) => (b.id === "miso" ? "In Ops now" : undefined) });
    const rows = rowsOf(tree);
    expect(rows.map((row) => row.type)).toEqual(["button", "button"]);
    expect(rows.map((row) => textOf(row.props.children as ReactNode))).toEqual(["MisoIn Ops now", "Poppy"]);
    expect(rows.map((row) => row.props["aria-checked"])).toEqual([false, true]);
    for (const row of rows) {
      expect(row.props.type).toBe("button");
      expect(String(row.props.className)).toMatch(/min-h-11/);
      expect(String(row.props.className)).toMatch(/focus-visible:outline/);
      (row.props.onClick as () => void)();
    }
    expect(toggled).toEqual(["miso", "poppy"]);
    // No inner control could swallow a click on the name.
    const html = renderToStaticMarkup(createElement(BotPickerList, { bots: [bot("miso", "Miso")], picked: new Set<string>(), onToggle: () => {}, emptyHint: "none" }));
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toMatch(/<input|<label/);
  });

  it("Manage members and lead: the same, one control per bot with the name inside it", () => {
    const toggled: string[] = [];
    const props = {
      team: { name: "Crew", revision: "r".repeat(64), leadId: "miso", members: [{ id: "miso", name: "Miso", lead: true, chief: false, archived: false }], channels: [], hasInstructions: false },
      candidates: [bot("miso", "Miso", { section: "Crew" }), bot("poppy", "Poppy")], existing: ["Crew"], canLead: () => true,
      name: "Crew", picked: new Set(["miso"]), lead: "miso", confirmingDelete: false, deleteChoice: "keep", busy: false, status: null,
      onName: () => {}, onSaveName: () => {}, onToggle: (id: string) => toggled.push(id), onLead: () => {}, onSaveMembers: () => {},
      onAskDelete: () => {}, onDeleteChoice: () => {}, onConfirmDelete: () => {}, onCancelDelete: () => {}, onClose: () => {},
    } as unknown as TeamSettingsDialogBodyProps;
    const rows = rowsOf(TeamSettingsDialogBody(props) as ReactNode);
    expect(rows.map((row) => row.type)).toEqual(["button", "button"]);
    expect(rows.map((row) => textOf(row.props.children as ReactNode))).toEqual(["Miso", "Poppy"]);
    for (const row of rows) { expect(row.props.type).toBe("button"); (row.props.onClick as () => void)(); }
    expect(toggled).toEqual(["miso", "poppy"]);
  });
});
