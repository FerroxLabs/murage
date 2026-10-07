// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// "Add a server": one box for a link, a command or a config snippet, then a card
// per server it holds (spec MCP-LINK 3.10, 7). Paste, Continue, and the card
// says what is needed: sign in, an API key, a value or two, a confirmation for a
// link that points at this computer. Nothing is turned on until the owner says.
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  envValues, headerFor, headerValues, inspectInput, moveArgSecretsToEnv, saveCommand, saveRemote, setEnabled, signInTo, testServer,
  type FlowDeps, type HeaderChoice, type LocalKind, type MergedDraft,
} from "@/lib/mcp-add-flow";
import { newCardState, pasteHoldsSecret, withProbe, type DraftCardState } from "@/lib/mcp-card-view";
import { useMcpBridge } from "@/lib/use-mcp-bridge";
import { api } from "@/state/store";
import { McpDraftCard, type McpDraftCardActions } from "./McpDraftCard";

const EXAMPLES: Array<{ label: string; text: string }> = [
  { label: "https://cloud.comfy.org/mcp", text: "https://cloud.comfy.org/mcp" },
  { label: "npx -y @scope/server", text: "npx -y @scope/server" },
  { label: "{ \"mcpServers\": ... }", text: "{\n  \"mcpServers\": {\n    \"example\": {\n      \"command\": \"npx\",\n      \"args\": [\"-y\", \"@scope/server\"],\n      \"env\": { \"EXAMPLE_API_KEY\": \"\" }\n    }\n  }\n}" },
];

const MAX_PROBED = 5;

