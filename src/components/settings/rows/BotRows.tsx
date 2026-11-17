import { NoLimitsFollowers } from "../../NoLimitsFollowers";
import { effortLabel } from "@/lib/effort-label";
import { useState, } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { Card, Switch } from "../../SettingsPrimitives";
import { useShowToolCalls } from "../../SettingsSearchResults";
// Settings' own words, on this chunk rather than the first paint (1.0.19, SettingsCopy.lazy.test.ts).
import "@/lib/settings-copy";



const NEW_BOT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Effort for new bots (triage row 23): applied only where the new bot's
 *  engine offers that level; an explicit choice on the bot wins. */
export function NewBotEffortRow() {
  const { state, dispatch } = useStore();
  const [error, setError] = useState("");
  const current = state.config?.newBots?.effort ?? "";
  const change = async (value: string) => {
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ newBots: { effort: value || null } }) });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the effort for new bots.");
    }
  };
  return (
    <><NoLimitsFollowers /><Card title="New bots" subtitle="The effort a new bot starts with, when its engine offers that level. You can change it on any bot later.">
      <label className="flex items-center justify-between gap-4 text-[14px] text-ink">
        Effort for new bots
        <select data-setting-control="new-bot-effort-heading" value={current} onChange={(event) => void change(event.target.value)} className="rounded-md bg-inset px-2 py-1.5 text-[13px] text-ink">
          <option value="">Engine default</option>
          {NEW_BOT_EFFORTS.map((level) => <option key={level} value={level}>{effortLabel(level)}</option>)}
        </select>
      </label>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card></>
  );
}

export function ToolCallsRow() {
  const { enabled, saving, error, toggle } = useShowToolCalls();

  return (
    <Card
      title="Tool calls"
      subtitle="Show each tool a bot runs in the transcript. Off by default; the mascot already shows that work is happening."
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">Show tool calls</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            Named chips for Bash, search, and other tools. Errors and bot-to-bot messages still appear.
          </div>
        </div>
        <Switch
          checked={enabled}
          data-setting-control="tool-calls-heading" aria-label="Show tool calls in chat"
          disabled={saving}
          onClick={() => void toggle()}
          className="disabled:cursor-wait disabled:opacity-50"
        />
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}

