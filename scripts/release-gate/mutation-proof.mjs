// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
export function killedMutation({ before, red, after }) {
  return before?.code === 0 && red?.code === 1 && /AssertionError|ERR_ASSERTION/.test(red?.output ?? '') && after?.code === 0;
}
