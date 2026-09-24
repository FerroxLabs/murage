// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "What shapes <bot>": everything that goes into a bot's instructions, in
// the order the model reads it (GET /api/bots/:id/shapes, server/bot-shapes.ts).
// Only the owner's own choices switch: House Rules, the team brief, the Chief
// of Staff guide and each skill, each through the route that already owns it.
// Murage's own rules show a lock. "Show exactly what it read" is the last
// turn's whole system text, word for word.
import { useCallback, useEffect, useId, useState } from "react";
import { Lock } from "lucide-react";

import { api, useStore } from "@/state/store";
import { CHIEF_GUIDE_REF, setSkillForBot } from "@/lib/skills-api";
import { Switch } from "./SettingsPrimitives";
import { SectionContextDialog } from "./SectionContextDialog";
import { useBotSettingsNavigation } from "./bot-settings-drafts";

export type ShapeGroup = "rules" | "identity" | "tools" | "turn";
export type ShapeEditor = "houseRules" | "identity" | "memory" | "skills" | "teamBrief";
export interface ShapeRow {
  id: string;
  group: ShapeGroup;
  label: string;
  what: string;
  /** null: decided when a message arrives. */
  text: string | null;
  switchable: boolean;
  locked: boolean;
  on?: boolean;
  editor?: ShapeEditor;
  skillName?: string;
}
export interface ShapesView {
  botId: string;
  botName: string;
  team: { section: string; label: string };
  rows: ShapeRow[];
  lastTurn: { at: number; where: "chat" | "room"; text: string } | null;
}

export const SHAPE_GROUPS: ReadonlyArray<{ id: ShapeGroup; title: string }> = [
  { id: "rules", title: "Your rules" },
  { id: "identity", title: "Who it is" },
  { id: "tools", title: "What it can use" },
  { id: "turn", title: "This turn" },
];
const EDIT_LABEL: Record<ShapeEditor, string> = {
  houseRules: "Edit in Settings",
  identity: "Edit",
  memory: "Edit",
  teamBrief: "Edit",
  skills: "Open in Skills",
};

export interface BotShapesViewProps {
  view: ShapesView;
  busy: string | null;
  error: string;
  onToggle(row: ShapeRow): void;
  onEdit(row: ShapeRow): void;
}

