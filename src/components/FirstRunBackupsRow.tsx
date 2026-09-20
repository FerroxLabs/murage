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
// On a computer where backups are already running, this is one quiet line and
// no button at all.

import { useEffect, useRef, useState } from "react";

import { FIRST_RUN_COPY } from "@/lib/first-run-copy";
import {
  FIRST_RUN_CHIP,
  FIRST_RUN_FOCUS,
  FirstRunFailure,
  FirstRunLine,
} from "./FirstRunChrome";
import { completeBackupSetup, type BackupScheduleBridge } from "./backups-section-ui";

const copy = FIRST_RUN_COPY.backups;

/** What this computer can say about its backups right now. `unknown` renders
 *  nothing: a first run is not the place to explain that a status call
 *  failed, and silence is the honest answer to "we could not ask". */
type Standing = "unknown" | "on" | "off";

/** No window at all is the server-render and unit-test case, and it answers
 *  the same as a browser with no desktop bridge: we cannot see this machine's
 *  backups, so we say nothing about them. */
function bridge(): BackupScheduleBridge | null {
  if (typeof window === "undefined") return null;
  const desktop = window.muragebox?.backupSchedule;
  return desktop ? (desktop as BackupScheduleBridge) : null;
}

/**
 * Running means running: a schedule that is on AND has the folder and key
 * behind it. `enabled` alone has been true on installs whose references were
 * never chosen, which is exactly the state this row must not describe as
 * done.
 */
function standingFrom(status: unknown): Standing {
  if (!status || typeof status !== "object") return "unknown";
  const value = status as { supported?: unknown; enabled?: unknown; refs?: unknown };
  if (value.supported === false) return "unknown";
  return value.enabled === true && value.refs ? "on" : "off";
}

export function FirstRunBackupsRow() {
  const [standing, setStanding] = useState<Standing>("unknown");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [keyName, setKeyName] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const host = bridge();
    if (!host) return () => { mounted.current = false; };
    void (async () => {
      try {
        const status = await host.status();
        if (mounted.current) setStanding(standingFrom(status));
      } catch {
        // Unknown stays unknown, and unknown says nothing.
      }
    })();
    return () => { mounted.current = false; };
  }, []);

  const turnOn = () => {
    const host = bridge();
    if (!host || busy) return;
    setBusy(true);
    setFailure("");
    setNotice("");
    void (async () => {
      try {
        const outcome = await completeBackupSetup(host, undefined, {
          // The status the sequence reports back is what decides the line, so
          // the row can never get ahead of what actually happened.
          applyStatus: (next) => { if (mounted.current) setStanding(standingFrom(next)); },
          createdKey: (note) => { if (mounted.current) setKeyName(note.label); },
          // Settings' own running commentary is written for Settings, and
          // some of it carries punctuation this flow does not use. The three
          // outcomes that matter are worded here instead.
          notice: () => {},
        });
        if (!mounted.current) return;
        if (outcome.state === "capturing") setNotice(copy.capturing);
        else if (outcome.state === "cancelled") setNotice(copy.cancelled);
        else setNotice(copy.unfinished);
      } catch {
        if (mounted.current) setFailure(copy.failure);
      } finally {
        if (mounted.current) setBusy(false);
      }
    })();
  };

  if (!bridge() || standing === "unknown") return null;
  if (standing === "on" && !notice) return <FirstRunLine quiet>{copy.on}</FirstRunLine>;

  return (
    <div className="mt-3">
      {standing === "on" ? (
        <FirstRunLine quiet>{copy.on}</FirstRunLine>
      ) : (
        <>
          <FirstRunLine quiet>{copy.offer}</FirstRunLine>
          <FirstRunLine quiet>{copy.offerSecond}</FirstRunLine>
          <div className="mt-2">
            <button
              type="button"
              disabled={busy}
              onClick={turnOn}
              className={`${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS}`}
            >
              {busy ? copy.working : copy.turnOn}
            </button>
          </div>
        </>
      )}
      {notice && <FirstRunLine quiet>{notice}</FirstRunLine>}
      {keyName && <FirstRunLine quiet>{copy.keptKey}</FirstRunLine>}
      {failure && <FirstRunFailure message={failure} />}
    </div>
  );
}
