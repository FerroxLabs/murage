// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The first-run backup step itself, kept in the always-loaded code. The
// closing card calls this hook, so the step starts the moment the card
// mounts, from code that is already there: no chunk has to arrive first, and
// a card that goes away early still leaves the step running. Only the row
// that reports it (FirstRunBackupsRow) loads on first use.
import { useCallback, useEffect, useRef, useState } from "react";

import { FIRST_RUN_BACKUP_COPY, ensureFirstRunBackup, type BackupScheduleBridge, type FirstRunBackupResult } from "./backups-section-ui";
import { t } from "@/lib/i18n";

/** No window at all is the server-render and unit-test case, and it answers
 *  the same as a browser with no desktop bridge: we cannot see this machine's
 *  backups, so we say nothing about them. */
export function firstRunBackupBridge(): BackupScheduleBridge | null {
  if (typeof window === "undefined") return null;
  const desktop = window.muragebox?.backupSchedule;
  return desktop ? (desktop as BackupScheduleBridge) : null;
}

export type FirstRunBackupRowResult = FirstRunBackupResult | "working" | "idle";

export interface FirstRunBackupRun {
  result: FirstRunBackupRowResult;
  /** The recovery key made for this backup, when one was. */
  keyName: string;
  /** Why the first backup is not confirmed yet, in the words the page uses. */
  why: string;
  run: () => void;
  /** Present only when the desktop can record "Keep backups off". */
  keepOff: (() => void) | null;
}

export function useFirstRunBackupRun(): FirstRunBackupRun {
  const [result, setResult] = useState<FirstRunBackupRowResult>("idle");
  const [keyName, setKeyName] = useState("");
  const [why, setWhy] = useState("");
  const mounted = useRef(true);

  const run = useCallback(() => {
    const host = firstRunBackupBridge();
    if (!host) return;
    setResult("working");
    setWhy("");
    void (async () => {
      let reason = "";
      try {
        const outcome = await ensureFirstRunBackup(host, {
          applyStatus: () => {},
          createdKey: (note) => { if (mounted.current) setKeyName(note.label); },
          notice: () => {},
        }, { reason: (text) => { reason = text; } });
        if (!mounted.current) return;
        setWhy(outcome === "unverified" ? reason : "");
        setResult(outcome);
      } catch {
        if (mounted.current) { setWhy(FIRST_RUN_BACKUP_COPY.failed); setResult("unverified"); }
      }
    })();
  }, []);

  useEffect(() => {
    mounted.current = true;
    run();
    return () => { mounted.current = false; };
  }, [run]);

  // The person's own choice, recorded by the desktop, so setup ends saying so.
  const keepOffNow = useCallback(() => {
    const host = firstRunBackupBridge();
    if (!host?.finishFirstRun) return;
    setResult("working");
    void host.finishFirstRun("off").then(
      () => { if (mounted.current) { setWhy(""); setResult("off"); } },
      () => { if (mounted.current) { setWhy(t("settings.l5.firstRun.offFailed")); setResult("unverified"); } },
    );
  }, []);

  return { result, keyName, why, run, keepOff: firstRunBackupBridge()?.finishFirstRun ? keepOffNow : null };
}
