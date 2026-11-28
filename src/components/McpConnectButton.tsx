// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Connect control in a Cloud MCP server's own row (lib/mcp-cloud-connect.ts has the flow and the contract). Optional: nothing
// opens it, nothing asks for it. Every state has a way out.
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { runConnect, type ConnectState } from "@/lib/mcp-cloud-connect";

const buttonClass = "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] hover:bg-raised disabled:opacity-40";

/** The words and buttons for one state. Pure, so each state can be rendered and checked on its own. */
export function McpConnectView({ state, host, disabled = false, onConnect, onCancel }: {
  state: ConnectState; host: string; disabled?: boolean; onConnect: () => void; onCancel: () => void;
}) {
  if (state.phase === "connecting") {
    return <span role="status" className="inline-flex items-center gap-1.5 text-[12px] text-ink-secondary"><Loader2 size={14} className="animate-spin" /> {t("ux.cloud.mcpConnect.connecting")}</span>;
  }
  if (state.phase === "waiting") {
    return (
      <span role="status" className="inline-flex flex-wrap items-center gap-2 text-[12px] text-ink-secondary">
        <Loader2 size={14} className="animate-spin" /> {t("ux.cloud.mcpConnect.waiting", { host })}
        <a href={state.url} target="_blank" rel="noopener noreferrer" className="text-accent-text underline">{t("ux.cloud.mcpConnect.openAgain", { host })}</a>
        <button type="button" onClick={onCancel} className={buttonClass}>{t("ux.cloud.mcpConnect.cancel")}</button>
      </span>
    );
  }
  if (state.phase === "connected") {
    return <span role="status" className="inline-flex items-center gap-1.5 text-[12px] text-success"><CheckCircle2 size={14} /> {t("ux.cloud.mcpConnect.connected")}</span>;
  }
  if (state.phase === "failed") {
    return (
      <span className="inline-flex flex-wrap items-center gap-2 text-[12px]">
        <span role="alert" className="text-warning">{state.message}</span>
        <button type="button" disabled={disabled} onClick={onConnect} className={cn(buttonClass, "text-accent-text")}>{t("ux.cloud.mcpConnect.retry")}</button>
      </span>
    );
  }
  return (
    <button type="button" disabled={disabled} onClick={onConnect} title={t("ux.cloud.mcpConnect.buttonTip", { host })} className={cn(buttonClass, "text-accent-text")}>
      <KeyRound size={14} /> {t("ux.cloud.mcpConnect.button")}
    </button>
  );
}

export function McpConnectButton({ name, host, signedIn, onConnected, disabled }: {
  name: string; host: string; signedIn: () => Promise<boolean | null>; onConnected: () => void; disabled?: boolean;
}) {
  const [state, setState] = useState<ConnectState>({ phase: "idle" });
  const run = useRef(0);
  useEffect(() => () => { run.current += 1; }, []);
  const start = () => {
    const mine = ++run.current;
    void runConnect({
      name, host, signedIn,
      set: (next) => { if (run.current === mine) { setState(next); if (next.phase === "connected") onConnected(); } },
      stopped: () => run.current !== mine,
    });
  };
  const cancel = () => { run.current += 1; setState({ phase: "idle" }); };
  return <McpConnectView state={state} host={host} disabled={disabled} onConnect={start} onCancel={cancel} />;
}