export function McpAddSection({ onClose, onChanged, onNotice }: {
  onClose(): void;
  /** The list of saved servers changed: load it again. */
  onChanged(): void;
  onNotice(message: string): void;
}) {
  const { bridge, ready } = useMcpBridge();
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const [text, setText] = useState("");
  const [cards, setCards] = useState<DraftCardState[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [inspecting, setInspecting] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [secretHidden, setSecretHidden] = useState(false);
  const inputRef = useRef("");
  const cardsRef = useRef<DraftCardState[]>([]);
  cardsRef.current = cards;
  const deps = useCallback((): FlowDeps => ({ api, bridge: bridgeRef.current }), []);

  const patch = useCallback((index: number, change: Partial<DraftCardState> | ((state: DraftCardState) => Partial<DraftCardState>)) => {
    setCards((current) => current.map((card, at) => (at === index ? { ...card, ...(typeof change === "function" ? change(card) : change) } : card)));
  }, []);

  // One clock for every first-run install in progress.
  const installing = cards.some((card) => card.busy === "installing");
  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(() => {
      setCards((current) => current.map((card) => (card.busy === "installing" ? { ...card, elapsed: card.elapsed + 1 } : card)));
    }, 1000);
    return () => clearInterval(timer);
  }, [installing]);

  const runInspect = async (input: string, confirmLocal?: LocalKind) => {
    setInspecting(true);
    setHint(null);
    try {
      const outcome = await inspectInput(deps(), input, confirmLocal);
      if (!outcome.ok) {
        setHint(outcome.message);
        setCards([]);
        return undefined;
      }
      inputRef.current = input;
      setNotes(outcome.notes);
      return outcome;
    } catch (error) {
      setHint(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      setInspecting(false);
    }
  };

  const cont = async () => {
    const outcome = await runInspect(text);
    if (!outcome) return;
    setCards(outcome.drafts.map(newCardState));
    // A secret that was pasted now lives in its password field: the box that
    // held the paste is emptied so the value is not left on the page twice.
    if (pasteHoldsSecret(outcome.drafts)) { setText(""); setSecretHidden(true); } else setSecretHidden(false);
  };

  const finishCard = (index: number, message?: string) => {
    if (message) onNotice(message);
    setCards((current) => current.filter((_, at) => at !== index));
    onChanged();
  };

  const saveAndTest = async (index: number, run: (state: DraftCardState) => Promise<{ ok: true } | { ok: false; message: string }>, firstRun: boolean) => {
    const state = cardsRef.current[index]!;
    patch(index, { busy: "saving", message: undefined });
    const saved = await run(state);
    if (!saved.ok) {
      patch(index, { busy: null, message: saved.message });
      return;
    }
    onChanged();
    patch(index, { savedName: state.name.trim(), busy: firstRun ? "installing" : "testing", elapsed: 0 });
    const probe = await testServer(deps(), state.name.trim(), firstRun);
    patch(index, { probe, tested: true, busy: null, keyValue: "", typed: {} });
  };

  const actionsFor = (index: number): McpDraftCardActions => ({
    onName: (name) => patch(index, { name }),
    onField: (id, value) => patch(index, (state) => ({ typed: { ...state.typed, [id]: value } })),
    onKeyValue: (keyValue) => patch(index, { keyValue }),
    onMoveArgSecrets: () => patch(index, (state) => {
      if (state.draft.kind !== "stdio") return {};
      const moved = moveArgSecretsToEnv(state.draft, state.typed);
      return { draft: { ...state.draft, ...moved.draft }, typed: moved.typed };
    }),
    onHeader: (header: HeaderChoice, custom) => patch(index, { header, ...(custom !== undefined ? { customHeader: custom } : {}) }),
    onUseKey: () => patch(index, { useKey: true, message: undefined }),
    onUseSignIn: () => patch(index, { useKey: false, message: undefined }),
    onSignIn: async () => {
      const state = cardsRef.current[index]!;
      if (state.draft.kind !== "remote") return;
      const draft = state.draft;
      patch(index, { busy: "saving", message: undefined });
      const name = state.name.trim();
      const saved = await saveRemote(deps(), { name, draft, auth: "oauth", headers: {}, confirmLocal: state.confirmed, existing: state.savedName === name });
      if (!saved.ok) { patch(index, { busy: null, message: saved.message }); return; }
      onChanged();
      patch(index, { savedName: name, busy: "signing" });
      const signed = await signInTo(deps(), name);
      if (!signed.ok) {
        patch(index, { busy: null, message: signed.cancelled ? undefined : signed.message || t("mcp.card.signin.desktopOnly") });
        return;
      }
      // the saved row's status changed with the sign-in
      onChanged();
      patch(index, { busy: "testing" });
      const probe = await testServer(deps(), name);
      patch(index, { probe, tested: true, busy: null });
    },
    onCancelSignIn: () => {
      const name = cardsRef.current[index]?.savedName;
      if (name) void bridgeRef.current?.cancelSignIn(name);
    },
    onSaveKey: () => void saveAndTest(index, async (state) => {
      if (state.draft.kind !== "remote") return { ok: false, message: "" };
      const { name: headerName, prefix } = headerFor(state.header, state.customHeader);
      return saveRemote(deps(), {
        name: state.name.trim(), draft: state.draft, auth: "header",
        headers: { [headerName]: `${prefix}${state.keyValue.trim()}` },
        confirmLocal: state.confirmed, existing: state.savedName === state.name.trim(),
      });
    }, false),
    onConfirmLocal: async () => {
      const state = cardsRef.current[index]!;
      const needs = state.probe && !state.probe.ok ? state.probe.needs : undefined;
      if (!needs) return;
      const outcome = await runInspect(inputRef.current, needs);
      if (outcome) patch(index, { ...withProbe(outcome.drafts[index]?.probe), confirmed: needs });
    },
    onBack: () => finishCard(index),
    onUseMoved: async () => {
      const state = cardsRef.current[index]!;
      const suggested = state.probe && !state.probe.ok ? state.probe.suggestUrl : undefined;
      if (!suggested) return;
      const outcome = await runInspect(suggested);
      const first = outcome?.drafts[0];
      if (first) setCards((current) => current.map((card, at) => (at === index ? { ...newCardState(first), name: card.name || first.name } : card)));
    },
    onAdd: () => void saveAndTest(index, async (state) => {
      const { draft } = state;
      const name = state.name.trim();
      if (draft.kind === "stdio") return saveCommand(deps(), { name, draft, env: envValues(draft.fields, state.typed) });
      const headers = headerValues(draft.fields, state.typed);
      const auth = Object.keys(headers).length > 0 ? "header" : "none";
      return saveRemote(deps(), { name, draft, auth, headers, confirmLocal: state.confirmed, existing: state.savedName === name });
    }, cardsRef.current[index]?.draft.kind === "stdio"),
    onKeepWaiting: async () => {
      const name = cardsRef.current[index]?.savedName;
      if (!name) return;
      patch(index, { busy: "installing", elapsed: 0 });
      const probe = await testServer(deps(), name, true);
      patch(index, { probe, tested: true, busy: null });
    },
    onTurnOn: async () => {
      const name = cardsRef.current[index]?.savedName;
      if (!name) return;
      try {
        await setEnabled(deps(), name, true);
        patch(index, { enabled: true });
        onChanged();
      } catch (error) {
        patch(index, { message: error instanceof Error ? error.message : String(error) });
      }
    },
    onDone: () => finishCard(index, t("mcp.card.addedOff")),
    onRetry: async () => {
      const outcome = await runInspect(inputRef.current);
      if (outcome) setCards(outcome.drafts.map(newCardState));
    },
  });

  const close = () => {
    for (const card of cardsRef.current) if (card.busy === "signing" && card.savedName) void bridgeRef.current?.cancelSignIn(card.savedName);
    onClose();
  };

  // A finished card turned on closes the section once nothing is left to do.
  useEffect(() => {
    if (cards.length > 0 && cards.every((card) => card.enabled)) {
      const timer = setTimeout(onClose, 1800);
      return () => clearTimeout(timer);
    }
  }, [cards, onClose]);

  return (
    <section className="mt-4 rounded-2xl border border-hairline/60 bg-card p-4 sm:p-5" aria-labelledby="mcp-add-heading">
      <div className="flex items-start justify-between gap-3">
        <h4 id="mcp-add-heading" className="text-[14px] font-medium text-ink">{t("mcp.add.heading")}</h4>
        <button type="button" onClick={close} aria-label={t("mcp.add.close")} className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"><X size={16} /></button>
      </div>
      <label htmlFor="mcp-add-input" className="mt-3 block text-[12.5px] font-medium text-ink">{t("mcp.add.label")}</label>
      <textarea
        id="mcp-add-input"
        autoFocus
        rows={3}
        spellCheck={false}
        autoComplete="off"
        value={text}
        onChange={(event) => { setText(event.target.value); setHint(null); }}
        placeholder={t("mcp.add.placeholder")}
        className="mt-1.5 w-full resize-y rounded-lg border border-hairline/60 bg-inset px-3 py-2.5 font-mono text-[12.5px] text-ink outline-none focus:border-accent"
      />
      <p className="mt-1.5 text-[12px] text-ink-secondary">{t("mcp.add.help")}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[12px] text-ink-secondary">{t("mcp.add.examples")}</span>
        {EXAMPLES.map((example) => (
          <button key={example.label} type="button" onClick={() => { setText(example.text); setHint(null); }} className="rounded-md border border-dashed border-hairline/70 bg-inset px-2 py-0.5 font-mono text-[11.5px] text-ink-secondary hover:border-accent hover:text-ink">{example.label}</button>
        ))}
      </div>
      {secretHidden && <p role="status" className="mt-3 text-[12px] text-ink-secondary">{t("mcp.add.secretHidden")}</p>}
      {hint && <p role="alert" className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-[12.5px] text-ink">{hint}</p>}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button type="button" onClick={close} className="min-h-[44px] rounded-lg px-3 py-2 text-[12.5px] text-ink-secondary hover:bg-raised sm:min-h-0">{t("mcp.add.cancel")}</button>
        <button type="button" disabled={!text.trim() || inspecting || !ready} onClick={() => void cont()} className={cn("flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-medium text-white disabled:opacity-50 sm:min-h-0")}>
          {inspecting && <Loader2 size={13} className="animate-spin" />} {t("mcp.add.continue")}
        </button>
      </div>
      {inspecting && <div role="status" className="mt-3 text-[12.5px] text-ink-secondary">{t("mcp.add.inspecting")}</div>}
      {notes.length > 0 && cards.length > 0 && <ul className="mt-3 space-y-1 text-[12px] text-ink-secondary">{notes.map((note) => <li key={note}>{note}</li>)}</ul>}
      {cards.length > MAX_PROBED && <p className="mt-3 text-[12px] text-ink-secondary">{t("mcp.add.tooMany", { count: MAX_PROBED })}</p>}
      <div className="mt-4 space-y-3" aria-live="polite">
        {cards.map((card, index) => <McpDraftCard key={`${card.draft.kind}-${index}`} state={card} actions={actionsFor(index)} />)}
      </div>
    </section>
  );
}

export type { MergedDraft };
