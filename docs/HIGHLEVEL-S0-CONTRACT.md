# HL-WRITES-1019 frozen interfaces

S0 interface publication. Family ids are contacts, opportunities, conversations,
calendars, automations, location, users, forms, payments, social, funnels, blogs,
courses, media, documents, saas, snapshots. Tool names are HIGHLEVEL_<FAMILY>.
Funnels includes websites; courses includes memberships; documents includes contracts.
Each family fills only operations/<family>.ts (named <family>Operations and default
export), fake/<family>.ts (<family>Routes and default export), its tests and locale
block. Registry imports are already present. Family operations are intentionally empty.

PROVISIONAL INTERFACE: C1 owns effectiveHighLevelAccess; C2 owns host hooks,
action methods and review lines; C4 owns the call ledger, event projector and
persisted store mark. Placeholders fail closed and are not connected to live paths.
The existing grant and tool-list wiring is C1/C2/C3 work, not enabled by this freeze.
Provider qualification is in provider-manifest.json, with helpers in provider-manifest.ts.
HIGHLEVEL_ENDPOINTS contains only qualified rows plus the existing legacy aliases.
Use HIGHLEVEL_ENDPOINTS[operationId] for OperationSpec.endpoint. providerOperation
also exposes provider_absent rows for a useful refusal before any credential.
Registry lookups validate the frozen method/path/version/scope/retry/risk and wrap
the args schema with strictOperationArgs. All nested object schemas must be strict.
highlevelIdSchema is the common bounded identifier validator. Use workspaceFile
for the attachment's workspace-relative reference; URL and path fields are forbidden.

Each fake module exports <family>Routes: readonly FakeHighLevelRoute[]. Route fields
are operation, method, path (RegExp), and handle(FakeHighLevelRequest). The aggregate
fakeHighLevelRequester returns the frozen HighLevelRequester plus a calls array.
It is in-memory, without a socket or API-origin override.

Section 8 copy is seeded in en.json. Each family owns its highlevel.titles.<family>
prefix and may add operation keys under it; no shared registry edits are needed.
The provider report lists every absent/held route, scope caveats and event status.
S0 does not activate family tools, grant upgrades, policy approvals or inbound events.
