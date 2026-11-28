// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A hand-built folder-trust turn gate, in the shape the server sends: every
// booted turn's gate carries the store's snapshot (index.ts folderTrustForTurn),
// and the drivers answer a saved "no" from that snapshot only (1.0.24 S03: the
// rejects-list fallback without a snapshot was removed). The snapshot is built
// by the production builder from the gate's own stored records. A gate that
// names `snapshot` itself (even as undefined) is kept as it is: the rows that
// cover the raw-records seed projection pass `snapshot: undefined`.
import { buildFolderTrustSnapshot } from "../folder-trust-index.ts";
import type { FolderTrustRecord } from "../folder-trust.ts";

type RecordsGate = { trustKeys?: readonly string[]; rejects?: ReadonlyArray<{ key: string; folder: string }>; snapshot?: unknown };

export function withTrustSnapshot<T extends RecordsGate>(gate: T): T {
  if ("snapshot" in gate) return gate;
  const records = new Map<string, FolderTrustRecord>();
  for (const key of gate.trustKeys ?? []) records.set(key, { decision: "trust", decidedAt: 0, source: "card", folder: key, consent: 2 });
  for (const reject of gate.rejects ?? []) records.set(reject.key, { decision: "reject", decidedAt: 0, source: "picker", folder: reject.folder });
  return { ...gate, snapshot: buildFolderTrustSnapshot(records) };
}
