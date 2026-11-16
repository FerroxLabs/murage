# Model list order

Owner of ordering, adapters and surface tests: models-order. Owner of catalog rows and catalog fixtures: models-fresh. Owner of the network-enabled bundled metadata refresh: MAIN.

SEAN 1114-MODEL-ORDER is implemented by `shared/model-order.ts`. It takes only an immutable model list and memoizes by list identity. Presentation adapters supply group priority, account identity and the existing favorite/selection behavior. No adapter compares model rows.

The eight presentation surfaces are the desktop/phone/web picker (one shared component), Settings provider and Flux catalogs, the backup selector, local model cards, image model choices, EngineSetup's default recommendation, the instances API and the provider catalog API. The phone app hosts the web client and has no separate model list. Engine `/model` is blocked by `server/engine-commands.ts`; channels do not render an independent model catalog.

`shared/model-order.test.ts` covers the Claude screenshot, duplicate Flux rows, generic family/version parsing, unpriced live engine order, unknown ids, stable immutable results, list memoization and 500 rows under 5 ms. `src/components/model-order.surfaces.test.ts` checks the actual rendered components against the shared function and exercises arrow-key focus on both picker layouts. `server/model-order-surfaces.test.ts` checks the registry and provider service and launches a real isolated server through `launchVerificationServer`, with its own temporary home, data directory and fake engine, to check `/api/instances` and the unchanged default.

The stale Haiku mark came from a reseller name in the bundled snapshot. Snapshot names are no longer accepted as freshness evidence; live catalog marks are checked against family siblings even across the Favorites presentation group. Flux's native/pinned routes and provider connection catalogs can describe the same id, while different bare/pinned/variant ids can resolve to the same metadata name. Ordering deduplicates ids per group, preserves the selected route, and distinguishes equal labels with concise leading variant tokens. Pinned routes and Favorites keep each billing account; native pinned routes share the sole Flux account only when there is exactly one connection. Account names lead otherwise identical model labels.

A new catalog id without published price metadata remains unpriced. It follows priced current models, or retains vendor order when most rows are unpriced, as ruling item 6 requires. Family membership never invents a price. The catalog default stays unchanged, including the Grok API default `grok-4`; the MAIN exception applies only to Grok ACP.

## English inventory

Owner: models-order owns the ordering labels and their rendering; models-fresh owns catalog names. No new control or hidden section is introduced.

| Exact English | Source / surface | Meaning |
| --- | --- | --- |
| Older versions | ModelPickerDialog, ModelsSettings, OrderedModelOptions | Quiet label before superseded versions, still visible and keyboard reachable |
| Current model: {model} | ThreadFollowControls | Saved backup selection absent from the current catalog |
| base · {model} | shared/model-order, all duplicate-label surfaces | Shared-prefix id with no variant suffix |
| direct · {model} | shared/model-order, all duplicate-label surfaces | Bare id beside a prefixed route id |

Other distinctions are the differing tokens from the actual ids (for example `thinking` or `flux pinned`) or the existing billing account name, not a new catalog or translation claim. Distinctions lead the name so truncation retains the choice. Provider catalogs in Settings show complete ids below each name, and picker search matches the ids.
