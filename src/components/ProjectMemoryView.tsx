// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { MemorySection } from "./ChannelDetailsPanel";
import type { Group } from "@/state/store";
export default function ProjectMemoryView({ group }: { group: Group }) {
  return <section aria-label={t("projects.memory.aria")} className="min-h-0 flex-1 overflow-y-auto p-4"><MemorySection group={group} /></section>;
}
