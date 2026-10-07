// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { useEffect, useState } from "react";
import type { ProjectRead } from "./project-client";
import { projectClient } from "./use-project";

export function useProjectVisit(groupId: string, enabled: boolean) {
  const [counts, setCounts] = useState<ProjectRead["sinceYouLeft"] | null>(null);
  useEffect(() => {
    let active = true;
    setCounts(null);
    if (!enabled) return;
    void projectClient.project(groupId).then(result => {
      if (!active || !result.ok) return;
      setCounts({ ...result.data.sinceYouLeft });
      void projectClient.viewed(groupId);
    });
    return () => { active = false; };
  }, [groupId, enabled]);
  return counts;
}
