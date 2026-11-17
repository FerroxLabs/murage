// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { onTestFinished } from "vitest";
import type { SendTurnInput } from "../contracts.ts";
import { releaseTransaction } from "../memory/release-transaction.ts";

/** A native, non-consuming writer still owns a real synchronous transaction.
 * Run the adapter's final validation inside it before observing the write. */
export function nativeFixtureWrite(observe: <T>(write: () => T) => T): NonNullable<SendTurnInput["fencedWrite"]> {
  const db = new DatabaseSync(":memory:");
  onTestFinished(() => db.close());
  return (write, validate) => releaseTransaction(db, { validate, emit: () => observe(write) });
}
