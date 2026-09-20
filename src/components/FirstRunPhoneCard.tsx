// CARD NINE: put me in your pocket, or the honest version of it.
//
// THE HARD RULE THIS CARD EXISTS FOR: pairing runs over Tailscale, and a
// machine without it cannot hand a phone an address that resolves. So there
// is never a QR code on such a machine and never a button that would do
// nothing. The Chief offers to set Tailscale up instead, right here, one
// step at a time.
//
// The variant on the wire is a hint and nothing more. Tailscale is found by
// the Electron main process and the server cannot see it (shared/setup.ts
// says so beside `SetupPhoneReading`), so this card asks the desktop bridge
// itself and renders what the answer actually supports.
//
// No pairing is reimplemented here. `preparePhonePairingRoute` decides what
// has to be started and re-read, `companionBrowserLink` builds the address,
// and the QR is the same `QRCodeSVG` the phone pane draws.

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { FIRST_RUN_COPY, TAILSCALE_DOWNLOAD_URL } from "@/lib/first-run-copy";
import { firstRunPhoneVariant, firstRunTailscaleStep } from "@/lib/first-run-phone";
import { preparePhonePairingRoute } from "@/lib/phone-setup";
import { useDesktopSurface } from "@/lib/use-surface";
import { companionBrowserLink } from "@/lib/companion-pairing";
import {
  companionBridge,
  companionDoorUrl,
  typedCodeInstruction,
  type CompanionState,
} from "./PhoneSetupFlow";
import {
  FIRST_RUN_CHIP,
  FIRST_RUN_FOCUS,
  FIRST_RUN_QUIET,
  FirstRunBubble,
  FirstRunFailure,
  FirstRunLine,
  failureText,
  openOutside,
  skipSetupStep,
} from "./FirstRunChrome";

const copy = FIRST_RUN_COPY.phone.phone;
const walk = FIRST_RUN_COPY.phone["phone-needs-tailscale"];

