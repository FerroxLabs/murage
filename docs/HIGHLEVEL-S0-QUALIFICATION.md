# HighLevel S0 provider qualification (2026-11-10)

The interface freeze is commit bb05e7f12. The public versioned API v2 reference
and the scope table qualify every design section 2 row and every published
endpoint in the eight amendment families. No account sign-in or provider call
was made. Read the JSON manifest for method, path, Version, scope, exact provider
field descriptors and bounded engine projection contract.

Sources: https://marketplace.gohighlevel.com/docs/llms/2021-07-28/llms-full.txt
and https://marketplace.gohighlevel.com/docs/Authorization/Scopes/ . The scope
table fills missing scope annotations in location, funnels, documents and course
import endpoint pages. Courses import's generated Auth line says none, while the
scope table explicitly requires courses.write and Sub-Account: use the stronger
scope-table requirement. Conversations retain Version 2021-04-15, whose schema
the provider declares identical. Pipeline writes now exist with pipelines.create,
pipelines.update and pipelines.delete; do not mark them absent based on old docs.

S is the single-recipient send risk. MAIN ruling 2 makes it available at the
change family level; bulk escalates to D in C2/F3. Social publication to audiences
is D. Provider body descriptors describe the API, not permission to accept URL,
credential or arbitrary path arguments: the registry applies stricter input rules.

## Provider-absent or qualification-held operations (Sean report)

