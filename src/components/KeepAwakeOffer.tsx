import { KEEP_AWAKE_DETAIL, KEEP_AWAKE_LABEL, keepAwakeCall, keepAwakeOffer } from "../lib/keep-awake";
import type { PhoneSetupController } from "./PhoneSetupFlow";
import { Switch } from "./SettingsPrimitives";

/** The opt-in, wherever a phone has just been, or already is, paired. */
export function KeepAwakeOffer({ c, className = "" }: { c: PhoneSetupController; className?: string }) {
  const offer = keepAwakeOffer(c.state, c.busy);
  if (!offer) return null;
  return (
    <div className={`flex items-center justify-between gap-4 text-left ${className}`}>
      <div className="min-w-0">
        <div className="text-[13px] text-ink">{KEEP_AWAKE_LABEL}</div>
        <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">{KEEP_AWAKE_DETAIL}</div>
      </div>
      <Switch
        checked={offer.checked}
        aria-label={KEEP_AWAKE_LABEL}
        disabled={offer.disabled}
        onClick={() => void c.act(keepAwakeCall(offer))}
      />
    </div>
  );
}
