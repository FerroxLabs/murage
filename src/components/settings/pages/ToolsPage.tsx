// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 Tools page (A3, owner: sv10-tools). 21 rows in page order (src/lib/tools-page.ts). Two switches, in order:
// the app-wide one here (Web search, Read web pages), then the bot's own (the "Which bots" sheet). The Web search sheet
// holds the provider choice and, per engine, whether Murage's reader switch is enforced (generated from the routing table).
import { useRef, useState } from "react";
import { webSearchSwitch } from "../../../../shared/web-search-switch";
import { botsOffCount, readerRows, rowAppOn, TOOL_ROWS, type ToolRow } from "@/lib/tools-page";
import { tw } from "@/lib/tools-page-words";
import type { SettingsPageProps } from "@/lib/settings-page-contract";
import { fromAnswer } from "@/state/answer-tag";
import { api, useStore, type BotAnnouncement, type ConfigStatus } from "@/state/store";
import { SearchSettings } from "../../SearchSettings";
import { Card, Switch } from "../../SettingsPrimitives";

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title} data-tools-sheet className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onKeyDown={event => { if (event.key === "Escape") onClose(); }}>
      <div className="max-h-[85vh] w-full max-w-xl overflow-auto rounded-xl bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-[15px] font-medium text-ink">{title}</div>
          <button type="button" autoFocus onClick={onClose} className={`min-h-11 rounded-md px-3 text-[13px] ${focus}`}>{tw("settings.tools.sheetClose")}</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function WhichBots({ row, onError }: { row: ToolRow; onError: (message: string) => void }) {
  const { state, dispatch } = useStore();
  const [pending, setPending] = useState<Set<string>>(new Set());
  const tool = row.perBot;
  if (!tool) return null;
  const set = async (botId: string, off: boolean) => {
    setPending(previous => new Set(previous).add(botId));
    try {
      const saved = await api(`/api/bots/${botId}`, { method: "PATCH", body: JSON.stringify({ toolOff: { tool, off } }) });
      dispatch({ type: "botPatched", ...fromAnswer(saved.bot), bot: saved.bot as BotAnnouncement });
    } catch { onError(tw("settings.tools.saveError")); }
    finally { setPending(previous => { const next = new Set(previous); next.delete(botId); return next; }); }
  };
  return (
    <section aria-label={tw("settings.tools.whichBots")}>
      <div className="text-[13px] font-medium text-ink">{tw("settings.tools.whichBots")}</div>
      <p className="mb-2 text-[12.5px] text-ink-secondary">{tw("settings.tools.whichBotsNote")}</p>
      <ul className="flex flex-col gap-1">
        {state.bots.filter(bot => !bot.hidden).map(bot => (
          <li key={bot.id} className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-ink">{bot.name}</span>
            <Switch checked={bot.toolsOff?.includes(tool) !== true} disabled={pending.has(bot.id)} aria-label={bot.name}
              onClick={() => void set(bot.id, bot.toolsOff?.includes(tool) !== true)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReaderList() {
  return (
    <section aria-label={tw("settings.tools.readersTitle")} className="mt-4">
      <div className="text-[13px] font-medium text-ink">{tw("settings.tools.readersTitle")}</div>
      <ul data-reader-list className="mt-1 flex flex-col gap-1 text-[12.5px] text-ink-secondary">
        {readerRows().map(row => <li key={row.driver} data-reader={row.driver} data-enforced={row.enforced}>{row.enforced ? `${row.driver}: ${tw("settings.tools.readerEnforced")}` : `${row.driver}: ${row.limit}`}</li>)}
      </ul>
    </section>
  );
}

export default function ToolsPage(_props: SettingsPageProps) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState<ToolRow | null>(null);
  const [error, setError] = useState("");
  const [ask, setAsk] = useState<string | null>(null);
  const gate = useRef(false);
  const cfg = state.config;
  const known = TOOL_ROWS.filter(row => row.appSwitch);
  const on = known.filter(row => rowAppOn(row, cfg ?? undefined)).length;

  const save = async (patch: object) => {
    if (gate.current) return;
    gate.current = true; setError("");
    try {
      const config = await api("/api/config", { method: "PUT", body: JSON.stringify(patch) }) as ConfigStatus;
      dispatch({ type: "configStatus", config });
    } catch { setError(tw("settings.tools.saveError")); }
    finally { gate.current = false; }
  };
  const flip = (row: ToolRow, next: boolean) => {
    if (row.appSwitch === "webRead") return void save({ webRead: { enabled: next } });
    const patch = webSearchSwitch(cfg?.webSearch, next);
    if (patch.needsAsk) return setAsk(patch.provider);
    void save({ webSearch: { provider: patch.provider }, ...(patch.lastProvider ? { webSearchLast: patch.lastProvider } : {}) });
  };
  const sheetBody = (row: ToolRow) => (
    <>
      {row.id === "web-search" ? <><p className="mb-3 text-[12.5px] text-ink-secondary">{tw("settings.tools.searchOffNote")}</p><SearchSettings /><ReaderList /></> : null}
      {row.id === "web-read" ? <p className="mb-3 text-[12.5px] text-ink-secondary">{tw("settings.tools.readOffNote")}</p> : null}
      <WhichBots row={row} onError={setError} />
    </>
  );
  return (
    <div data-tools-page className="flex flex-col gap-3">
      <p role="status" className="text-[13px] text-ink-secondary">{tw("settings.tools.summary", { on, known: known.length })}</p>
      {error ? <p role="alert" className="text-[12.5px] text-danger">{error}</p> : null}
      {ask ? (
        <Card title={tw("settings.tools.askPaid", { provider: ask })}>
          <button type="button" className={`min-h-11 rounded-md px-3 text-[13px] ${focus}`} onClick={() => { const provider = ask; setAsk(null); void save({ webSearch: { provider } }); }}>{tw("settings.tools.askYes")}</button>
        </Card>
      ) : null}
      <ul className="flex flex-col gap-2">
        {TOOL_ROWS.map(row => {
          const appOn = rowAppOn(row, cfg ?? undefined);
          const off = botsOffCount(row, state.bots, cfg ?? undefined);
          return (
            <li key={row.id} data-tool-row={row.id} className="flex items-center justify-between gap-3 rounded-xl bg-card p-3">
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-ink">{tw(`settings.tools.row.${row.id}.title`)}</div>
                <div className="text-[12.5px] text-ink-secondary">{tw(`settings.tools.row.${row.id}.note`)}</div>
                {row.perBot ? <div className="text-[12px] text-ink-secondary">{off ? (off === 1 ? tw("settings.tools.botsOffOne") : tw("settings.tools.botsOff", { count: off })) : tw("settings.tools.botsOffNone")}</div> : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {appOn !== undefined ? <Switch checked={appOn} aria-label={tw(`settings.tools.row.${row.id}.title`)} onClick={() => flip(row, !appOn)} /> : null}
                {row.perBot ? (
                  <button type="button" className={`min-h-11 rounded-md px-3 text-[13px] underline ${focus}`} onClick={() => setOpen(row)}>{tw("settings.tools.open")}</button>
                ) : row.opensPage ? <span data-set-on={row.opensPage} className="text-[12.5px] text-ink-secondary">{tw("settings.tools.setOn", { page: tw(`settings.tools.page.${row.opensPage}`) })}</span>
                  : <span className="text-[12.5px] text-ink-secondary">{tw("settings.tools.always")}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      {open ? <Sheet title={tw(`settings.tools.row.${open.id}.title`)} onClose={() => setOpen(null)}>{sheetBody(open)}</Sheet> : null}
    </div>
  );
}
