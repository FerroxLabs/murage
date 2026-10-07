// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { FilesSection } from "./ChannelDetailsPanel";
import type { Group, Bot } from "@/state/store";
export default function ProjectFilesView({ group, members }: { group: Group; members: Bot[] }) {
  return <section aria-label={t("projects.files.aria")} className="min-h-0 flex-1 overflow-y-auto p-4"><FilesSection group={group} members={members} /></section>;
}
