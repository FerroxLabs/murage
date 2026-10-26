// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a press on a chat widget sends (QW Q4): the pure half of WidgetMessage, so the rules are testable without a DOM.
// A press collects the fields in its scope; a required field that is empty, or a field where Other is chosen with no
// words typed, stops it with one sentence and the field to focus. A field answered with Other sends "" for the field
// itself and the owner's words in `other`, by field name.
import { t } from "@/lib/i18n";
import {
  WIDGET_LIMITS, widgetFields, widgetScope, type WidgetActionEntry, type WidgetField, type WidgetOther, type WidgetRoot, type WidgetValues,
} from "../../../shared/widget";
import { clipOther, otherBlocksConfirm } from "../ChoiceWithOther";

export type PreparedPress =
  | { ok: true; values?: WidgetValues; other?: WidgetOther }
  | { ok: false; text: string; field: string; where: "data-widget-field" | "data-widget-other" };

/** Whether a field holds nothing yet (a field where Other is chosen counts by its words). */
export function widgetFieldEmpty(field: WidgetField, values: WidgetValues, other: WidgetOther): boolean {
  if (Object.hasOwn(other, field.name)) return !other[field.name]!.trim();
  const value = values[field.name];
  return field.type === "Checkbox" ? value !== true : typeof value !== "string" || !value.trim();
}

/** Check one press against what the owner has filled in, and build what to send. A cancel sends nothing. */
export function preparePress(root: WidgetRoot, entry: WidgetActionEntry, ref: string, values: WidgetValues, other: WidgetOther): PreparedPress {
  if (entry.tone === "cancel") return { ok: true };
  const scope = widgetFields(widgetScope(root, ref), root);
  const wording = scope.find((field) => otherBlocksConfirm(Object.hasOwn(other, field.name), other[field.name] ?? ""));
  if (wording) return { ok: false, text: t("widget.otherNeeded", { label: wording.label }), field: wording.name, where: "data-widget-other" };
  const empty = entry.tone ? scope.find((field) => field.node.required === true && widgetFieldEmpty(field, values, other)) : undefined;
  if (empty) return { ok: false, text: t("widget.required", { label: empty.label }), field: empty.name, where: "data-widget-field" };
  const typed = scope.filter((field) => Object.hasOwn(other, field.name) && other[field.name]!.trim());
  const sending: WidgetValues = Object.fromEntries(scope.map((field) => [field.name, Object.hasOwn(other, field.name) ? "" : values[field.name] ?? (field.type === "Checkbox" ? false : "")]));
  return {
    ok: true,
    values: sending,
    ...(typed.length ? { other: Object.fromEntries(typed.map((field) => [field.name, clipOther(other[field.name]!, WIDGET_LIMITS.fieldValue)])) } : {}),
  };
}

/** The edits a person's choices make, as pure steps over the two edit maps. */
export interface WidgetEdits { values: WidgetValues; other: WidgetOther }

export function editValue(edits: WidgetEdits, name: string, value: string | boolean): WidgetEdits {
  const { [name]: _dropped, ...rest } = edits.other;
  return { values: { ...edits.values, [name]: value }, other: rest };
}

export function editChooseOther(edits: WidgetEdits, name: string): WidgetEdits {
  return { values: { ...edits.values, [name]: "" }, other: { ...edits.other, [name]: edits.other[name] ?? "" } };
}

export function editOther(edits: WidgetEdits, name: string, text: string): WidgetEdits {
  return { values: edits.values, other: { ...edits.other, [name]: clipOther(text, WIDGET_LIMITS.fieldValue) } };
}
