// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: moved out of SettingsPanel.tsx verbatim (behaviour unchanged).
import { ChevronDown } from "lucide-react";
import { notebookLastWrittenLine } from "../../lib/notebook-last-written";
import { useState } from "react";
import { api, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { BotFreshStartAction } from "../BotFreshStartAction";
import { MemoryLauncher } from "../MemoryLauncher";
import { ContinuityBlock } from "../ContinuityBlock";
import { useBotSettingsDraft } from "../bot-settings-drafts";
import { notebookCanSave, notebookSaveBody } from "../notebook-save";
import { SettingsSection } from "./section";
import { inputCls } from "./field";
import type { BotPanelCtx } from "./context";

interface MemoryTopic {
  name: string;
  bytes: number;
}

const formatBytes = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`);

/** MEMORY.md + memory/ topic files, surfaced so the user can read and fix
 * what the bot believes. Fetched on expand, not on mount: settings opens for
 * every bot and most visits never look at memory — and an expand also
 * re-reads, so notes the bot wrote mid-session show up on the next open. */
function MemoryCard({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [lastWrittenAt, setLastWrittenAt] = useState<number | null>(null);
  // the notebook revision this editor loaded: a save sends it, so words written since (by the bot, or another window) are kept (U33)
  const [revision, setRevision] = useState<string | undefined>(undefined);
  const [topics, setTopics] = useState<MemoryTopic[]>([]);
  const [saving, setSaving] = useState(false);
  const [topic, setTopic] = useState<{ name: string; text: string } | null>(null);
  useBotSettingsDraft("Legacy notebook", dirty, saving);

  const load = async () => {
    setLoading(true);
    setError(null);
    setTopic(null);
    // no revision until this load answers: a failed load leaves Save off, so an edit can never be saved blind over the file (U33)
    setRevision(undefined);
    try {
      const result: { text: string; truncated: boolean; lastWrittenAt?: number | null; revision?: string; topics: MemoryTopic[] } = await api(
        `/api/bots/${bot.id}/memory`,
      );
      setText(result.text);
      setRevision(typeof result.revision === "string" ? result.revision : undefined);
      setTruncated(result.truncated);
      setLastWrittenAt(typeof result.lastWrittenAt === "number" ? result.lastWrittenAt : null);
      setTopics(result.topics);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (revision === undefined) return;
    setSaving(true);
    setError(null);
    try {
      const result: { truncated: boolean; lastWrittenAt?: number | null; revision?: string } = await api(`/api/bots/${bot.id}/memory`, {
        method: "PUT",
        body: JSON.stringify(notebookSaveBody(text, revision)),
      });
      setRevision(typeof result.revision === "string" ? result.revision : undefined);
      setTruncated(result.truncated);
      // the save is a write (Astra r1 #12)
      setLastWrittenAt(typeof result.lastWrittenAt === "number" ? result.lastWrittenAt : null);
      setDirty(false);
    } catch (e) {
      // the notebook was written after this editor opened: the newer words are kept and this edit stays here, unsaved
      if ((e as { status?: number } | null)?.status === 409) setError("This notebook was written after you opened it, so your edit was not saved over it. Your edit is still here: copy what you need, then close and reopen the notebook to see the newer version.");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const openTopic = async (name: string) => {
    setError(null);
    try {
      setTopic(await api(`/api/bots/${bot.id}/memory/topics/${encodeURIComponent(name)}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div id="bot-setting-notebook" data-setting="bot.memory.notebook" className="rounded-xl bg-card p-4">
      <button
        className="flex w-full items-center justify-between gap-4 text-left"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void load();
        }}
      >
        <div>
          <div className="text-[15px] font-medium text-ink">{t("settings.bot.notebook.title")}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {t("settings.bot.notebook.note")}
          </div>
        </div>
        <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
      </button>

      {open && loading && <div className="mt-3 text-[13px] text-ink-secondary">{t("settings.bot.notebook.loading")}</div>}

      {open && !loading && topic && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[12.5px] text-ink">memory/{topic.name}</span>
            <button
              onClick={() => setTopic(null)}
              className="shrink-0 rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
            >
              {t("settings.bot.notebook.back")}
            </button>
          </div>
          <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-lg border border-hairline/40 bg-inset p-3 font-mono text-[12.5px] leading-relaxed text-ink">
            {topic.text}
          </pre>
        </div>
      )}

      {open && !loading && !topic && (
        <div className="mt-3">
          <textarea
            className={cn(inputCls, "min-h-[160px] resize-y font-mono text-[12.5px] leading-relaxed")}
            value={text}
            placeholder={t("settings.bot.notebook.placeholder")}
            aria-label={t("settings.bot.notebook.label")}
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
          />
          {/* O5: a notebook nobody wrote for a week reads as stale, not as "remembers nothing". */}
          <div className="mt-1.5 text-[11.5px] text-ink-secondary">{notebookLastWrittenLine(lastWrittenAt, Date.now())}</div>
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={() => void save()}
              disabled={!notebookCanSave({ saving, dirty, revision })}
              className="rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            >
              {saving ? t("settings.bot.saving") : t("settings.bot.save")}
            </button>
            {truncated && (
              <span className="text-[11.5px] text-ink-secondary">
                {t("settings.bot.notebook.truncated")}
              </span>
            )}
          </div>
          {topics.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                {t("settings.bot.notebook.topics")}
              </div>
              <div className="overflow-hidden rounded-lg border border-hairline/40">
                {topics.map((entry) => (
                  <button
                    key={entry.name}
                    onClick={() => void openTopic(entry.name)}
                    className="flex w-full items-center justify-between gap-2 border-b border-hairline/40 px-3 py-2 text-left last:border-b-0 hover:bg-control/60"
                  >
                    <span className="truncate font-mono text-[12.5px] text-ink">{entry.name}</span>
                    <span className="shrink-0 text-[11.5px] text-ink-secondary">{formatBytes(entry.bytes)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

export function MemoryPart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section, desktop } = ctx;
  return (
    <>
          <SettingsSection id="memory" active={section}>
          {/* keyed so switching bots never shows one bot's notes under another's name */}
          <section id="bot-setting-memory" data-setting="bot.memory.memory" className="rounded-xl bg-card p-4">
            <h3 className="text-[15px] font-medium text-ink">{t("settings.bot.memory.title")}</h3>
            <p className="mt-1 text-[12px] text-ink-secondary">{t("settings.bot.memory.note")}</p>
            <MemoryLauncher key={`memory-${bot.id}`} botId={bot.id} botName={bot.name} />
          </section>
          {desktop === true && <ContinuityBlock key={`continuity-${bot.id}`} bot={bot} />}
          <MemoryCard key={bot.id} bot={bot} />
          <BotFreshStartAction bot={bot} active={section === undefined || section === "memory"} />
          </SettingsSection>
    </>
  );
}
