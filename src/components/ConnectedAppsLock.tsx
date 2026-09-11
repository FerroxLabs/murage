// Connected apps, locked.
//
// Until a FluxRouter key or a Composio key of the person's own exists there
// is nothing the connected-apps panel can do, and until this it said so with
// a warning line above an empty catalog. Now the panel is the offer: a
// dimmed showcase of apps people recognise, and one sentence over it that
// says what adding a key buys.
//
// Two rules the rest of the app depends on:
//   - Nothing here touches the network. The showcase is a static list — no
//     catalog call, no logo fetch, no favicon lookup — because the whole
//     point of the gate is that no request goes to the connected-apps
//     broker before a key exists. `connectedAppsLockState` is what the panel
//     asks before it fetches anything, and it reads only what
//     GET /api/config already said.
//   - The lock decides from the same facts the server's config status
//     carries (`flux.configured`, `composio.configured`), so the moment a
//     key is saved the config frame flips the panel to the normal one
//     without a reopen.
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";

/** The facts the lock reads, as GET /api/config reports them. Presence only:
 * no key ever reaches the renderer. */
export interface ConnectedAppsLockConfig {
  composio: { configured: boolean; mode?: "managed" | "self-hosted" | "unavailable" };
  flux?: { configured: boolean };
}

export type ConnectedAppsLockState = "unknown" | "locked" | "unlocked";

/** Whether the connected-apps panel is locked, from what the server already
 * told the store. Pure, so each branch is testable without a renderer.
 *
 *   unknown  — GET /api/config has not answered yet; the panel fetches
 *              nothing and paints a loading line until it has.
 *   unlocked — a FluxRouter key exists (even while its broker is not ready:
 *              the panel's own "not reachable" line owns that case), or a
 *              broker already holds the person's apps (their own Composio
 *              key, or the Murage Worker until its cut-off), or the panel is
 *              showing a remembered inventory because the credential store
 *              could not be read — that list stays visible, as it always did.
 *   locked   — no key of either kind. Nothing is fetched. */
export function connectedAppsLockState(
  config: ConnectedAppsLockConfig | null | undefined,
  options: { stale?: boolean } = {},
): ConnectedAppsLockState {
  if (!config) return "unknown";
  if (config.flux?.configured === true) return "unlocked";
  if (config.composio?.configured === true) return "unlocked";
  if (options.stale) return "unlocked";
  return "locked";
}

/** The apps behind the glass. Static on purpose: a name and a brand hue
 * each, so the showcase needs no catalog and no image request. The initials
 * stand in for logos the way the panel's own monogram fallback does. */
export const SHOWCASE_APPS: ReadonlyArray<{ label: string; hue: string }> = [
  { label: "Gmail", hue: "#ea4335" },
  { label: "Google Calendar", hue: "#4285f4" },
  { label: "Google Drive", hue: "#fbbc04" },
  { label: "Slack", hue: "#4a154b" },
  { label: "Notion", hue: "#37352f" },
  { label: "GitHub", hue: "#24292f" },
  { label: "Linear", hue: "#5e6ad2" },
  { label: "Jira", hue: "#0052cc" },
  { label: "Trello", hue: "#0079bf" },
  { label: "HubSpot", hue: "#ff7a59" },
  { label: "Salesforce", hue: "#00a1e0" },
  { label: "Stripe", hue: "#635bff" },
  { label: "Shopify", hue: "#96bf48" },
  { label: "Airtable", hue: "#fcb400" },
  { label: "Discord", hue: "#5865f2" },
  { label: "Telegram", hue: "#26a5e4" },
  { label: "X", hue: "#0f1419" },
  { label: "LinkedIn", hue: "#0a66c2" },
  { label: "YouTube", hue: "#ff0000" },
  { label: "Dropbox", hue: "#0061ff" },
  { label: "Zoom", hue: "#0b5cff" },
  { label: "Calendly", hue: "#006bff" },
  { label: "Asana", hue: "#f06a6a" },
  { label: "Todoist", hue: "#e44332" },
];

/** Where the two keys are typed, so the lock's buttons can land the cursor
 * in the field rather than at the top of a settings page. */
