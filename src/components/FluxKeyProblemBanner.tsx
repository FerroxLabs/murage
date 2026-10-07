// SPDX-License-Identifier: AGPL-3.0-or-later
//
// THE FLUX KEY DOES NOT WORK: SAY SO, AND OFFER THE FIX.
//
// The server reports the saved Flux slot as `keyState` (server/flux-config.ts):
// `not-flux` when what is saved is not a Flux Router key at all (a web
// address, a short value, another provider's key), and `refused` when Flux
// Router answered 401 or 403 to it. Without this line the owner would only
// see Flux models go quiet. (A refused key is still sent on turns, so the copy
// says Flux refused it, never that Murage stopped using it.)
import { KeyRound } from "lucide-react";

import { t } from "@/lib/i18n";
import { useStore, type ConfigStatus } from "@/state/store";

export function fluxKeyProblemNotice(flux: ConfigStatus["flux"] | undefined): string | null {
  if (flux?.keyState === "refused") return t("fluxKeyBanner.refused");
  if (flux?.keyState === "not-flux") return t("fluxKeyBanner.notFlux");
  return null;
}

export function FluxKeyProblemBanner() {
  const { state, dispatch } = useStore();
  const text = fluxKeyProblemNotice(state.config?.flux);
  if (!text) return null;
  return (
    <div role="status" aria-live="polite" className="flex flex-wrap items-center justify-center gap-2 bg-raised px-4 py-2 text-[13px] font-medium text-ink">
      <KeyRound size={14} className="shrink-0" aria-hidden="true" />
      <span>{text}</span>
      <button
        type="button"
        onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "models" })}
        className="min-h-9 rounded-lg bg-control px-3 py-1 text-[13px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {t("fluxKeyBanner.fix")}
      </button>
    </div>
  );
}
