// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { BOX_FRAME, BoxBody, BoxHead } from "./ui/BoxShell";
export default function ProjectBoardShell() {
  return <section aria-label="Board" className={`${BOX_FRAME} flex-1 text-[13px] text-ink-secondary`}><BoxHead className="px-4 pt-4"><h2 className="text-base font-medium text-ink">Board</h2></BoxHead><BoxBody className="px-4 pb-4 pt-2"><p>Project details are not available yet</p></BoxBody></section>;
}