- `payments.refund`: No refund endpoint in the published API v2 Payments reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/payments.md).
- `media.bulk.delete`: Endpoint exists, but its reference declares no scope and the scope table does not qualify this route. Held closed pending provider clarification. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/medias/bulk-delete-media-objects).
- `media.bulk.update`: Endpoint exists, but its reference declares no scope and the scope table does not qualify this route. Held closed pending provider clarification. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/medias/bulk-update-media-objects).
- `media.folders.create`: Endpoint exists, but its reference declares no scope and the scope table does not qualify this route. Held closed pending provider clarification. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/medias/create-media-folder).
- `media.update`: Endpoint exists, but its reference declares no scope and the scope table does not qualify this route. Held closed pending provider clarification. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/medias/update-media-object).
- `saas.allowAttachRebilling`: Provider documents an Agency token, not a Location token. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/saas-api/allow-attach-rebilling).
- `saas.bulkDisableSaas`: Provider documents an Agency token, not a Location token. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/saas-api/bulk-disable-saas).
- `saas.bulkEnableSaas`: Provider documents an Agency token, not a Location token. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/saas-api/bulk-enable-saas).
- `saas.enable`: Provider documents an Agency token, not a Location token. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/saas-api/enable-saas-location).
- `saas.subscription.update`: Provider documents an Agency token, not a Location token. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/saas-api/generate-payment-link).
- `saas.plans.list`: Provider documents an Agency token, not a Location token. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/saas-api/get-agency-plans).
- `saas.subscription.get`: Provider documents an Agency token, not a Location token. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/saas-api/get-location-subscription).
- `saas.wallet.get`: Provider documents an Agency token, not a Location token. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/saas-api/get-location-wallet-balance).
- `saas.locations.list`: Provider documents an Agency token, not a Location token. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/saas-api/get-saas-locations).
- `saas.plans.get`: Provider documents an Agency token, not a Location token. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/saas-api/get-saas-plan).
- `saas.locations`: Provider documents an Agency token, not a Location token. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/saas-api/locations).
- `saas.pause`: Provider documents an Agency token, not a Location token. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/saas-api/pause-location).
- `saas.wallet.update`: Provider documents an Agency token, not a Location token. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/saas-api/update-location-wallet-balance).
- `saas.updateRebilling`: Provider documents an Agency token, not a Location token. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/saas-api/update-rebilling).
- `snapshots.share.create`: Provider documents an Agency token, not a Location token. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/snapshots/create-snapshot-share-link).
- `snapshots.list`: Provider documents an Agency token, not a Location token. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/snapshots/get-custom-snapshots).
- `snapshots.push.latest`: Provider documents an Agency token, not a Location token. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/snapshots/get-latest-snapshot-push).
- `snapshots.push.list`: Provider documents an Agency token, not a Location token. [Provider reference](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/snapshots/get-snapshot-push).
- `blogs.posts.delete`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/blogs.md).
- `funnels.create`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/funnels.md).
- `funnels.update`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/funnels.md).
- `funnels.delete`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/funnels.md).
- `funnels.websites.create`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/funnels.md).
- `funnels.websites.update`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/funnels.md).
- `funnels.websites.delete`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/funnels.md).
- `courses.list`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/courses.md).
- `courses.get`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/courses.md).
- `courses.create`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/courses.md).
- `courses.update`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/courses.md).
- `courses.delete`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/courses.md).
- `courses.memberships.list`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/courses.md).
- `courses.memberships.grant`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/courses.md).
- `courses.memberships.revoke`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/courses.md).
- `documents.get`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/proposals.md).
- `documents.create`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/proposals.md).
- `documents.update`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/proposals.md).
- `documents.delete`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/proposals.md).
- `snapshots.apply`: No corresponding Location-token endpoint in the published API v2 service reference. [Provider reference](https://marketplace.gohighlevel.com/docs/llms/2021-07-28/snapshots.md).

## Events

- `ContactCreate`: qualified. [Reference](https://marketplace.gohighlevel.com/docs/webhook/ContactCreate).
- `ContactUpdate`: qualified. [Reference](https://marketplace.gohighlevel.com/docs/webhook/ContactUpdate).
- `ContactDelete`: qualified. [Reference](https://marketplace.gohighlevel.com/docs/webhook/ContactDelete).
- `ContactTagUpdate`: qualified. [Reference](https://marketplace.gohighlevel.com/docs/webhook/ContactTagUpdate).
- `NoteCreate`: qualified. [Reference](https://marketplace.gohighlevel.com/docs/webhook/NoteCreate).
- `TaskCreate`: qualified. [Reference](https://marketplace.gohighlevel.com/docs/webhook/TaskCreate).
- `OpportunityCreate`: qualified. [Reference](https://marketplace.gohighlevel.com/docs/webhook/OpportunityCreate).
- `OpportunityStageUpdate`: qualified. [Reference](https://marketplace.gohighlevel.com/docs/webhook/OpportunityStageUpdate).
- `OpportunityStatusUpdate`: qualified. [Reference](https://marketplace.gohighlevel.com/docs/webhook/OpportunityStatusUpdate).
- `InboundMessage`: qualified. [Reference](https://marketplace.gohighlevel.com/docs/webhook/InboundMessage).
- `OutboundMessage`: qualified. [Reference](https://marketplace.gohighlevel.com/docs/webhook/OutboundMessage).
- `AppointmentCreate`: qualified. [Reference](https://marketplace.gohighlevel.com/docs/webhook/AppointmentCreate).
- `AppointmentUpdate`: qualified. [Reference](https://marketplace.gohighlevel.com/docs/webhook/AppointmentUpdate).
- `AppointmentDelete`: qualified. [Reference](https://marketplace.gohighlevel.com/docs/webhook/AppointmentDelete).
- `InvoicePaid`: qualified. [Reference](https://marketplace.gohighlevel.com/docs/webhook/InvoicePaid).
- `FormSubmission`: provider_absent. [Reference](https://marketplace.gohighlevel.com/docs/llms/guides/webhook.md).

## Sean-only decisions/actions

Create/register the Marketplace app and broker before any inbound event goes live.
Update the draft app's scope list to HIGHLEVEL_CRM_SCOPES; no builder changes it.
Provider-absent features need provider support/clarification; never substitute an
Agency token. In particular courses membership management, website authoring,
snapshot apply and refunds are not advertised by the qualified Location API.
Four media mutation routes exist but lack a verifiable scope declaration, so are
held closed. FormSubmission is absent from the app-webhook catalogue.
User creation requires a password in the provider schema, which the design's
credential prohibition rejects. The users slice must keep that operation held
unless Sean changes the input rule or the provider offers credential-free creation.

## Reuse and ownership

Reused current provider-contract/client path and retry rules, twenty legacy name
mapping and tools dispatcher; consulted 122892b6c assertion guards, 4baaa1d9c
review-cards source and upstream OpenMaus HighLevel OAuth/control-plane notes.
Broker, OAuth and card implementations remain with their owning slices.
PROVISIONAL INTERFACE: C1 effective access, C2 host hooks/actions/review lines,
C4 ledger/projector/store mark have fail-closed placeholders. The legacy-dispatch
bridge preserves existing readers until C2 switches tool listing and dispatch.
Family and fake operation arrays are deliberately empty S0 extension points.

S0 adds contract assertions because section 11 names no S0-specific test names;
the per-family RED cases belong to the family builders and are not claimed here.

## Frozen totals and source fingerprints

240 operation rows: 197 qualified; 43 provider_absent or held for missing provider
qualification. All 17 families are represented. 16 events: 15 qualified and dark;
FormSubmission absent. 72 qualified scope names.

SHA-256 of downloaded public references:
- Full reference SHA-256: `272647116a49cd8739d5c0586aec5765a581b213742ce00d29678ef6a42d1199`
- Index SHA-256: `8ea8caf3bf57d43e3d69495f111044e1f740c07349f12d3a98e336d9b77fa778`
- Webhook guide: `608cfcf4caa508491f5faf2ccc4e2a07f64019e915a00beda8966d5537ff43df`

The catalogue gate requires translations for new English keys. S0 therefore adds
only the matching HighLevel keys in the seven shipped locale packs and their
source hashes; no existing translated text or other slice's keys are changed.
