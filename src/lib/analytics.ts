// PostHog usage analytics + the email → person identity link.
// The phc_ token is a write-only public key (safe to ship in the client).
// Autocapture gives clicks/inputs for free; the named events below are the
// product funnel. Email submissions call identify(), so PostHog's Persons
// tab doubles as the collected-email list.
import posthog from "posthog-js";

const TOKEN = "phc_m2hP39w8y2gLPvHgDvSXAu6xcZ3agjf4ruL56rGcMZEe";

let ready = false;

export function initAnalytics() {
  if (ready) return;
  posthog.init(TOKEN, {
    api_host: "https://us.i.posthog.com",
    autocapture: true,
    capture_pageview: false, // single-window desktop app — no page routes
    person_profiles: "identified_only",
    persistence: "localStorage",
  });
  ready = true;
  posthog.capture("app_opened", {
    platform: navigator.userAgent.includes("Electron") ? "desktop" : "browser",
  });
}

export function track(event: string, props?: Record<string, unknown>) {
  if (!ready) return;
  posthog.capture(event, props);
}

export function identifyEmail(email: string) {
  if (!ready) return;
  posthog.identify(email, { email });
  posthog.capture("email_submitted");
}

// first-run email gate state
const GATE_KEY = "omb-email-gate";
export function emailGateDone(): boolean {
  return Boolean(localStorage.getItem(GATE_KEY));
}
export function setEmailGateDone(status: "submitted" | "skipped") {
  localStorage.setItem(GATE_KEY, status);
}
