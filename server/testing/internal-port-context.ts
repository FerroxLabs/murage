// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture owner: sc-safety; production policy owners: extracted index functions.
import type { DatabaseSync } from "node:sqlite";
import type { StatePort } from "./source-extract.ts";
import type { Store } from "../store.ts";
import type { InternalCapabilities } from "../internal-capabilities.ts";
export interface InternalPortContext {
  store: Store;
  dataDir: string;
  database: () => DatabaseSync;
  capabilities: InternalCapabilities;
  state: Map<string, unknown>;
  /** Virtual hosted-computer HTTP, retaining all real relay admission. */
  boxFetch?: typeof fetch;
  port(name: string): StatePort;
  /** Register a real production function dependency. The binder includes and
   * validates it before returning the fixture; callbacks never grant policy. */
  value<T>(name: string): () => T;
  production<T extends (...args: any[]) => any>(name: string): T;
}
