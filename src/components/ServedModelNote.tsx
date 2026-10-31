// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { servedModelLine, type ServedModel } from "@/lib/served-model";

/** One quiet line under a bot reply that Flux Router answered with another model than the one picked. Nothing otherwise. */
export function ServedModelNote({ served }: { served?: ServedModel | null }) {
  const line = servedModelLine(served);
  if (!line) return null;
  return <div className="mt-1 text-[11px] text-ink-secondary/70" data-testid="served-model-note">{line}</div>;
}
