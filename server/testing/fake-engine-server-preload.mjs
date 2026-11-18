// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Imported explicitly by fake-engine fixtures; never loaded by the application.
// No shipped cage or native exclusion addon exists in the fixture container.
import { fileURLToPath } from 'node:url';
process.env.NODE_ENV = 'test';
globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
process.env.MURAGE_ENGINE_EXCLUSION_PATH ??= fileURLToPath(new URL('./engine-exclusion-stub.cjs', import.meta.url));
