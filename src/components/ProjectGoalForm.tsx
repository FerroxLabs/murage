// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { useState } from "react";
import type { ProjectGoal } from "@/lib/project-client";
import { goalFormBody, type GoalForm } from "@/lib/project-goal-view";
import { projectClient } from "@/lib/use-project";
import { BOARD_BUTTON, BOARD_INPUT } from "./ProjectBoardDialog";
export function ProjectGoalForm({ groupId, goal, onSaved, onCancel, onFailure }: { groupId: string; goal?: ProjectGoal; onSaved: () => Promise<void>; onCancel?: () => void; onFailure: (reason: string, changed: boolean) => void }) {
  // Hold the revision with the edited values; SSE must not bless a stale form.
  const [base] = useState(goal);
  const [form, setForm] = useState<GoalForm>(() => ({ title: goal?.title ?? "", description: goal?.description ?? "", criteria: goal?.criteria?.map(c => ({ id: c.id, text: c.text })) ?? [{ text: "" }], planFirst: false, review: true, deadline: "" }));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function submit() {
    if (busy) return;
    // The optional initial empty criterion is equivalent to no criteria.
    const fields = { ...form, criteria: form.criteria.length === 1 && !form.criteria[0].text.trim() && !form.criteria[0].id ? [] : form.criteria };
    const body = base ? goalFormBody(fields, base) : goalFormBody(fields);
    if ("error" in body) { setError(body.error); return; }
    setBusy(true); setError("");
    const result = "expectedRevision" in body && base ? await projectClient.goal(groupId, base.id, body) : await projectClient.createGoal(groupId, body as import("@/lib/project-client").ProjectGoalCreate);
    if (result.ok) await onSaved();
    else { const changed = result.body?.error === "changed"; setError(changed ? t("projects.common.goalChanged") : result.reason); onFailure(result.reason, changed); }
    setBusy(false);
  }
  return <form aria-label={base ? t("projects.goalForm.edit") : t("projects.goalForm.set")} className="space-y-3" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <label className="block text-sm">{t("projects.goalForm.title")}<input required maxLength={200} className={BOARD_INPUT} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></label>
    <label className="block text-sm">{t("projects.common.description")}<textarea maxLength={2000} rows={3} className={BOARD_INPUT} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
    <fieldset className="space-y-2"><legend className="text-sm font-medium">{t("projects.goalForm.criteria")}</legend>{form.criteria.map((criterion, index) => <div key={criterion.id ?? index} className="flex items-end gap-2"><label className="min-w-0 flex-1 text-sm">{t("projects.goalForm.criterion",{number:index + 1})}<input maxLength={300} className={BOARD_INPUT} value={criterion.text} onChange={e => setForm({ ...form, criteria: form.criteria.map((c, i) => i === index ? { ...c, text: e.target.value } : c) })} /></label><button type="button" className={BOARD_BUTTON} aria-label={t("projects.goalForm.removeCriterion",{number:index + 1})} onClick={() => setForm({ ...form, criteria: form.criteria.filter((_, i) => i !== index) })}>{t("projects.goalForm.remove")}</button></div>)}<button type="button" className={BOARD_BUTTON} disabled={form.criteria.length >= 10} onClick={() => setForm({ ...form, criteria: [...form.criteria, { text: "" }] })}>{t("projects.goalForm.addCriterion")}</button></fieldset>
    {!base && <><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={form.planFirst} onChange={e => setForm({ ...form, planFirst: e.target.checked })} />{t("projects.goalForm.planFirst")}</label><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={form.review} onChange={e => setForm({ ...form, review: e.target.checked })} />{t("projects.goalForm.review")}</label><label className="block text-sm">{t("projects.common.deadlineOptional")}<input type="date" className={BOARD_INPUT} value={form.deadline} onChange={e => setForm({ ...form, deadline: e.target.value })} /></label></>}
    {error && <p role="alert" className="text-sm">{error}</p>}<div className="flex gap-2"><button disabled={busy} className={BOARD_BUTTON}>{base ? t("projects.goalForm.save") : t("projects.goalForm.set")}</button>{onCancel && <button type="button" className={BOARD_BUTTON} onClick={onCancel}>{t("projects.common.cancel")}</button>}</div>
  </form>;
}
