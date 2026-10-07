// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";
import type { ProjectInboxRow } from "../../shared/inbox";
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (value: unknown) => [value, () => {}] }));
vi.mock("@/state/store", () => ({ api: vi.fn() }));
import ProjectInboxRows from "./ProjectInboxRows";
function nodes(node: unknown): ReactElement<Record<string, any>>[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  const element = node as ReactElement<Record<string, any>>;
  return [element, ...nodes(element.props?.children)];
}
it.each(["folderTrust", "routineRequest", "skillRequest", "intake", "other"])("F15 %s decisions link to the original message", kind => {
  const onOpen = vi.fn();
  const card = { title: "Review", options: [], requestId: kind === "other" ? undefined : "ask", [kind]: {} };
  const row = { groupId: "g", sentence: "One thing needs your OK", approvals: [{ requestId: "ask", threadId: "thread", messageId: "message", summary: "Review", card }], goals: [], deadWaitCards: [] } as unknown as ProjectInboxRow;
  const tree = nodes(ProjectInboxRows({ rows: [row], onSettled: vi.fn(), onOpen }));
  const open = tree.find(n => n.type === "button" && n.props.children === "Open");
  expect(open).toBeDefined(); open!.props.onClick();
  expect(onOpen).toHaveBeenCalledWith({ threadId: "thread", messageId: "message" });
});
