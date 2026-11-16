// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Also use my Claude Code setup (CONTRACTS-B 1): a one-time copy of your Claude Code skills and tools into Murage, on your
// press. The switch only shows Review and Import; it reads nothing. Review lists names only; Import is refused until you
// have reviewed. Skills and tools arrive off; a tool that needed a key arrives without it and says so.
import { useState } from "react";
import { sw } from "@/lib/settings-words";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { Card, Switch } from "./SettingsPrimitives";

type Scope = "both" | "skills" | "mcp";
interface Review {
  dryRunId: string;
  skills: Array<{ name: string }>;
  servers: Array<{ name: string; kind: "local" | "remote"; needsKey: boolean }>;
  skipped: string[];
}
interface Receipt { skills: number; servers: number; needsKey: number; skipped: string[] }

const button = "min-h-11 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50";
const primary = "min-h-11 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50";

export function claudeCodeImportErrorKey(error: unknown): string {
  const body = error && typeof error === "object" && "body" in error ? error.body : undefined;
  const code = body && typeof body === "object" && "code" in body ? body.code : undefined;
  if (code === "review-required") return "settings.claudeCode.reviewRequired";
  if (code === "partly-undone") return "settings.claudeCode.partlyUndone";
  if (code === "source-linked") return "settings.claudeCode.linkedFiles";
  // A lost response can follow a successful commit: never promise that nothing changed.
  return "settings.claudeCode.importFailed";
}

export function ClaudeCodeImportCard() {
  const { state, dispatch } = useStore();
  const status = state.config?.claudeCodeImport;
  const enabled = status?.enabled === true;
  const [scope, setScope] = useState<Scope>("both");
  const [review, setReview] = useState<Review | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reset = () => { setReview(null); setReceipt(null); setError(""); };
  const refreshConfig = async () => {
    const config: ConfigStatus = await api("/api/config");
    dispatch({ type: "configStatus", config });
  };
  const toggle = async () => {
    setBusy(true);
    reset();
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ claudeCodeImport: { enabled: !enabled } }) });
      dispatch({ type: "configStatus", config });
    } catch {
      setError(sw("settings.claudeCode.error"));
    } finally {
      setBusy(false);
    }
  };
  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError("");
    setReceipt(null);
    try {
      if (dryRun) {
        setReview(await api("/api/claude-code-import", { method: "POST", body: JSON.stringify({ scope, dryRun: true }) }));
      } else if (review) {
        setReceipt(await api("/api/claude-code-import", { method: "POST", body: JSON.stringify({ scope, dryRun: false, dryRunId: review.dryRunId }) }));
        setReview(null);
        await refreshConfig();
      }
    } catch (cause) {
      setError(sw(claudeCodeImportErrorKey(cause)));
      setReview(null);
    } finally {
      setBusy(false);
    }
  };

  const nothingNew = review !== null && review.skills.length === 0 && review.servers.length === 0;
  return (
    <Card title={sw("settings.claudeCode.title")} subtitle={sw("settings.claudeCode.note")}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 text-[14px] font-medium text-ink">{sw("settings.claudeCode.switch")}</div>
          <Switch checked={enabled} disabled={busy} aria-label={sw("settings.claudeCode.switch")} data-setting-control="claude-code-import-heading" onClick={() => void toggle()} />
        </div>
        {enabled ? (
          <>
            <label className="flex flex-wrap items-center justify-between gap-2 text-[14px] text-ink">
              {sw("settings.claudeCode.scope")}
              <select value={scope} disabled={busy} onChange={(event) => { setScope(event.target.value as Scope); reset(); }} className="rounded-md bg-inset px-2 py-1.5 text-[13px] text-ink">
                <option value="both">{sw("settings.claudeCode.scopeBoth")}</option>
                <option value="skills">{sw("settings.claudeCode.scopeSkills")}</option>
                <option value="mcp">{sw("settings.claudeCode.scopeMcp")}</option>
              </select>
            </label>
            {status?.lastImportedAt ? (
              <p className="text-[12.5px] text-ink-secondary">{sw("settings.claudeCode.last", { skills: status.skills, servers: status.servers, needsKey: status.needsKey })}</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={button} disabled={busy} onClick={() => void run(true)}>{sw(status?.lastImportedAt ? "settings.claudeCode.reviewAgain" : "settings.claudeCode.review")}</button>
              {review && !nothingNew ? <button type="button" className={primary} disabled={busy} onClick={() => void run(false)}>{sw("settings.claudeCode.import")}</button> : null}
            </div>
            {review ? (
              <div className="flex flex-col gap-3 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink" data-testid="claude-code-review">
                {nothingNew ? <p>{sw("settings.claudeCode.nothingNew")}</p> : null}
                {review.skills.length > 0 ? (
                  <div>
                    <div className="font-medium">{sw("settings.claudeCode.skillsHeading")}</div>
                    <ul className="mt-1 list-disc pl-5">{review.skills.map((skill) => <li key={`s-${skill.name}`}>{skill.name}</li>)}</ul>
                    <p className="mt-1 text-[12.5px] text-ink-secondary">{sw("settings.claudeCode.skillsOff")}</p>
                  </div>
                ) : null}
                {review.servers.length > 0 ? (
                  <div>
                    <div className="font-medium">{sw("settings.claudeCode.toolsHeading")}</div>
                    <ul className="mt-1 list-disc pl-5">
                      {review.servers.map((server) => (
                        <li key={`t-${server.name}`}>{server.name}{server.needsKey ? <span className="ml-2 rounded bg-warning/15 px-1.5 py-0.5 text-[11.5px] text-warning">{sw("settings.claudeCode.needsKey")}</span> : null}</li>
                      ))}
                    </ul>
                    <p className="mt-1 text-[12.5px] text-ink-secondary">{sw("settings.claudeCode.toolsOff")}</p>
                  </div>
                ) : null}
                {review.skipped.length > 0 ? <p className="text-[12.5px] text-ink-secondary">{sw("settings.claudeCode.skipped", { count: review.skipped.length })}</p> : null}
              </div>
            ) : null}
            {receipt ? (
              <p role="status" className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[13px] text-success">
                {sw("settings.claudeCode.done", { skills: receipt.skills, servers: receipt.servers, needsKey: receipt.needsKey })}
              </p>
            ) : null}
          </>
        ) : null}
        {error ? <p role="alert" className="text-[12.5px] text-danger">{error}</p> : null}
      </div>
    </Card>
  );
}
