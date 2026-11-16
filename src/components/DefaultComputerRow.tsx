// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Default computer for new bots (CONTRACTS-B 2): the computer a new bot starts on. It is read when a bot is made and copied
// into that bot, so changing it never touches the bots you already have, and a bot's own Access > Computer choice wins.
import { useEffect, useState } from "react";
import { isCloudOrigin } from "@/lib/cloud-workspace";
import { sw } from "@/lib/settings-words";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { Card } from "./SettingsPrimitives";

const CHOICES = ["off", "this", "vm", "cloud"] as const;
type Choice = (typeof CHOICES)[number];
const LABEL: Record<Choice, () => string> = {
  off: () => sw("settings.computer.defaultOff"),
  this: () => sw("settings.computer.defaultThis"),
  vm: () => sw("settings.computer.defaultVm"),
  cloud: () => sw("settings.computer.defaultCloud"),
};

export function DefaultComputerRow() {
  const { state, dispatch } = useStore();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [vmAvailable, setVmAvailable] = useState(false);
  const current: Choice = state.config?.newBotComputer ?? "this";
  const bot = state.bots.find((candidate) => !candidate.hidden);
  const vmMode = state.config?.localVm?.mode ?? "shared";
  const cloud = isCloudOrigin();
  useEffect(() => {
    setVmAvailable(false);
    if (cloud || vmMode !== "shared") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const status: { runtime: string | null; ready: boolean; mode: "shared" | "per-bot" } = await api("/api/local-computer", { signal: controller.signal });
        if (active) setVmAvailable(Boolean(status.runtime) && status.ready === true && status.mode === "shared");
      } catch {
        if (active) setVmAvailable(false);
      } finally {
        if (active) timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => { active = false; controller.abort(); if (timer !== undefined) clearTimeout(timer); };
  }, [cloud, vmMode]);
  const change = async (value: Choice) => {
    if (value === current || saving || (value === "vm" && (!vmAvailable || cloud || vmMode !== "shared"))) return;
    setError("");
    setSaving(true);
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ computer: { defaultForNewBots: value } }) });
      dispatch({ type: "configStatus", config });
    } catch {
      setError(sw("settings.computer.defaultError"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card title={sw("settings.computer.defaultTitle")} subtitle={sw("settings.computer.defaultNote")}>
      <div role="radiogroup" aria-label={sw("settings.computer.defaultTitle")} data-setting-control="default-computer-heading" className="flex flex-wrap gap-2">
        {CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={choice === current}
            disabled={saving || (choice === "vm" && (!vmAvailable || cloud || vmMode !== "shared"))}
            onClick={() => void change(choice)}
            className={`min-h-11 rounded-lg border px-3 py-1.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 ${choice === current ? "border-accent bg-accent/10 text-ink" : "border-hairline/40 text-ink hover:bg-control"}`}
          >
            {LABEL[choice]()}
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={!bot}
        onClick={() => { if (bot) dispatch({ type: "toggleSettings", open: true, botId: bot.id, intent: { section: "access", anchor: "bot-setting-computer" } }); }}
        className="mt-3 min-h-11 rounded-md text-left text-[12.5px] leading-relaxed text-ink-secondary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
      >
        {sw("settings.computer.defaultPerBot", { bot: bot?.name ?? sw("settings.computer.defaultBotFallback") })}
      </button>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}
