// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The first-run phone card loads on first use: its QR code and pairing flow
// stay out of first paint. Its title shows while the chunk loads, so no card
// in this flow is ever blank, and a failed load stays inside the card.
import { Suspense, type ComponentProps } from "react";

import { LazyBoundary, retryableLazy } from "@/components/LazyBoundary";
import { FIRST_RUN_COPY } from "@/lib/first-run-copy";
import type { FirstRunPhoneCard as PhoneCard } from "./FirstRunPhoneCard";

const Chunk = retryableLazy(() => import("./FirstRunPhoneCard").then((module) => ({ default: module.FirstRunPhoneCard })));

export function LazyFirstRunPhoneCard(props: ComponentProps<typeof PhoneCard>) {
  return (
    <LazyBoundary inline onRetry={Chunk.retry}>
      <Suspense fallback={<div className="text-[15px] font-semibold text-ink">{FIRST_RUN_COPY.phone.phone.title}</div>}>
        <Chunk.Component {...props} />
      </Suspense>
    </LazyBoundary>
  );
}
