import { fluxDesktopSigninOn } from "../../shared/flux-desktop-signin-default.mjs";
export interface FeatureFlagConfig {
  features?: { skillRecorder?: boolean; fluxDesktopSignin?: boolean; showToolCalls?: boolean; browser?: boolean };
}

/** Teach a skill is on unless the owner explicitly turns it off. Until the config has loaded the
 * saved switch is unknown, so the feature waits for it instead of starting before an off arrives. */
export function skillRecorderEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config != null && config.features?.skillRecorder !== false;
}

/** Recording needs the local desktop, including when the switch defaults on. */
export function skillRecorderAvailable(config: FeatureFlagConfig | null | undefined, desktop: boolean | undefined, cloud: boolean): boolean {
  return desktop === true && !cloud && skillRecorderEnabled(config);
}

/** The built-in browser is on unless explicitly disabled, once the config has loaded. Each bot also has its own switch. */
export function builtInBrowserEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config != null && config.features?.browser !== false;
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
