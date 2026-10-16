// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory settings (with the upgrade detail, the people and review lists) are opened by a tap, so the first paint does not carry them:
// they load the first time one is shown (src/first-paint.test.ts, the 670 KiB budget).
import { lazy, Suspense, type ComponentProps } from "react";

const Loaded = lazy(() => import("./MemorySettings").then((module) => ({ default: module.MemorySettings })));

export function MemorySettings(props: ComponentProps<typeof Loaded>) {
  return <Suspense fallback={null}><Loaded {...props} /></Suspense>;
}