export function BotShapesView({ view, busy, error, onToggle, onEdit }: BotShapesViewProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);
  const base = useId();
  const name = view.botName;
  return (
    <div className="space-y-4">
      <section className="rounded-xl bg-card p-4">
        <p className="text-[13px] leading-relaxed text-ink-secondary">
          Everything that goes into {name}'s instructions. Each group lists its parts in the order {name} reads them.
          Switch off what you don't want. Rows with a lock are Murage's own rules and always apply.
        </p>
        <button
          type="button"
          aria-expanded={showAll}
          aria-controls={`${base}-all`}
          onClick={() => setShowAll(!showAll)}
          className="mt-3 min-h-9 rounded-lg bg-control px-3 text-[13px] font-medium text-ink hover:bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
        >
          {showAll ? "Hide what it read" : "Show exactly what it read"}
        </button>
        {showAll && (
          <div id={`${base}-all`} className="mt-3">
            {view.lastTurn ? (
              <>
                <p className="text-[12px] text-ink-secondary">
                  From its last reply {view.lastTurn.where === "room" ? "in a room" : "in its chat"}, {new Date(view.lastTurn.at).toLocaleString()}. Word for word.
                </p>
                <pre aria-label={`Everything ${name} read on its last reply`} className="mt-2 max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset p-3 text-[12px] leading-relaxed text-ink">{view.lastTurn.text}</pre>
              </>
            ) : (
              <p className="text-[12px] text-ink-secondary">{name} hasn't replied yet. Send it a message, then look here.</p>
            )}
          </div>
        )}
      </section>
      {error && <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
      {SHAPE_GROUPS.map((group) => {
        const rows = view.rows.filter((row) => row.group === group.id);
        if (!rows.length) return null;
        return (
          <section key={group.id} aria-labelledby={`${base}-${group.id}`} className="rounded-xl bg-card p-4">
            <h3 id={`${base}-${group.id}`} className="text-[15px] font-medium text-ink">{group.title}</h3>
            <ul className="mt-2 divide-y divide-hairline/40">
              {rows.map((row) => {
                const expanded = open[row.id] === true;
                const textId = `${base}-${row.id}`;
                return (
                  <li key={row.id} className="py-3" data-shape-row={row.id}>
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2">
                          <h4 className="text-[13px] font-medium text-ink">{row.label}</h4>
                          {row.locked && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-ink-secondary" title="Murage's own rule. Always on.">
                              <Lock size={12} aria-hidden="true" />
                              <span>Always on</span>
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{row.what}</p>
                        {row.switchable && row.on === false && <p className="mt-0.5 text-[12px] text-ink-secondary">Off. {name} doesn't read this now.</p>}
                        <div className="-ml-1 mt-1 flex flex-wrap gap-1">
                          <button type="button" aria-expanded={expanded} aria-controls={textId} onClick={() => setOpen({ ...open, [row.id]: !expanded })} className="rounded px-1 py-0.5 text-[12px] text-accent-text hover:bg-control">
                            {expanded ? "Hide" : "View"}<span className="sr-only"> {row.label}</span>
                          </button>
                          {row.editor && (
                            <button type="button" onClick={() => onEdit(row)} className="rounded px-1 py-0.5 text-[12px] text-accent-text hover:bg-control">
                              {EDIT_LABEL[row.editor]}<span className="sr-only"> {row.label}</span>
                            </button>
                          )}
                        </div>
                      </div>
                      {row.switchable && (
                        <Switch checked={row.on === true} aria-label={`Use ${row.label}`} disabled={busy !== null} onClick={() => onToggle(row)} />
                      )}
                    </div>
                    {expanded && (
                      <div id={textId} className="mt-2">
                        {row.text === null ? (
                          <p className="text-[12px] text-ink-secondary">Decided when a message arrives.</p>
                        ) : row.text.trim() ? (
                          <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset p-3 text-[12px] leading-relaxed text-ink">{row.text.trim()}</pre>
                        ) : (
                          <p className="text-[12px] text-ink-secondary">Empty right now.</p>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** A refusal's plain message, and whether it was a skill that needs a look. */
function refusal(cause: unknown, fallback: string): string {
  const body = (cause as { body?: { code?: string } } | undefined)?.body;
  if (body?.code === "needs-review") return "This skill needs a look before it can be switched on. Open it in Skills to read it first.";
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export function BotShapesPanel({ bot, active = true }: { bot: { id: string; name: string; busy?: boolean }; active?: boolean }) {
  const { dispatch } = useStore();
  const navigate = useBotSettingsNavigation();
  const [view, setView] = useState<ShapesView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [editingBrief, setEditingBrief] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await api(`/api/bots/${encodeURIComponent(bot.id)}/shapes`));
      setError("");
    } catch (cause) {
      setError(refusal(cause, "This couldn't be loaded. Try again."));
    }
  }, [bot.id]);
  // Read again whenever it is shown and after each reply, so the last turn is the last turn.
  useEffect(() => { if (active) void load(); }, [active, load, bot.busy]);

  const toggle = async (row: ShapeRow) => {
    const on = row.on !== true;
    setBusy(row.id);
    setError("");
    try {
      if (row.id === "house-rules") await api("/api/house-rules", { method: "PUT", body: JSON.stringify({ enabled: on }) });
      else if (row.id === "team-brief") await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: "PATCH", body: JSON.stringify({ teamBrief: on }) });
      else if (row.id === "chief-guide") await setSkillForBot(CHIEF_GUIDE_REF, bot.id, on);
      else if (row.skillName) await api(`/api/bots/${encodeURIComponent(bot.id)}/skills/${encodeURIComponent(row.skillName)}`, { method: "PATCH", body: JSON.stringify({ enabled: on }) });
      await load();
    } catch (cause) {
      setError(refusal(cause, `${row.label} didn't change. Try again.`));
    } finally {
      setBusy(null);
    }
  };
  const edit = (row: ShapeRow) => {
    if (row.editor === "houseRules") navigate(() => dispatch({ type: "toggleAppSettings", open: true, section: "houseRules" }));
    else if (row.editor === "teamBrief") setEditingBrief(true);
    else if (row.editor === "identity" || row.editor === "memory") dispatch({ type: "toggleSettings", open: true, intent: { section: row.editor } });
    else if (row.editor === "skills") dispatch({ type: "toggleSettings", open: true, intent: { section: "skills", addSkill: false } });
  };

  if (!view) {
    return error
      ? <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>
      : <p className="text-[13px] text-ink-secondary">Loading…</p>;
  }
  return (
    <>
      <BotShapesView view={view} busy={busy} error={error} onToggle={(row) => void toggle(row)} onEdit={edit} />
      {editingBrief && <SectionContextDialog section={view.team.section} label={view.team.label} onClose={() => { setEditingBrief(false); void load(); }} />}
    </>
  );
}
