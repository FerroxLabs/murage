// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Origins for bot-record actions built by tests (BOTADDED-DESIGN-V3 r6 §2.2): a fresh HTTP answer, a stream frame, a local paint.
import type { HttpOrigin } from "./answer-tag";

export const httpNow: HttpOrigin = { source: "http", sentAt: 0, expired: false };
export const fromStream = { source: "stream" } as const;
export const fromLocal = { source: "local" } as const;
