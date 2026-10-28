// PostHog usage analytics: anonymous product events, and nothing that names
// the person. The phc_ token is a write-only public key (safe to ship in the
// client). Only the named events below are sent — autocapture is OFF on
// purpose: it would ship the $el_text of clicked elements, and the
// sidebar/option cards render model output and message previews, so it would
// leak fragments of private conversations to a third party.
//
// NO EMAIL, EVER (1.0.7, Sean: "no analytics, no device id"). The address a
// person gives on the first run goes to the news list only. The old
// identifyEmail(), which linked an address to a PostHog person record, had no
// caller left and was removed (upstream 8d8d22f5b), so there is no path here
// that sends a personal identifier to be rewired by mistake.
//
// The token is injected at build time and has NO default. An unconfigured
// build sends nothing at all: initAnalytics() returns before init(), so the
// library never opens a connection. The upstream fork shipped a hardcoded
// token pointing at its own project, which meant every install's events and
// every submitted email landed in someone else's account.
//
// posthog-js is about a fifth of a megabyte, so it is not part of the first
// paint (src/first-paint.test.ts): initAnalytics() imports it, and only on a
// window allowed to start it, so an opted-out install or the phone app never
// downloads it at all.
import { inNativeShell } from "./native-shell";

type PostHog = typeof import("posthog-js").default;

const TOKEN = (import.meta.env?.VITE_POSTHOG_KEY as string | undefined)?.trim() ?? "";
const API_HOST =
  (import.meta.env?.VITE_POSTHOG_HOST as string | undefined)?.trim() || "https://us.i.posthog.com";

// Analytics are on by default; Settings → General turns them off. The choice
// lives in localStorage because it has to be readable BEFORE init() runs: an
// opted-out install must never call posthog.init(), so no request — not even
// the library's own — leaves the machine. Once running, opting out routes
// through opt_out_capturing(), which also drops anything already queued.
const OPT_OUT_KEY = "murage-analytics-opt-out";

let ready = false;
/** The running client, set together with `ready`. */
let client: PostHog | null = null;
/** True while initAnalytics() waits for the library to load. */
let loading = false;

// The choice as made in THIS process, which outranks storage. Without it a
// rejected write silently loses an opt-out: the setter would swallow the
// error, the next analyticsEnabled() would read nothing and answer true, and
// a later initAnalytics() would start the client the user just switched off.
// Storage is how the choice survives a restart, not where it lives.
let choice: boolean | undefined;

/** False once the user has opted out on this machine. */
export function analyticsEnabled(): boolean {
  if (choice !== undefined) return choice;
  try {
    return localStorage.getItem(OPT_OUT_KEY) !== "1";
  } catch {
    return true; // storage unreadable → behave like a fresh install
  }
}

/** What flipping the switch has to do, given the new setting and whether the
 * client is already running. A plain function so the decision can be checked
 * without standing up an analytics client to observe. */
export type OptAction = "init" | "opt-in" | "opt-out" | "none";
export function optAction(enabled: boolean, running: boolean): OptAction {
  if (!enabled) return running ? "opt-out" : "none";
  return running ? "opt-in" : "init";
}

/** Flip the setting and act on it immediately, in both directions. */
export function setAnalyticsEnabled(enabled: boolean) {
  choice = enabled; // before persisting: the decision must not depend on it
  try {
    localStorage.setItem(OPT_OUT_KEY, enabled ? "0" : "1");
  } catch {
    /* it will not survive a restart, but it holds for this session */
  }
  switch (optAction(enabled, ready)) {
    case "opt-out":
      client?.opt_out_capturing(); // also drops whatever is still queued
      break;
    case "opt-in":
      client?.opt_in_capturing();
      break;
    case "init":
      initAnalytics(); // first opt-in of a session that started opted out
      break;
    case "none":
      break;
  }
}

/** Whether this window may start the analytics client at all. The iPhone and
 * Android apps load this same interface, and their store privacy answers say
 * the apps collect no usage analytics, so the native shell never starts it,
 * whatever the switch says. Desktop and browser keep the switch. */
export function analyticsAllowed(facts: { token: string; enabled: boolean; nativeShell: boolean }): boolean {
  return facts.token !== "" && facts.enabled && !facts.nativeShell;
}

const allowedHere = () => analyticsAllowed({ token: TOKEN, enabled: analyticsEnabled(), nativeShell: inNativeShell() });

export function initAnalytics() {
  if (ready || loading || !allowedHere()) return;
  loading = true;
  void import("posthog-js").then(
    ({ default: posthog }) => {
      loading = false;
      // The switch can be turned off while the library loads: an opt-out made
      // then must still keep init() from running.
      if (ready || !allowedHere()) return;
      start(posthog);
    },
    () => { loading = false; /* no library, no analytics; a later opt-in tries again */ },
  );
}

function start(posthog: PostHog) {
  posthog.init(TOKEN, {
    api_host: API_HOST,
    autocapture: false, // never capture clicked-element text (conversation leak)
    capture_pageview: false, // single-window desktop app — no page routes
    person_profiles: "identified_only",
    persistence: "localStorage",
  });
  // opt_out_capturing() persists in PostHog's own storage, so after
  // opt-out → restart → opt-in the client would boot opted out and drop
  // every capture below while the switch says on. Clear the stale flag
  // before the first capture of the session.
  if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing();
  client = posthog;
  ready = true;
  const platform = navigator.userAgent.includes("Electron") ? "desktop" : "browser";
  // one-time install marker — app_first_open counts installs (the closest
  // truth to "downloads that mattered"; raw download counts live on the
  // GitHub release assets)
  if (!localStorage.getItem("murage-installed")) {
    localStorage.setItem("murage-installed", new Date().toISOString());
    posthog.capture("app_first_open", { platform });
  }
  posthog.capture("app_opened", { platform });
}

export function track(event: string, props?: Record<string, unknown>) {
  if (!ready || !analyticsEnabled()) return;
  client?.capture(event, props);
}

// first-run email gate state
const GATE_KEY = "murage-email-gate";
export function emailGateDone(): boolean {
  return Boolean(localStorage.getItem(GATE_KEY));
}
export function setEmailGateDone(status: "submitted" | "skipped") {
  localStorage.setItem(GATE_KEY, status);
}
