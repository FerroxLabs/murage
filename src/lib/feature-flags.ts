import { fluxDesktopSigninOn } from "../../shared/flux-desktop-signin-default.mjs";
export interface FeatureFlagConfig {
  features?: { skillRecorder?: boolean; fluxDesktopSignin?: boolean; showToolCalls?: boolean; browser?: boolean };
}

/** Experimental features are available only after an explicit opt-in. */
export function skillRecorderEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.skillRecorder === true;
}

/** The experimental built-in browser is unavailable until the person using
 * the app explicitly opts in. Each bot also has its own switch. */
export function builtInBrowserEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.browser === true;
}

/** Tool-run chips in the transcript. Off by default — the mascot already
 * shows that work is happening. */
export function showToolCallsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.showToolCalls === true;
}

/** The desktop "Sign in with Flux" button. Off by default; the paste-a-key path is unchanged either way. */
export function fluxDesktopSigninEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return fluxDesktopSigninOn(config?.features);
}
