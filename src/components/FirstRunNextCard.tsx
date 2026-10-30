// CARD SIX: DONE (UX-FIRSTRUN-SCALE-1012 §1.8).
//
// The server emits this card once `flow` is done or passed over
// (server/setup-conversation.ts, `plan("flow", "next")`), so it is the last
// thing the Chief says in the first run. It was a menu of eight phrases; 1.0.12
// makes it three rows, each one sentence and one button, under the Chief's
// line "That is you set up."
//
//   Put me to work            [Start]        focuses the message box
//   Hire your first teammate  [Hire a bot]   says so to the Chief, who sets it up
//   Reach me from your phone  [...]          the phone card, opened on a press
//
// THE PHONE ROW NEVER STARTS PHONE ACCESS BY ITSELF. Making a pairing code
// switches on this computer's phone door, so the QR appears only after the
// owner presses for it; the row's words come from a read-only Tailscale
// probe, so a machine without Tailscale is offered the walkthrough instead
// of a Wi-Fi question.
//
// Backups stay on this card (FirstRunBackupsRow). Setup ends verified, and
// `view.complete` waits for the backup step, so the one press for it lives
// where the first run ends.

import { useEffect, useState } from "react";

import { FIRST_RUN_COPY } from "@/lib/first-run-copy";
import { composeIo } from "@/lib/compose-link";
import { firstRunPhoneVariant } from "@/lib/first-run-phone";
import { useDesktopSurface } from "@/lib/use-surface";
import { useStore, type Bot } from "@/state/store";
import {
  FIRST_RUN_CHIP,
  FIRST_RUN_FOCUS,
  FIRST_RUN_PRIMARY,
  FirstRunBubble,
  FirstRunLine,
} from "./FirstRunChrome";
import { FirstRunBackupsRow } from "./FirstRunBackupsRow";
import { FirstRunPhoneCard } from "./FirstRunPhoneCard";
import { companionBridge } from "./PhoneSetupFlow";

const copy = FIRST_RUN_COPY.routines.done;

function DoneRow({ title, line, button, onPress, primary = false, disabled = false }: {
  title: string;
  line: string;
  button: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hairline/40 bg-inset px-3 py-2.5">
      <span className="min-w-0">
        <span className="block text-[14px] font-medium text-ink">{title}</span>
        <span className="block text-[12.5px] leading-relaxed text-ink-secondary">{line}</span>
      </span>
      <button
        type="button"
        disabled={disabled}
        onClick={onPress}
        className={`${primary ? FIRST_RUN_PRIMARY : FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS} shrink-0`}
      >
        {button}
      </button>
    </li>
  );
}

export function FirstRunNextCard({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const desktop = useDesktopSurface();
  const [hired, setHired] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  // null until the read-only probe answers; then whether a code can be made.
  const [pairable, setPairable] = useState<boolean | null>(null);

  useEffect(() => {
    if (desktop !== true) return;
    let gone = false;
    const bridge = companionBridge();
    if (!bridge) {
      setPairable(false);
      return;
    }
    // bridge.state() only READS the sidecar. refreshTailscale() would start
    // the companion (and the managed route) when it is off, which is phone
    // access switched on by a card nobody pressed. An off sidecar has no
    // tailnet name, so it honestly reads as "walkthrough".
    void bridge.state().then(
      (state) => { if (!gone) setPairable(firstRunPhoneVariant(state) === "phone"); },
      () => { if (!gone) setPairable(false); },
    );
    return () => {
      gone = true;
    };
  }, [desktop]);

  const hire = () => {
    if (hired) return;
    setHired(true);
    // The ordinary send, in the owner's voice: the Chief sets the teammate up
    // for their yes. The one-sentence Hire sheet replaces this in 1.0.13.
    dispatch({ type: "send", botId: bot.id, text: copy.hire.say, threadId: bot.threadId });
  };

  const phone = pairable === false ? copy.phoneNeeds : null;

  return (
    <FirstRunBubble>
      <FirstRunLine>{copy.chief}</FirstRunLine>
      <ul className="mt-3 grid gap-2">
        <DoneRow
          title={copy.work.title}
          line={copy.work.line}
          button={copy.work.button}
          primary
          onPress={() => composeIo.focus(bot.id)}
        />
        <DoneRow title={copy.hire.title} line={copy.hire.line} button={copy.hire.button} disabled={hired} onPress={hire} />
        {desktop === true && pairable !== null && !phoneOpen && (
          <DoneRow
            title={phone ? phone.title : copy.phone.title}
            line={phone ? phone.line : copy.phone.line}
            button={phone ? phone.button : copy.phone.button}
            onPress={() => setPhoneOpen(true)}
          />
        )}
      </ul>
      {phoneOpen && (
        <div className="mt-3">
          {/* Live, but its "Not now" only closes the row: the parked card's
              own "Not now" would write a step this card does not own. */}
          <FirstRunPhoneCard settled={false} onClose={() => setPhoneOpen(false)} />
        </div>
      )}

      {/* Backups are a smart default, and one press. The row reads the real
          schedule before it says anything. */}
      <FirstRunBackupsRow />
    </FirstRunBubble>
  );
}
