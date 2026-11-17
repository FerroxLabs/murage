// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Small helpers the page files of 1.0.19 share (pages 1 to 7). Not shell code: the shell's contract is
// settings-page-contract.ts; this only says what a card shows when this device cannot show its controls.
import type { ReactNode } from "react";
import { settingsCardPath, ComputerOnlyStub, SETTINGS_STUB_COPY } from "../../SettingsStub";

/** A desktop-only card: its controls on the confirmed desktop, the "set this on your computer" stub on a phone or paired
 *  browser, one neutral line while the surface is not answered. Never null (LOCKED 2.3). */
export function deviceGate(desktop: boolean | undefined, anchor: string, node: () => ReactNode): ReactNode {
  if (desktop === true) return node();
  if (desktop === false) return <ComputerOnlyStub anchor={anchor} />;
  const title = settingsCardPath(anchor)?.title ?? "";
  return <p role="status" className="text-[13px] text-ink-secondary">{SETTINGS_STUB_COPY.checking(title)}</p>;
}

export const stub = (anchor: string): ReactNode => <ComputerOnlyStub anchor={anchor} />;
