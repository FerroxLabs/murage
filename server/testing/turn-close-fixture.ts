// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect } from "vitest";
import type { ProviderAdapter } from "../contracts.ts";

/** Durable completion and process closure have separate receipts. Assert the
 * exact ended turn's closure before examining retired process resources. */
export async function confirmFixtureTurnClosed(adapter: ProviderAdapter, threadId: string, turnId: string): Promise<void> {
  expect(adapter.awaitTurnTeardown).toBeTypeOf("function");
  expect(await adapter.awaitTurnTeardown!(threadId, turnId)).toEqual({ closeConfirmed: true });
}
