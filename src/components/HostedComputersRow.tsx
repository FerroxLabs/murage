// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hosted computers on a Cloud home (Settings v10 A5, owner: sv10-tools): the switch for `features.cloudBoxComputers`. Off means no
// hosted computer is made, woken or mounted for any bot (server/box-relay.ts cloudBoxComputersAllowed); a desktop has no such
// switch, so the row is not drawn there.
import { useState } from "react";
import { isCloudOrigin } from "@/lib/cloud-workspace";
import { tw } from "@/lib/tools-page-words";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { Card, Switch } from "./SettingsPrimitives";

export function HostedComputersRow() {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (!isCloudOrigin()) return null;
  const on = state.config?.features?.cloudBoxComputers === true;
  const toggle = async () => {
    if (saving) return;
    setSaving(true); setError("");
    try {
      const config = await api("/api/config", { method: "PATCH", body: JSON.stringify({ features: { cloudBoxComputers: !on } }) }) as ConfigStatus;
      if ((config.features?.cloudBoxComputers === true) !== !on) throw new Error("not confirmed");
      dispatch({ type: "configStatus", config });
    } catch { setError(tw("settings.computer.hostedError")); }
    finally { setSaving(false); }
  };
  return (
    <Card title={tw("settings.computer.hostedTitle")} subtitle={tw(on ? "settings.computer.hostedOn" : "settings.computer.hostedOff")}>
      <div className="flex items-center justify-between gap-4">
        <span className="text-[13px] text-ink">{tw("settings.computer.hostedTitle")}</span>
        <Switch checked={on} disabled={saving} aria-label={tw("settings.computer.hostedTitle")} onClick={() => void toggle()} />
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}
