// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pairing a phone over the local network is plain HTTP, so the sidecar's device
// door no longer listens there by default (0.1.62 audit C6). It is a choice the
// person makes in Settings, remembered next to the other companion switches,
// and this file is the whole of that decision: what the sidecar is told, and
// what the panel is told about it.

/** The bind the sidecar is launched with, or undefined to leave it on its own
 * default (the tailnet address, else this computer only). An operator's own
 * MURAGE_COMPANION_BIND always wins; the Settings choice only fills a gap. */
export function lanBindEnvironment(inherited, setting) {
  if (String(inherited?.MURAGE_COMPANION_BIND ?? "").trim()) return undefined;
  return setting === true ? "lan" : undefined;
}

/** What the panel needs to render the switch and the one-time note.
 *
 * `setting` is true or false once the person has chosen, null when they never
 * have (every install made before this release). `note` is "narrowed" for that
 * last group when phones are already paired and the door is no longer on the
 * local network: the person must hear that a phone which paired over Wi-Fi can
 * no longer reach this computer, and be offered both ways forward. It stays
 * until they choose, and never appears for anyone who has. */
export function lanPairingView({ setting, deviceDoor, deviceCount }) {
  const mode = deviceDoor?.mode ?? null;
  const chosen = setting === true || setting === false;
  const on = setting === true || mode === "lan";
  const note = !chosen && !on && Number(deviceCount) > 0 && mode !== null ? "narrowed" : null;
  return { on, chosen, mode, unencrypted: on, note };
}
