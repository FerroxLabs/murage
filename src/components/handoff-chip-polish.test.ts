// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { expect, it } from "vitest";

const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
const start = source.indexOf("function ActivityChip(");
const component = source.slice(start, source.indexOf("// The exact frame already", start));
const code = ts.transpileModule(component, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText;
const icon = () => React.createElement("span");
const cn = (...classes: unknown[]) => classes.filter(Boolean).join(" ");

it.each([true, false])("a failed hand-off is red in the open and blocked branches (blocked=%s)", blocked => {
  const deps = { React, useStoreActions: () => ({ dispatch() {} }), useStoreSelector: () => ({ groupVisible: true }), useMemo: (fn: Function) => fn(), activitySelector: () => ({}), commChipAction: () => blocked ? "blocked" : "open", isPhoneClient: () => blocked, cn, CHIP: "chip", CHIP_NAME: "name", CommAvatar: icon, ChevronRight: icon, X: icon };
  const Chip = new Function(...Object.keys(deps), code + "return ActivityChip;")(...Object.values(deps));
  const render = (ok: boolean | undefined) => renderToStaticMarkup(React.createElement(Chip, { botName: "Lead", message: { tool: { name: "Partner could not finish", ok }, comm: { groupId: "room", withBotId: "peer", withName: "Partner" } } }));
  expect(render(false)).toContain("text-danger");
  expect(render(true)).not.toContain("text-danger");
  expect(render(undefined)).not.toContain("text-danger");
});
