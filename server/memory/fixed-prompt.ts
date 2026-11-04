// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A prompt that carries no memory words (designs/MEM-LEARNING-FENCE-R6.md section 1). Only `fixedPrompt(CONST)` makes one, and its
// argument must be a module-level string constant (learning-send-boundary.test.ts). The PIP system slot, the Claude argv
// `--system-prompt` and the engine reply check take it, so learning words never ride outside the gate's release.
declare const FIXED_PROMPT: unique symbol;
export type FixedPrompt = string & { readonly [FIXED_PROMPT]: true };
export const fixedPrompt = (constant: string): FixedPrompt => constant as FixedPrompt;
