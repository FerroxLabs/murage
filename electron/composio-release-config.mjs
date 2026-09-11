// Release switches for moving connected apps from the Murage Worker broker to
// the FluxRouter-hosted broker. Both are baked into a packaged build; a
// development build ignores them (see `fluxComposioBrokerUrl` in
// managed-composio.mjs) so a dev run can never land a developer's
// connections on the production Composio project by accident.
//
// QA overrides, honoured in every build: MURAGE_FLUX_COMPOSIO_BROKER_URL and
// MURAGE_COMPOSIO_LEGACY_BROKER_UNTIL.

/** Set to "https://api.fluxrouter.ai/composio" in the release that migrates.
 * "" keeps the 0.1.52 behaviour (Worker broker only). */
export const FLUX_COMPOSIO_BROKER_URL = "";

/** ISO-8601 UTC instant after which the Worker broker is no longer used, e.g.
 * "2026-12-15T00:00:00Z". "" means no cut-off. Must match the Worker's own
 * LEGACY_BROKER_UNTIL. */
export const COMPOSIO_LEGACY_BROKER_UNTIL = "";