export function FirstRunPhoneCard({ settled }: { settled: boolean }) {
  const desktop = useDesktopSurface();
  const gone = useRef(false);
  const [state, setState] = useState<CompanionState | null>(null);
  const [probing, setProbing] = useState(true);
  const [link, setLink] = useState("");
  const [code, setCode] = useState("");
  const [door, setDoor] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [done, setDone] = useState(settled);

  const pairable = firstRunPhoneVariant(state) === "phone";

  /** Ask the machine, rather than the card, whether pairing is possible. */
  const probe = async (): Promise<CompanionState | null> => {
    const bridge = companionBridge();
    if (!bridge) return null;
    const next = await bridge.refreshTailscale();
    if (!gone.current) {
      setState(next);
      setStep(firstRunTailscaleStep(next));
    }
    return next;
  };

  /** Only ever called once a tailnet address exists. */
  const makeCode = async (current: CompanionState) => {
    const bridge = companionBridge();
    if (!bridge) return;
    const prepared = await preparePhonePairingRoute("tailscale", current.enabled, {
      read: bridge.state,
      start: bridge.start,
      refreshTailscale: bridge.refreshTailscale,
      shouldContinue: () => !gone.current,
    });
    if (gone.current) return;
    const paired = await bridge.pairing(true);
    if (gone.current) return;
    setState(paired);
    const address = companionBrowserLink(paired.browser, paired.pairing?.token);
    // A link that could not be built is not a QR code with a shrug on it.
    if (!address) throw new Error(prepared.error || copy.failure);
    setLink(address);
    setCode(paired.pairing?.code ?? "");
    setDoor(companionDoorUrl(paired.browser));
  };

  useEffect(() => {
    gone.current = false;
    if (desktop !== true) {
      setProbing(false);
      return () => {
        gone.current = true;
      };
    }
    void (async () => {
      try {
        const next = await probe();
        if (next && firstRunPhoneVariant(next) === "phone") await makeCode(next);
      } catch (cause) {
        if (!gone.current) setFailure(failureText(cause, copy.failure));
      } finally {
        if (!gone.current) setProbing(false);
      }
    })();
    return () => {
      gone.current = true;
    };
  }, [desktop]);

  const checkAgain = async () => {
    if (busy) return;
    setBusy(true);
    setFailure("");
    try {
      const next = await probe();
      setChecked(true);
      if (next && firstRunPhoneVariant(next) === "phone") await makeCode(next);
    } catch (cause) {
      if (!gone.current) setFailure(failureText(cause, copy.failure));
    } finally {
      if (!gone.current) setBusy(false);
    }
  };

  const newCode = async () => {
    if (busy || !state) return;
    setBusy(true);
    setFailure("");
    try {
      await makeCode(state);
    } catch (cause) {
      if (!gone.current) setFailure(failureText(cause, copy.failure));
    } finally {
      if (!gone.current) setBusy(false);
    }
  };

  const notNow = async () => {
    if (busy) return;
    setFailure("");
    try {
      await skipSetupStep("routines");
      setDone(true);
    } catch (cause) {
      setFailure(failureText(cause, copy.failure));
    }
  };

  // Seen from a paired phone, this card is a picture of itself. It keeps its
  // words and loses its controls rather than offering a device pairing
  // button that writes to a machine it cannot see.
  if (desktop !== true) {
    return (
      <FirstRunBubble>
        <div className="text-[15px] font-semibold text-ink">{copy.title}</div>
        <FirstRunLine>{copy.body}</FirstRunLine>
        <FirstRunLine>{copy.second}</FirstRunLine>
      </FirstRunBubble>
    );
  }

  if (pairable) {
    const typed = typedCodeInstruction(door);
    return (
      <FirstRunBubble>
        <div className="text-[15px] font-semibold text-ink">{copy.title}</div>
        <FirstRunLine>{copy.body}</FirstRunLine>
        <FirstRunLine>{copy.second}</FirstRunLine>

        {link ? (
          <div className="mt-3 flex flex-col items-start gap-3 sm:flex-row">
            <div className="rounded-2xl bg-white p-3" aria-label={copy.title}>
              <QRCodeSVG value={link} size={148} level="M" bgColor="#ffffff" fgColor="#111111" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium uppercase tracking-wide text-ink-secondary">{copy.codeLabel}</div>
              <div className="mt-1 font-mono text-[22px] tracking-[0.25em] text-ink">{code}</div>
              <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
                {typed.lead}
                {typed.url && <span className="font-mono text-ink">{typed.url}</span>}
                {typed.tail}
              </div>
              <button type="button" disabled={busy} onClick={() => void newCode()} className={`mt-2 ${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS}`}>
                {copy.refresh}
              </button>
            </div>
          </div>
        ) : (
          <FirstRunLine quiet>{probing || busy ? copy.preparing : copy.failure}</FirstRunLine>
        )}

        <FirstRunFailure message={failure} />
      </FirstRunBubble>
    );
  }

  return (
    <FirstRunBubble>
      <div className="text-[15px] font-semibold text-ink">{walk.title}</div>
      <FirstRunLine>{walk.body}</FirstRunLine>
      <FirstRunLine>{walk.second}</FirstRunLine>

      <ol className="mt-3 grid gap-2">
        {walk.steps.map((item, index) => {
          const current = index === step;
          return (
            <li key={item.label} className={`rounded-xl px-3 py-2.5 ${current ? "bg-inset" : "opacity-60"}`}>
              <div className="text-[14px] text-ink">{item.label}</div>
              <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{item.detail}</div>
              {current && (
                <button
                  type="button"
                  disabled={busy || done}
                  onClick={() => {
                    if (index === 0) {
                      void openOutside(TAILSCALE_DOWNLOAD_URL);
                      setStep(1);
                      return;
                    }
                    if (index === 1) {
                      setStep(2);
                      return;
                    }
                    void checkAgain();
                  }}
                  className={`mt-2 ${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS}`}
                >
                  {busy && index === 2 ? walk.checking : item.action}
                </button>
              )}
            </li>
          );
        })}
      </ol>

      {checked && !pairable && !busy && <FirstRunLine quiet>{walk.stillMissing}</FirstRunLine>}
      <FirstRunFailure message={failure} />

      {!done && (
        <button type="button" disabled={busy} onClick={() => void notNow()} className={`mt-2 ${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`}>
          {walk.dismiss}
        </button>
      )}
    </FirstRunBubble>
  );
}
