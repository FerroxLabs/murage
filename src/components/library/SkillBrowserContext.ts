// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createContext } from "react";

// Browser owns selection/navigation; detail reports IDs and guards drafts without changing onChanged().
export const SkillBrowserContext = createContext<{
  selectChangedSkill(id: string, fromId: string): void;
  beforeNavigate: { current: ((leave: () => void) => void) | null };
} | null>(null);
