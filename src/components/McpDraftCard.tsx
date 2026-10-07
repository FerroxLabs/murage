// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// One pasted server, as a card (spec MCP-LINK 7, mockup MCP-LINK-MOCKUP.html).
// Presentational: the state comes in as props and every move goes out as a
// callback, so each card state can be drawn and checked without a network. A
// secret the owner types lives in the state the parent holds; the DOM shows it
// only as the value of a password field.
import { AlertTriangle, Check, KeyRound, Loader2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { displayArgs, hostOf, installStage, secretsInArgs, type HeaderChoice } from "@/lib/mcp-add-flow";
import { connectedSentence, draftView, probeSentence, type DraftCardState } from "@/lib/mcp-card-view";

export interface McpDraftCardActions {
  onName(name: string): void;
  onField(id: string, value: string): void;
  onKeyValue(value: string): void;
  onMoveArgSecrets(): void;
  onHeader(choice: HeaderChoice, custom?: string): void;
  onSignIn(): void;
  onCancelSignIn(): void;
  onUseKey(): void;
  onUseSignIn(): void;
  onSaveKey(): void;
  onConfirmLocal(): void;
  onBack(): void;
  onUseMoved(): void;
  onAdd(): void;
  onTurnOn(): void;
  onDone(): void;
  onKeepWaiting(): void;
  onRetry(): void;
}

const buttonPrimary = "flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50 sm:min-h-0 sm:w-auto";
const buttonPlain = "flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-lg border border-hairline/60 bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50 sm:min-h-0 sm:w-auto";
const linkButton = "text-left text-[12.5px] text-accent-text underline underline-offset-4 hover:opacity-80";
const fieldClass = "w-full rounded-lg border border-hairline/60 bg-inset px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent";

function Icon({ tone, children }: { tone: "ok" | "warn" | "bad" | "key"; children: React.ReactNode }) {
  return (
    <span aria-hidden="true" className={cn("flex size-8 shrink-0 items-center justify-center rounded-full",
      tone === "ok" && "bg-success/15 text-success", tone === "warn" && "bg-warning/15 text-warning",
      tone === "bad" && "bg-danger/15 text-danger", tone === "key" && "bg-raised text-accent-text")}>
      {children}
    </span>
  );
}

function Heading({ tone, icon, children }: { tone: "ok" | "warn" | "bad" | "key"; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <Icon tone={tone}>{icon}</Icon>
      <h4 className="min-w-0 text-[14px] font-medium leading-snug text-ink">{children}</h4>
    </div>
  );
}

function Spinner({ children }: { children: React.ReactNode }) {
  return <div role="status" className="flex items-center gap-2.5 py-1 text-[12.5px] text-ink-secondary"><Loader2 size={15} className="shrink-0 animate-spin" />{children}</div>;
}

/** The labelled fields a snippet asked for. Secrets are password fields. */
function Fields({ state, actions }: { state: DraftCardState; actions: McpDraftCardActions }) {
  const { fields } = state.draft;
  if (fields.length === 0) return null;
  const needsFromOwner = fields.filter((field) => field.secret || field.placeholder || field.value === undefined);
  return (
    <div className="mt-3 space-y-3">
      {needsFromOwner.length > 0 && (
        <p className="text-[12.5px] text-ink-secondary">
          {needsFromOwner.length === 1 ? t("mcp.card.fields.one") : t("mcp.card.fields.many", { count: needsFromOwner.length })}{" "}
          {fields.some((field) => field.secret) ? t("mcp.card.fields.hidden") : ""}
        </p>
      )}
      {fields.map((field) => (
        <label key={field.id} className="block">
          <span className="block text-[12px] font-medium text-ink-secondary">{field.label}</span>
          <input
            type={field.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={state.typed[field.id] ?? (field.secret || field.placeholder ? "" : field.value ?? "")}
            onChange={(event) => actions.onField(field.id, event.target.value)}
            placeholder={field.secret ? t("mcp.card.fields.secretPlaceholder") : ""}
            className={cn(fieldClass, "mt-1.5 font-mono text-[12px]")}
          />
        </label>
      ))}
    </div>
  );
}

function KeyEntry({ state, host, actions }: { state: DraftCardState; host: string; actions: McpDraftCardActions }) {
  const signInAvailable = state.probe && !state.probe.ok && Boolean(state.probe.signIn);
  return (
    <div className="mt-3 space-y-3">
      <label className="block">
        <span className="block text-[12px] font-medium text-ink-secondary">{t("mcp.card.key.label")}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={state.keyValue}
          onChange={(event) => actions.onKeyValue(event.target.value)}
          placeholder={t("mcp.card.key.placeholder")}
          className={cn(fieldClass, "mt-1.5")}
        />
      </label>
      <details className="text-[12.5px]">
        <summary className="cursor-pointer text-ink-secondary hover:text-ink" title={t("mcp.card.key.sentAsTip")}>{t("mcp.card.key.sentAs")}: {state.header === "authorization" ? t("mcp.card.key.bearer") : state.header === "x-api-key" ? t("mcp.card.key.xApiKey") : state.customHeader || t("mcp.card.key.other")}</summary>
        <div className="mt-2 space-y-2" role="radiogroup" aria-label={t("mcp.card.key.sentAs")}>
          {(["authorization", "x-api-key", "custom"] as const).map((choice) => (
            <label key={choice} className="flex items-center gap-2 text-ink">
              <input type="radio" name={`header-${state.draft.name}`} checked={state.header === choice} onChange={() => actions.onHeader(choice)} />
              {choice === "authorization" ? t("mcp.card.key.bearer") : choice === "x-api-key" ? t("mcp.card.key.xApiKey") : t("mcp.card.key.other")}
            </label>
          ))}
          {state.header === "custom" && (
            <input aria-label={t("mcp.card.key.headerName")} placeholder={t("mcp.card.key.headerName")} value={state.customHeader} onChange={(event) => actions.onHeader("custom", event.target.value)} className={cn(fieldClass, "max-w-[260px] font-mono text-[12px]")} />
          )}
        </div>
      </details>
      <p className="text-[12px] text-ink-secondary">{t("mcp.card.key.hint", { host })}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <button type="button" className={buttonPrimary} disabled={!state.keyValue.trim() || (state.header === "custom" && !state.customHeader.trim())} onClick={actions.onSaveKey}>{t("mcp.card.key.save")}</button>
        {signInAvailable && <button type="button" className={linkButton} onClick={actions.onUseSignIn}>{t("mcp.card.key.back")}</button>}
      </div>
    </div>
  );
}

export function McpDraftCard({ state, actions }: { state: DraftCardState; actions: McpDraftCardActions }) {
  const { draft, probe } = state;
  const view = draftView(state);
  const host = draft.kind === "remote" ? hostOf(draft.maskedUrl) : "";
  const failed = probe && !probe.ok ? probe : undefined;
  const reasonText = failed ? probeSentence(failed, host) : "";
  const bridgeless = typeof window !== "undefined" && !(window as unknown as { muragebox?: { mcpServers?: unknown } }).muragebox?.mcpServers;
  const toolCount = probe && probe.ok ? probe.tools.length : 0;
  const nameTaken = state.name.trim() === "";

  return (
    <section className="rounded-xl border border-hairline/50 bg-inset p-4" aria-label={state.name || draft.name} data-view={view}>
      {view !== "added" && (
        <label className="mb-3 block">
          <span className="block text-[12px] font-medium text-ink-secondary">{t("mcp.add.name")}</span>
          <input
            value={state.name}
            maxLength={32}
            disabled={Boolean(state.savedName) || state.busy !== null}
            onChange={(event) => actions.onName(event.target.value.toLowerCase())}
            className={cn(fieldClass, "mt-1.5 max-w-[320px] disabled:opacity-60")}
          />
        </label>
      )}

      {view === "saving" && <Spinner>{t("mcp.card.saving")}</Spinner>}
      {view === "testing" && <Spinner>{t("mcp.card.testing")}</Spinner>}
      {view === "installing" && (
        <div>
          <Spinner>{installStage(state.elapsed) === "start" ? t("mcp.card.install.start") : installStage(state.elapsed) === "setup" ? t("mcp.card.install.setup") : t("mcp.card.install.still")}</Spinner>
        </div>
      )}

      {view === "signing" && (
        <div>
          <Spinner>{t("mcp.card.signin.waiting")}</Spinner>
          <div className="mt-3"><button type="button" className={buttonPlain} onClick={actions.onCancelSignIn}>{t("mcp.card.signin.cancel")}</button></div>
        </div>
      )}

      {view === "sign-in" && (
        <div>
          <Heading tone="warn" icon={<AlertTriangle size={16} />}>{t("mcp.card.signin.title", { host })}</Heading>
          {failed?.reason && failed.reason !== "needs-sign-in" && <p className="mt-2 text-[12.5px] text-ink-secondary">{reasonText}</p>}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
            <button type="button" className={buttonPrimary} disabled={bridgeless || nameTaken} title={t("mcp.card.signin.tip", { host })} onClick={actions.onSignIn}>
              {failed?.reason === "sign-in-ended" || failed?.reason === "needs-more-access" ? t("mcp.card.signin.again") : t("mcp.card.signin.button", { host })}
            </button>
            {failed?.apiKey && <button type="button" className={linkButton} onClick={actions.onUseKey}>{t("mcp.card.signin.useKey")}</button>}
          </div>
          {bridgeless && <p className="mt-2 text-[12px] text-ink-secondary">{t("mcp.card.signin.desktopOnly")}</p>}
          {state.message && <p role="alert" className="mt-2 text-[12.5px] text-danger">{state.message}</p>}
        </div>
      )}

      {view === "key" && (
        <div>
          <Heading tone="key" icon={<KeyRound size={16} />}>{failed?.reason === "key-rejected" ? reasonText : t("mcp.card.key.title")}</Heading>
          <KeyEntry state={state} host={host} actions={actions} />
          {state.message && <p role="alert" className="mt-2 text-[12.5px] text-danger">{state.message}</p>}
        </div>
      )}

      {view === "local-confirm" && failed && (
        <div>
          <Heading tone="warn" icon={<AlertTriangle size={16} />}>
            {failed.needs === "local-network" ? t("mcp.card.local.network", { host }) : t("mcp.card.local.computer")}
          </Heading>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <button type="button" className={buttonPrimary} onClick={actions.onConfirmLocal}>{t("mcp.card.local.continue")}</button>
            <button type="button" className={buttonPlain} onClick={actions.onBack}>{t("mcp.card.local.back")}</button>
          </div>
        </div>
      )}

      {view === "moved" && failed && (
        <div>
          <Heading tone="warn" icon={<AlertTriangle size={16} />}>{t("mcp.card.moved", { url: failed.suggestUrl ?? "" })}</Heading>
          <div className="mt-3">
            {failed.suggestHoldsSecret
              ? <p className="text-[12.5px] text-ink-secondary">{t("mcp.card.moved.paste")}</p>
              : <button type="button" className={buttonPrimary} onClick={actions.onUseMoved}>{t("mcp.card.moved.use")}</button>}
          </div>
        </div>
      )}

      {view === "ready" && (
        <div>
          <h4 className="text-[14px] font-medium text-ink">{t("mcp.add.found")}</h4>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
            <dt className="text-ink-secondary">{t("mcp.add.name")}</dt><dd className="min-w-0 break-words text-ink">{state.name}</dd>
            <dt className="text-ink-secondary">{t("mcp.row.details")}</dt>
            <dd className="min-w-0 break-words font-mono text-[12px] text-ink">
              {draft.kind === "remote" ? draft.maskedUrl : [draft.command, ...displayArgs(draft.args)].join(" ")}
            </dd>
          </dl>
          {draft.kind === "stdio" && secretsInArgs(draft.args).length > 0 && (
            <div role="alert" className="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-3">
              <p className="text-[12.5px] text-ink">{t("mcp.card.argSecret", { name: secretsInArgs(draft.args)[0]!.envName })}</p>
              <div className="mt-2"><button type="button" className={buttonPlain} onClick={actions.onMoveArgSecrets}>{t("mcp.card.argSecretMove")}</button></div>
            </div>
          )}
          <Fields state={state} actions={actions} />
          {state.message && <p role="alert" className="mt-2 text-[12.5px] text-danger">{state.message}</p>}
          <div className="mt-3"><button type="button" className={buttonPrimary} disabled={nameTaken} title={t("mcp.card.addTestTip")} onClick={actions.onAdd}>{t("mcp.card.addTest")}</button></div>
        </div>
      )}

      {view === "still-installing" && (
        <div>
          <Heading tone="warn" icon={<AlertTriangle size={16} />}>{t("mcp.card.stillInstalling")}</Heading>
          <div className="mt-3"><button type="button" className={buttonPrimary} onClick={actions.onKeepWaiting}>{t("mcp.card.keepWaiting")}</button></div>
        </div>
      )}

      {view === "error" && (
        <div>
          <Heading tone="bad" icon={<AlertTriangle size={16} />}>{failed ? reasonText : state.message ?? ""}</Heading>
          {state.message && failed && <p role="alert" className="mt-2 text-[12.5px] text-danger">{state.message}</p>}
          <div className="mt-3"><button type="button" className={buttonPlain} onClick={actions.onRetry}>{t("mcp.card.tryAgain")}</button></div>
        </div>
      )}

      {view === "connected" && (
        <div>
          <Heading tone="ok" icon={<Check size={16} />}>{connectedSentence(toolCount)}</Heading>
          {probe && probe.ok && toolCount > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[12.5px] text-ink-secondary hover:text-ink">{t("mcp.card.tools")}</summary>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {probe.tools.map((tool) => <span key={tool.name} className="rounded-md bg-raised px-2 py-0.5 font-mono text-[11.5px] text-ink">{tool.name}</span>)}
              </div>
            </details>
          )}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <button type="button" className={buttonPrimary} title={t("mcp.card.turnOnTip")} onClick={actions.onTurnOn}>{t("mcp.card.turnOn")}</button>
            <button type="button" className={buttonPlain} onClick={actions.onDone}>{t("mcp.card.done")}</button>
          </div>
          <p className="mt-2 text-[12px] text-ink-secondary">{t("mcp.card.turnOnTip")}</p>
        </div>
      )}

      {view === "added" && <p role="status" className="flex items-center gap-2 text-[13px] text-success"><Check size={15} />{t("mcp.card.nowOn", { name: state.name })}</p>}
    </section>
  );
}
