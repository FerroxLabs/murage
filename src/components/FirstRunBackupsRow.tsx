// PARKED, PENDING THE OWNER'S DECISION (W16, 0.1.58).
//
// The closing card it rode on is not a step any more, so neither is this.
// THIS ONE MATTERS MOST OF THE FIVE: there is a standing rule that setup must
// end VERIFIED, because configured is not protected and a backup has to
// actually run and verify before setup is done. Dropping it quietly weakens
// that rule, so it is not being dropped quietly. It is parked, in the open,
// on the morning list.
//
// Nothing renders this today: server/setup-conversation.ts never emits the
// `next` variant that holds it, and `setup-conversation.test.ts` proves no
// parked variant is planned from any state this flow can reach. It stays in
// the tree, compiling and untouched otherwise, and its step calls point at
// PARKED_CARD_STEP rather than at a step that no longer exists. Whether it moves to another surface, returns later in the
// flow, or goes, is the owner's call and it has not been taken. Deleting
// tested work on a guess is how you lose a week.
//
// The backups line on the closing card, and the press behind it.
//
// This exists because the line above it used to be a lie. The closing card
// said backups were already running quietly in the background; nothing in the
// first run had turned them on, and nothing could have, because turning them
// on chooses a folder on this computer and writes a recovery key, and Murage
// asks before it does either. That consent is not red tape: a backup nobody
// agreed to, in a folder nobody chose, with a key nobody kept, is not a
// backup. It is a surprise.
//
// So the smart default stands, and the honesty stands with it. The whole
// thing is ONE press. Everything after the press is the same sequence
// Settings runs, `completeBackupSetup`, which chooses the folder, writes the
// key, turns the daily schedule on at the default time AND TAKES THE FIRST
// BACKUP. That last step is the release's rule in miniature: configured is
// not protected, and this row must never say "backed up" about a schedule
// with nothing behind it.
//
// 1.0.3 (Settings L5): a local backup is ON BY DEFAULT from the first run.
// There is no longer a button to press: the row sets backups up by itself,
// takes the first one and reports "verified" only when that backup has been
// checked (ensureFirstRunBackup). The recovery key note stays on screen with
// it. Off-site copies stay a choice, made in Settings under Backups.
//
// Settings L5 fix: the desktop decides whether this data folder may set
// backups up without asking, and it records how this step ended. A card
// reopened after "Keep backups off", or after a checked backup, shows that
// ending and touches nothing.

import { useCallback, useEffect, useRef, useState } from "react";

import { FIRST_RUN_BACKUP_COPY, ensureFirstRunBackup, type BackupScheduleBridge, type FirstRunBackupResult } from "./backups-section-ui";
import { FIRST_RUN_CHIP, FIRST_RUN_FOCUS, FirstRunFailure, FirstRunLine } from "./FirstRunChrome";
import { t } from "@/lib/i18n";

/** No window at all is the server-render and unit-test case, and it answers
 *  the same as a browser with no desktop bridge: we cannot see this machine's
 *  backups, so we say nothing about them. */
function bridge(): BackupScheduleBridge | null {
  if (typeof window === "undefined") return null;
  const desktop = window.muragebox?.backupSchedule;
  return desktop ? (desktop as BackupScheduleBridge) : null;
}

export function FirstRunBackupsRow() {
  const [result, setResult] = useState<FirstRunBackupResult | "working" | "idle">("idle");
  const [keyName, setKeyName] = useState("");
  // Why the first backup is not confirmed yet, in the words the page uses.
  const [why, setWhy] = useState("");
  const mounted = useRef(true);

  const run = useCallback(() => {
    const host = bridge();
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
  const keepOff = useCallback(() => {
    const host = bridge();
    if (!host?.finishFirstRun) return;
    setResult("working");
    void host.finishFirstRun("off").then(
      () => { if (mounted.current) { setWhy(""); setResult("off"); } },
      () => { if (mounted.current) { setWhy(t("settings.l5.firstRun.offFailed")); setResult("unverified"); } },
    );
  }, []);

  // Unavailable and idle say nothing: a first run is not the place to explain
  // that a status call failed.
  if (result === "idle" || result === "unavailable") return null;
  const offButton = bridge()?.finishFirstRun
    ? <button type="button" onClick={keepOff} className={`${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS}`}>{t("settings.l5.firstRun.keepOff")}</button>
    : null;
  const tryAgain = (
    <div className="mt-2 flex flex-wrap gap-2">
      <button type="button" onClick={run} className={`${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS}`}>{FIRST_RUN_BACKUP_COPY.tryAgain}</button>
      {offButton}
    </div>
  );
  return (
    <div className="mt-3">
      {result === "working" && <FirstRunLine quiet>{FIRST_RUN_BACKUP_COPY.working}</FirstRunLine>}
      {result === "verified" && <FirstRunLine quiet>{FIRST_RUN_BACKUP_COPY.verified}</FirstRunLine>}
      {result === "unverified" && <><FirstRunFailure message={why || FIRST_RUN_BACKUP_COPY.unverified} />{tryAgain}</>}
      {result === "cancelled" && <><FirstRunLine quiet>{FIRST_RUN_BACKUP_COPY.cancelled}</FirstRunLine>{tryAgain}</>}
      {result === "off" && <FirstRunLine quiet>{t("settings.l5.firstRun.off")}</FirstRunLine>}
      {result === "unsupported" && <><FirstRunFailure message={t("settings.l5.firstRun.unsupported")} />{tryAgain}</>}
      {result === "not-first-run" && <><FirstRunLine quiet>{t("settings.l5.firstRun.inSettings")}</FirstRunLine>{offButton && <div className="mt-2">{offButton}</div>}</>}
      {keyName && <FirstRunLine quiet>{FIRST_RUN_BACKUP_COPY.keptKey}</FirstRunLine>}
    </div>
  );
}
