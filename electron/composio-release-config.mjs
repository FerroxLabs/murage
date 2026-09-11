// Release switches for moving connected apps from the Murage Worker broker to
// the FluxRouter-hosted broker. Both are baked into a packaged build; a
// development build ignores them (see `fluxComposioBrokerUrl` in
// managed-composio.mjs) so a dev run can never land a developer's
// connections on the production Composio project by accident.
//
// QA overrides, honoured in every build: MURAGE_FLUX_COMPOSIO_BROKER_URL and
// MURAGE_COMPOSIO_LEGACY_BROKER_UNTIL.

/** The FluxRouter-hosted broker. 0.1.52 is the release that migrates
 * (rollout step 7); "" would keep the pre-0.1.52 behaviour (Worker broker
 * only). */
export const FLUX_COMPOSIO_BROKER_URL = "https://api.fluxrouter.ai/composio";

/** ISO-8601 UTC instant after which the Worker broker is no longer used
 * (0.1.52 release + 60 days). "" means no cut-off. Must match the Worker's own
 * LEGACY_BROKER_UNTIL. */
export const COMPOSIO_LEGACY_BROKER_UNTIL = "2026-11-10T00:00:00Z";
