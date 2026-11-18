// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test-process-only preload for a spawned server child (node --import <this file>), design1019-approval-attention W33 H.
// It installs a sink the server hands its read-only approval-attention counts reader to (server/index.ts does so only
// when NODE_ENV is "test"), and writes those counts to the file MURAGE_TEST_ATTENTION_STATS names, so a test can read
// the retained scope/card/request/wait/hold counts of an isolated server from outside the process. No HTTP route.
//
// W10 H: it also returns a hold the server awaits right after an engine card's real presentation returned. While the file
// MURAGE_TEST_PRESENT_HOLD names exists, the next presentation claims it (renames it to <file>.held) and waits until the
// test deletes <file>.held; it then writes <file>.released. Every other presentation passes straight through.
import { existsSync, renameSync, writeFileSync } from "node:fs";

const file = process.env.MURAGE_TEST_ATTENTION_STATS;
const holdFile = process.env.MURAGE_TEST_PRESENT_HOLD;
const presented = async () => {
  if (!holdFile) return;
  try { renameSync(holdFile, `${holdFile}.held`); } catch { return; }
  while (existsSync(`${holdFile}.held`)) await new Promise(resolve => setTimeout(resolve, 20));
  writeFileSync(`${holdFile}.released`, String(Date.now()));
};
globalThis[Symbol.for("murage.approvalAttention.testProbe")] = (stats) => {
  if (!file) return { presented };
  let seq = 0;
  const timer = setInterval(() => {
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify({ seq: ++seq, at: Date.now(), ...stats() }));
      renameSync(`${file}.tmp`, file);
    } catch { /* the next tick writes again */ }
  }, 40);
  timer.unref();
  return { presented };
};
