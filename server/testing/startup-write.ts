// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The owner approving an engine's write to one of their shell startup files, as the runtime events carry it to
// noteStartupFileEvent: a permission ask naming the file, then its allow.
import { noteStartupFileEvent } from "../engine-env.ts";

let seq = 0;
export function approveStartupWrite(file = "~/.zprofile"): boolean {
  const requestId = `startup-write-${++seq}`;
  noteStartupFileEvent({ type: "request.opened", requestType: "permission", threadId: "t-startup-write", requestId, filePaths: [file] } as never);
  return noteStartupFileEvent({ type: "request.resolved", threadId: "t-startup-write", requestId, behavior: "allow" });
}
