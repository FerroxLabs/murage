// The MCP servers tab of the Plugins dialog. Every route it calls is
// desktop-only, so this renders only inside the packaged app. Configured
// secret VALUES never come back from the harness: the form shows each saved
// key with an empty value, and an empty value beside a known key is the
// write-only "keep what is stored" placeholder. A server is added by pasting a
// link, a command or a config snippet (McpAddSection); secrets and sign-in go
// through the desktop shell (src/lib/mcp-bridge.ts), never through this page's
// requests.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  CirclePower,
  FlaskConical,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ServerCog,
  Trash2,
} from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { displayArgs, envForBody, hostOf, installStage, removeServer, signInTo, testServer, type ProbeView } from "@/lib/mcp-add-flow";
import { probeSentence } from "@/lib/mcp-card-view";
import { useMcpBridge } from "@/lib/use-mcp-bridge";
import { api } from "@/state/store";
import { NETLIFY_TOKEN_ENTRY } from "../../shared/published-sites";
import { McpAddSection } from "./McpAddSection";

export interface McpServerListing {
  kind?: "stdio";
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  enabled: boolean;
  status?: "ready" | "needs-key";
}

/** A server added by link (0.1.62). Names and a masked link only, never a value. */
export interface McpRemoteServerListing {
  kind: "remote";
  name: string;
  url: string;
  host: string;
  transport?: "http" | "sse";
  auth: "none" | "oauth" | "header";
  headerNames: string[];
  local?: "this-computer" | "local-network";
  enabled: boolean;
  status: "ready" | "needs-sign-in" | "needs-key" | "unknown";
}

type AnyListing = McpServerListing | McpRemoteServerListing;
const isRemote = (server: AnyListing): server is McpRemoteServerListing => server.kind === "remote";

interface McpDraft {
  name: string;
  command: string;
  args: string;
  env: string;
}

const EMPTY_DRAFT: McpDraft = { name: "", command: "", args: "", env: "" };
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseMcpArguments(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function parseMcpEnvironment(
  value: string,
  savedKeys: readonly string[] = [],
): { ok: true; env: Record<string, string | true> } | { ok: false; error: string } {
  const saved = new Set(savedKeys);
  const env: Record<string, string | true> = {};
  for (const original of value.split(/\r?\n/)) {
    const line = original.trim();
    if (!line) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) return { ok: false, error: `Use KEY=value for “${line}”.` };
    const key = line.slice(0, equals).trim();
    const secret = line.slice(equals + 1);
    if (!ENV_NAME.test(key)) return { ok: false, error: `“${key}” is not a valid environment variable.` };
    if (Object.hasOwn(env, key)) return { ok: false, error: `“${key}” is listed more than once.` };
    env[key] = secret === "" && saved.has(key) ? true : secret;
  }
  return { ok: true, env };
}

function runsSomethingElse(existing: McpServerListing, command: string, args: readonly string[]): boolean {
  return command !== existing.command || JSON.stringify(args) !== JSON.stringify(existing.args);
}

/** The saved env names an edit would hand to a different command: the owner is
 * asked before they are kept (review L6). Empty when nothing is at risk. */
export function savedKeysAtRisk(
  existing: McpServerListing | undefined,
  command: string,
  args: readonly string[],
  env: Record<string, string | true>,
): string[] {
  if (!existing || !runsSomethingElse(existing, command, args)) return [];
  return Object.entries(env).filter(([, value]) => value === true).map(([key]) => key);
}

/** A saved command server as its row shows it: a credential left in the
 * arguments is hidden, as on the add card (review L5). */
export function commandDetails(server: { command: string; args: readonly string[] }): string {
  return [server.command, ...displayArgs(server.args)].join(" ");
}

function draftFor(server: McpServerListing): McpDraft {
  return {
    name: server.name,
    command: server.command,
    args: server.args.join("\n"),
    // Values are intentionally never returned by the server. A blank value
    // beside an existing key is a write-only “keep saved value” placeholder.
    env: server.envKeys.map((key) => `${key}=`).join("\n"),
  };
}

