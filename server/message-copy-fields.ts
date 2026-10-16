// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The SQL condition the copy-chain memo (server/partition-sources.ts) and the replay lineage memo (server/memory/replay-lineage.ts) are
// invalidated by: a stored message's copy link or withheld mark changed. Only these two fields decide either verdict, so a reply link, a
// recipient or any other field written to a copy row keeps every verdict. A text that is not JSON counts as a change.
export const copyFieldsChanged = (before: string, after: string): string =>
  `(${before} IS NOT ${after} AND (instr(${before},'withheldFromBots')>0 OR instr(${after},'withheldFromBots')>0 OR instr(${before},'copyOf')>0 OR instr(${after},'copyOf')>0)
   AND CASE WHEN json_valid(${before}) AND json_valid(${after})
     THEN json_extract(${before},'$.copyOf') IS NOT json_extract(${after},'$.copyOf') OR json_extract(${before},'$.withheldFromBots') IS NOT json_extract(${after},'$.withheldFromBots')
     ELSE 1 END)`;
