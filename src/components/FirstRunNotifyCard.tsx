// FIRSTRUN-1019 1.10: hosts NOTIFY S5's NotifyChooser. The chooser draws its own heading, rows and buttons and saves
// itself; this card only mounts it and settles the card (POST /api/setup/card) once it reports done. If the chooser has
// nothing to ask (an upgrade, the web, a chooser already done or kept inside) the card settles itself on mount.

import { useEffect, useRef, useState } from "react";

import { FIRST_RUN_COPY } from "@/lib/first-run-copy";
import { shouldShowNotifyChooser } from "@/lib/notify-surfaces";
import { NotifyChooser } from "./NotifyChooser";
import { FIRST_RUN_CHIP, FIRST_RUN_FOCUS, FirstRunBubble, FirstRunFailure, FirstRunLine, settleSetupCard } from "./FirstRunChrome";

const copy = FIRST_RUN_COPY.notify;

export function FirstRunNotifyCard({ settled }: { settled: boolean }) {
  // Shown at once (the chooser has the floor until it says otherwise), so the card is never an empty frame; where it has
  // nothing to ask it is withdrawn and the card settles itself.
  const [show, setShow] = useState<boolean>(!settled);
  const [failure, setFailure] = useState("");
  const [saved, setSaved] = useState(false);
  const settling = useRef(false);

  // A failed settle after a good save retries the settle only: the chooser already saved and is not asked again.
  const settle = async () => {
    if (settling.current) return;
    settling.current = true;
    try {
      await settleSetupCard("flux:notify");
      setFailure("");
    } catch {
      setFailure(copy.failure);
    } finally {
      settling.current = false;
    }
  };

  useEffect(() => {
    if (settled) return;
    let live = true;
    void shouldShowNotifyChooser()
      .then((yes) => {
        if (!live) return;
        setShow(yes);
        if (!yes) void settle();
      })
      .catch(() => {
        if (live) setShow(true);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);

  if (settled) {
    return (
      <FirstRunBubble>
        <FirstRunLine quiet>{copy.settled}</FirstRunLine>
      </FirstRunBubble>
    );
  }
  if (!show) {
    // Nothing to ask here, so the card settles itself; if that fails it says so and offers the retry (the settle only).
    return (
      <FirstRunBubble>
        {failure ? (
          <>
            <FirstRunFailure message={failure} />
            <button type="button" className={`mt-2 ${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS}`} onClick={() => void settle()}>{copy.retry}</button>
          </>
        ) : (
          <FirstRunLine quiet>{copy.settled}</FirstRunLine>
        )}
      </FirstRunBubble>
    );
  }
  return (
    <div className="w-full min-w-0" data-first-run="notify">
      {!saved && (
        <NotifyChooser
          onDone={() => {
            setSaved(true);
            void settle();
          }}
          onError={(message) => setFailure(message || copy.failure)}
        />
      )}
      <FirstRunFailure message={failure} />
      {saved && failure && (
        <button type="button" className={`mt-2 ${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS}`} onClick={() => void settle()}>{copy.retry}</button>
      )}
    </div>
  );
}
