// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings: the switch for channels set to Auto. With it on, Murage asks a
// fast hosted model which bot should answer a message nobody was addressed in.
// It follows the Flux Router connection by default; a choice saved here wins.
import { useState } from "react";

import { Switch } from "./SettingsPrimitives";
import { api, useStore, type ConfigStatus } from "@/state/store";

export const ROOM_ROUTING_COPY = {
  title: "Who answers in channels",
  subtitle: "For channels set to Auto, Murage picks which bot answers a message nobody was addressed in.",
  label: "Let Murage pick who answers in channels set to Auto",
  help: "If it cannot decide, or takes too long, the channel's lead answers as usual. Your messages are never held up for it.",
  noKey: "Connect Flux Router to turn this on.",
  unavailable: "Not available on your current Flux Router account right now. Channels keep using their lead, and Murage checks again later.",
} as const;

export type RoomRoutingSwitch = { checked: boolean; disabled: boolean; note: string };

/** What the switch shows for a config status. Pure, so it is easy to test. */
export function roomRoutingSwitch(config: Pick<ConfigStatus, "decider" | "flux"> | null | undefined): RoomRoutingSwitch {
  const decider = config?.decider;
  const hasKey = config?.flux?.configured === true || decider?.byoKeyConfigured === true;
  if (!hasKey) return { checked: false, disabled: true, note: ROOM_ROUTING_COPY.noKey };
  if (decider?.available === false) return { checked: false, disabled: true, note: ROOM_ROUTING_COPY.unavailable };
  return { checked: decider?.enabled === true && decider.jobs?.roomRouting === true, disabled: false, note: "" };
}

export function RoomRoutingSettings() {
  const { state, dispatch } = useStore();
  const view = roomRoutingSwitch(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (saving || view.disabled) return;
    setSaving(true);
    setError("");
    try {
      const next = !view.checked;
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ decider: { enabled: next, jobs: { roomRouting: next } } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this setting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div id="room-routing-label" className="text-[14px] font-medium text-ink">{ROOM_ROUTING_COPY.label}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{view.note || ROOM_ROUTING_COPY.help}</div>
        </div>
        <Switch
          checked={view.checked}
          aria-labelledby="room-routing-label"
          disabled={saving || view.disabled}
          onClick={() => void toggle()}
          className="disabled:cursor-wait disabled:opacity-50"
        />
      </div>
      {error ? <p role="alert" className="text-[12px] text-danger">{error}</p> : null}
    </div>
  );
}