export const FLUX_KEY_FIELD_SELECTOR = 'input[name="flux-router-key"]:not([disabled])';
export const COMPOSIO_KEY_FIELD_SELECTOR = 'input[aria-label="Composio project key"]:not([disabled])';

/** Put the cursor in a settings field once it exists and is enabled.
 *
 * The settings dialog mounts a render after the store action that opens it,
 * and the Flux key field stays disabled until GET /api/flux-connection has
 * answered, so this waits — bounded — for the field to become usable rather
 * than focusing a control that would refuse the focus. Returns a cancel. */
export function focusSettingsField(
  selector: string,
  options: { doc?: Document; timeoutMs?: number } = {},
): () => void {
  const doc = options.doc ?? (typeof document === "undefined" ? null : document);
  if (!doc) return () => {};
  const timeoutMs = options.timeoutMs ?? 8_000;
  let done = false;
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (done) return;
    done = true;
    observer?.disconnect();
    if (timer !== null) clearTimeout(timer);
  };
  const attempt = () => {
    if (done) return;
    const field = doc.querySelector<HTMLElement>(selector);
    if (!field) return;
    stop();
    field.scrollIntoView?.({ block: "center" });
    field.focus();
  };
  attempt();
  if (done) return stop;
  if (typeof MutationObserver === "function" && doc.body) {
    observer = new MutationObserver(attempt);
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
  }
  timer = setTimeout(stop, timeoutMs);
  return stop;
}

/** One headline, one line, one button. The secondary way in is a link, not
 * a second button, so the eye lands on the one thing to do. */
export function ConnectedAppsLock({ onAddFluxKey, onOwnKey }: { onAddFluxKey: () => void; onOwnKey: () => void }) {
  return (
    <div data-connected-apps-lock="" className="relative min-h-0 flex-1 overflow-hidden px-6 pb-7 pt-5 sm:px-8">
      {/* The showcase. Hidden from assistive tech and from the tab order, and
          it takes no pointer: it is scenery, not a catalog. */}
      <div
        aria-hidden="true"
        inert
        className="pointer-events-none select-none opacity-35 blur-[1.5px]"
      >
        <div className="mb-3 text-[12px] font-medium text-ink-secondary">Available apps</div>
        <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
          {SHOWCASE_APPS.map((app) => (
            <div key={app.label} className="flex min-h-[72px] items-center gap-3 border-b border-hairline/35 px-1 py-3.5">
              <div
                className="flex size-11 shrink-0 items-center justify-center rounded-xl text-[15px] font-semibold text-white"
                style={{ background: app.hue }}
              >
                {app.label.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium text-ink">{app.label}</div>
                <div className="mt-0.5 h-3 w-2/3 rounded bg-raised" />
              </div>
              <div className="min-w-[88px] rounded-full bg-raised px-3 py-2 text-center text-[12.5px] text-ink">Connect</div>
            </div>
          ))}
        </div>
      </div>

      {/* The offer, over the glass. */}
      <div className="absolute inset-0 flex items-center justify-center p-6 sm:p-10">
        <section
          aria-labelledby="connected-apps-lock-title"
          className={cn(
            "w-full max-w-[440px] rounded-2xl border border-hairline/60 bg-panel/95 px-6 py-6 text-center shadow-2xl shadow-black/30 backdrop-blur-md sm:px-8 sm:py-7",
          )}
        >
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent/12 text-accent" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="10" width="16" height="11" rx="2.5" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </svg>
          </div>
          <h3 id="connected-apps-lock-title" className="text-[19px] font-semibold tracking-[-0.01em] text-ink">
            {t("connectedApps.lock.title")}
          </h3>
          <p className="mx-auto mt-2 max-w-[38ch] text-[13.5px] leading-relaxed text-ink-secondary">{t("connectedApps.lock.body")}</p>
          <button
            type="button"
            data-connected-apps-lock-primary=""
            onClick={onAddFluxKey}
            className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-accent px-5 py-2.5 text-[14px] font-medium text-accent-ink transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
          >
            {t("connectedApps.lock.button")}
          </button>
          <div className="mt-4">
            <button
              type="button"
              onClick={onOwnKey}
              className="rounded-sm text-[12.5px] text-ink-secondary underline underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {t("connectedApps.lock.ownKey")}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