export function McpServersPanel() {
  const { bridge: shell, ready: shellReady } = useMcpBridge();
  const [allServers, setServers] = useState<AnyListing[] | null>(null);
  // The entry that only holds a pasted Netlify token is not a server the owner manages here.
  const servers = allServers === null ? null : allServers.filter((server) => server.name !== NETLIFY_TOKEN_ENTRY);
  const [editing, setEditing] = useState<string | null>(null);
  /** Saved env names awaiting the owner's keep-or-clear answer after a command edit. */
  const [askKeep, setAskKeep] = useState<string[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<McpDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [probe, setProbe] = useState<Record<string, ProbeView>>({});
  const [removing, setRemoving] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const loadGeneration = useRef(0);

  const load = useCallback(() => {
    const generation = ++loadGeneration.current;
    setBusy("load");
    setError(null);
    return api("/api/mcp/servers")
      .then((result) => {
        if (generation === loadGeneration.current) setServers(result.servers ?? []);
      })
      .catch((cause) => {
        if (generation === loadGeneration.current) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (generation === loadGeneration.current) setBusy(null);
      });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A clock for a Test that may take a minute (a command that downloads first).
  const testing = busy?.startsWith("test:") ?? false;
  useEffect(() => {
    if (!testing) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((seconds) => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [testing]);

  const closeEditor = () => {
    setAskKeep(null);
    setEditing(null);
    setDraft(EMPTY_DRAFT);
  };

  const save = async (choice?: "keep" | "clear") => {
    const name = draft.name.trim();
    const command = draft.command.trim();
    if (!name || !command) {
      setError(t("mcp.edit.needBoth"));
      return;
    }
    const existing = servers?.find((server): server is McpServerListing => !isRemote(server) && server.name === editing);
    const parsedEnv = parseMcpEnvironment(draft.env, existing?.envKeys);
    if (!parsedEnv.ok) {
      setError(parsedEnv.error);
      return;
    }
    const bridge = shell;
    // Editing what the server runs while it holds saved values: the owner says
    // whether those values go to the new command. Never decided silently.
    const args = parseMcpArguments(draft.args);
    const runsSomethingNew = existing !== undefined && runsSomethingElse(existing, command, args);
    const keptKeys = savedKeysAtRisk(existing, command, args, parsedEnv.env);
    if (keptKeys.length > 0 && choice === undefined) {
      setAskKeep(keptKeys);
      return;
    }
    setAskKeep(null);
    const sendEnv = choice === "clear" ? Object.fromEntries(Object.entries(parsedEnv.env).filter(([, value]) => value !== true)) : parsedEnv.env;
    const { body: env, secrets } = envForBody(sendEnv, bridge);
    setBusy("save");
    loadGeneration.current += 1;
    setError(null);
    setNotice(null);
    try {
      const result = await api(`/api/mcp/servers/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify({ command, args, env, ...(existing ? { enabled: existing.enabled } : {}), ...(runsSomethingNew && existing && existing.envKeys.length > 0 ? { keepSavedValues: choice === "keep" } : {}) }),
      });
      // Only after the save: a value saved before it would be refused (NEXT-T11).
      if (bridge && Object.keys(secrets).length > 0) {
        const saved = await bridge.saveSecrets(name, { env: secrets });
        if (!saved.ok) throw new Error(saved.message);
      }
      setServers(result.servers);
      setNotice(t("mcp.notice.updated", { name }));
      closeEditor();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (server: AnyListing) => {
    setBusy(`toggle:${server.name}`);
    loadGeneration.current += 1;
    setError(null);
    try {
      const result = await api(`/api/mcp/servers/${server.name}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !server.enabled }),
      });
      setServers(result.servers);
      setNotice(t("mcp.notice.switched", { name: server.name, state: server.enabled ? t("mcp.notice.stateOff") : t("mcp.notice.stateOn") }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const test = async (server: AnyListing) => {
    setBusy(`test:${server.name}`);
    loadGeneration.current += 1;
    setError(null);
    setProbe((current) => {
      const next = { ...current };
      delete next[server.name];
      return next;
    });
    const result = await testServer({ api, bridge: shell }, server.name, !isRemote(server));
    setProbe((current) => ({ ...current, [server.name]: result }));
    setBusy(null);
    void load();
  };

  const signIn = async (server: McpRemoteServerListing) => {
    setBusy(`signin:${server.name}`);
    setError(null);
    const signed = await signInTo({ api, bridge: shell }, server.name);
    if (!signed.ok) {
      if (!signed.cancelled) setError(signed.message || t("mcp.card.signin.desktopOnly"));
      setBusy(null);
      return;
    }
    setBusy(null);
    await test(server);
  };

  const remove = async (server: AnyListing) => {
    setBusy(`delete:${server.name}`);
    loadGeneration.current += 1;
    setError(null);
    const result = await removeServer({ api, bridge: shell }, server.name);
    if (!result.ok) {
      setError(result.message);
      setBusy(null);
      setRemoving(null);
      return;
    }
    setNotice(result.message ?? t("mcp.remove.done"));
    setProbe((current) => {
      const next = { ...current };
      delete next[server.name];
      return next;
    });
    if (editing === server.name) closeEditor();
    setRemoving(null);
    setBusy(null);
    await load();
  };

  const idle = busy === null;
  const buttonClass = "flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40 min-h-[40px] sm:min-h-0";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-7 pt-5 sm:px-8">
      <div className="mx-auto max-w-[840px]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-[15px] font-semibold text-ink">{t("mcp.panel.heading")}</h3>
            <p className="mt-1 max-w-[610px] text-[12.5px] leading-relaxed text-ink-secondary">{t("mcp.panel.lede")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              disabled={busy !== null}
              className="rounded-lg p-2 text-ink-secondary transition-colors hover:bg-raised hover:text-ink disabled:opacity-40"
              aria-label={t("mcp.panel.refresh")}
            >
              <RefreshCw size={16} className={cn(busy === "load" && "animate-spin")} />
            </button>
            <button
              type="button"
              disabled={adding || !shellReady}
              onClick={() => { setAdding(true); closeEditor(); setError(null); setNotice(null); }}
              className="flex min-h-[44px] items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-medium text-white disabled:opacity-40 sm:min-h-0"
            >
              <Plus size={14} /> {t("mcp.panel.add")}
            </button>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-hairline/50 bg-raised/35 px-4 py-3 text-[12px] leading-relaxed text-ink-secondary">{t("mcp.panel.warning")}</div>

        {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
        {notice && <div role="status" className="mt-3 rounded-lg bg-success/10 px-3 py-2 text-[12px] text-success">{notice}</div>}

        {adding && (
          <McpAddSection
            onClose={() => setAdding(false)}
            onChanged={() => void load()}
            onNotice={(message) => setNotice(message)}
          />
        )}

        {editing && (
          <div className="mt-4 rounded-2xl border border-hairline/60 bg-card p-4 sm:p-5">
            <div className="text-[14px] font-medium text-ink">{t("mcp.edit.title", { name: editing })}</div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-[12px] font-medium text-ink-secondary">{t("mcp.edit.name")}</span>
                <input
                  disabled
                  value={draft.name}
                  maxLength={32}
                  className="mt-1.5 w-full rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-60"
                />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-secondary">{t("mcp.edit.command")}</span>
                <input
                  autoFocus
                  value={draft.command}
                  onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))}
                  placeholder="npx"
                  className="mt-1.5 w-full rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-secondary">{t("mcp.edit.args")}</span>
                <textarea
                  value={draft.args}
                  onChange={(event) => setDraft((current) => ({ ...current, args: event.target.value }))}
                  placeholder={"-y\n@modelcontextprotocol/server-github"}
                  rows={5}
                  className="mt-1.5 w-full resize-y rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-secondary">{t("mcp.edit.env")}</span>
                <textarea
                  value={draft.env}
                  onChange={(event) => setDraft((current) => ({ ...current, env: event.target.value }))}
                  placeholder="GITHUB_TOKEN=…"
                  rows={5}
                  className="mt-1.5 w-full resize-y rounded-lg border border-hairline/60 bg-raised px-3 py-2.5 font-mono text-[12px] text-ink outline-none focus:border-accent"
                />
                <span className="mt-1.5 block text-[11px] text-ink-secondary">{t("mcp.edit.envHint")}</span>
              </label>
            </div>
            {askKeep && (
              <div role="alert" className="mt-4 rounded-lg border border-warning/40 bg-warning/10 p-3" data-testid="mcp-keep-values">
                <p className="text-[12.5px] text-ink">{t("mcp.edit.keepAsk", { keys: askKeep.join(", ") })}</p>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <button type="button" disabled={busy !== null} onClick={() => void save("keep")} className="min-h-[44px] rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-medium text-white disabled:opacity-50 sm:min-h-0">{t("mcp.edit.keepYes")}</button>
                  <button type="button" disabled={busy !== null} onClick={() => void save("clear")} className="min-h-[44px] rounded-lg border border-hairline/60 bg-raised px-3.5 py-2 text-[12.5px] text-ink disabled:opacity-50 sm:min-h-0">{t("mcp.edit.keepNo")}</button>
                </div>
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={closeEditor} className="rounded-lg px-3 py-2 text-[12.5px] text-ink-secondary hover:bg-raised">{t("mcp.add.cancel")}</button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void save()}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-medium text-white disabled:opacity-50"
              >
                {busy === "save" && <Loader2 size={13} className="animate-spin" />} {t("mcp.edit.save")}
              </button>
            </div>
          </div>
        )}

        {servers === null ? (
          <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" /> {t("mcp.panel.loading")}</div>
        ) : servers.length === 0 && !editing && !adding ? (
          <div className="mt-5 flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-hairline/60 text-center">
            <div className="flex size-11 items-center justify-center rounded-xl bg-raised text-ink-secondary"><ServerCog size={21} /></div>
            <div className="mt-3 max-w-sm px-4 text-[13px] text-ink-secondary">{t("mcp.panel.empty")}</div>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {servers.map((server) => {
              const result = probe[server.name];
              const remote = isRemote(server);
              const needsSignIn = remote && server.status === "needs-sign-in";
              const needsKey = server.status === "needs-key";
              const host = remote ? hostOf(server.url) : "";
              return (
                <div key={server.name} className="rounded-2xl border border-hairline/50 bg-card px-4 py-4 sm:px-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", server.enabled ? "bg-success/10 text-success" : "bg-raised text-ink-secondary")}>
                      <ServerCog size={19} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[14px] font-medium text-ink">{server.name}</span>
                        {needsSignIn ? (
                          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10.5px] text-warning">{t("mcp.row.needsSignIn")}</span>
                        ) : needsKey ? (
                          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10.5px] text-warning">{t("mcp.row.needsKey")}</span>
                        ) : (
                          <span className={cn("rounded-full px-2 py-0.5 text-[10.5px]", server.enabled ? "bg-success/10 text-success" : "bg-raised text-ink-secondary")}>{server.enabled ? t("mcp.row.on") : t("mcp.row.off")}</span>
                        )}
                      </div>
                      <div className="mt-1 truncate text-[12px] text-ink-secondary">{remote ? t("mcp.row.sourceLink", { host }) : t("mcp.row.sourceCommand")}</div>
                      <details className="mt-1">
                        <summary className="cursor-pointer text-[11.5px] text-ink-secondary hover:text-ink">{t("mcp.row.details")}</summary>
                        <code className="mt-1.5 block break-all rounded-md bg-inset px-2 py-1.5 font-mono text-[11.5px] text-ink-secondary">
                          {remote ? server.url : commandDetails(server)}
                        </code>
                      </details>
                      {!remote && server.envKeys.length > 0 && <div className="mt-1 truncate text-[11px] text-ink-secondary">{t("mcp.row.secretsSaved", { names: server.envKeys.join(", ") })}</div>}
                      {remote && server.headerNames.length > 0 && <div className="mt-1 truncate text-[11px] text-ink-secondary">{t("mcp.row.secretsSaved", { names: server.headerNames.join(", ") })}</div>}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1">
                      <button type="button" disabled={!idle} onClick={() => void test(server)} title={t("mcp.row.testTip")} className={buttonClass}>
                        {busy === `test:${server.name}` ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />} {t("mcp.row.test")}
                      </button>
                      {needsSignIn && (
                        <button type="button" disabled={!idle} onClick={() => void signIn(server)} title={t("mcp.row.signInTip", { host })} className={cn(buttonClass, "text-accent-text")}>
                          {busy === `signin:${server.name}` ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} {t("mcp.row.signIn")}
                        </button>
                      )}
                      <button type="button" disabled={!idle} onClick={() => void toggle(server)} className={buttonClass} aria-label={server.enabled ? t("mcp.row.turnOffAria", { name: server.name }) : t("mcp.row.turnOnAria", { name: server.name })}>
                        {busy === `toggle:${server.name}` ? <Loader2 size={14} className="animate-spin" /> : <CirclePower size={14} />} {server.enabled ? t("mcp.row.turnOff") : t("mcp.row.turnOn")}
                      </button>
                      {!remote && (
                        <button type="button" disabled={!idle} onClick={() => { setEditing(server.name); setDraft(draftFor(server)); setAdding(false); setError(null); setNotice(null); }} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40" aria-label={t("mcp.row.editAria", { name: server.name })}><Pencil size={14} /></button>
                      )}
                      <button type="button" disabled={!idle} onClick={() => setRemoving(server.name)} className="rounded-lg p-2 text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40" aria-label={t("mcp.row.removeAria", { name: server.name })}><Trash2 size={14} /></button>
                    </div>
                  </div>
                  {removing === server.name && (
                    <div role="alertdialog" aria-label={t("mcp.remove.confirm", { name: server.name })} className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-danger/5 px-3 py-2 text-[12.5px] text-ink">
                      <span>{t("mcp.remove.confirm", { name: server.name })}</span>
                      <button type="button" disabled={!idle} onClick={() => void remove(server)} className="rounded-lg px-2.5 py-1.5 text-danger hover:bg-danger/10 disabled:opacity-40">{busy === `delete:${server.name}` && <Loader2 size={13} className="mr-1 inline animate-spin" />}{t("mcp.remove.yes")}</button>
                      <button type="button" onClick={() => setRemoving(null)} className="rounded-lg px-2.5 py-1.5 text-ink-secondary hover:bg-raised">{t("mcp.remove.keep")}</button>
                    </div>
                  )}
                  {busy === `test:${server.name}` && !remote && elapsed >= 2 && (
                    <div role="status" className="mt-3 text-[12px] text-ink-secondary">
                      {installStage(elapsed) === "start" ? t("mcp.card.install.start") : installStage(elapsed) === "setup" ? t("mcp.card.install.setup") : t("mcp.card.install.still")}
                    </div>
                  )}
                  {result && (
                    <div role="status" className={cn("mt-3 rounded-lg px-3 py-2 text-[12px]", result.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>
                      {result.ok ? (
                        <span className="flex items-start gap-2"><CheckCircle2 size={14} className="mt-px shrink-0" />{" "}
                          {result.tools.length ? t("mcp.row.connectedTools", { count: result.tools.length, names: result.tools.map((tool) => tool.name).join(", ") }) : t("mcp.row.connectedNoTools")}</span>
                      ) : probeSentence(result, host)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

