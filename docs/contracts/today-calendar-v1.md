# Today calendar v1 — frozen Wave 0 interfaces

Authority: DESIGN-r2 §§3–10 plus RULING-l10b-today-1019 R1–R4. Base `c12aaad9341e8f87126a193f35b5c2768f0aa66f`. This document and `shared/today-calendar.ts` freeze C0/P1/S1/L1/H1/U1/T1 for parallel builders. Changes require integrator/reviewer reconciliation. Only Wave 2B edits `server/index.ts`. Wave 0 does not implement a provider, store, route, client, or deployment.

**Broker prerequisite remains OPEN:** no actual broker-owner attestation was supplied. See `server/testing/fixtures/today-calendar/deployed-broker-evidence.md`. Synthetic fixtures specify expected behavior; they do not prove production ownership, routing, scopes, custody, retention or revocation. No live account calls are authorized. Wave 1A must obtain that review before event-adapter implementation.

## C0 — runtime contracts

Import runtime schemas and inferred types from `shared/today-calendar.ts` (server ESM consumers use `.ts`). The schema export convention is lower camel case plus `Schema`; type names are listed below. Objects are strict; unknown versions, keys, enums and missing fields fail. Validators never create consent or prove authority. No schema fetches, persists, trims/case-folds IDs or invokes a model.

| Schema exports | Matching types / purpose |
|---|---|
| `brokerRequestSchema`, `brokerResponseSchema`, `brokerSuccessSchema`, `brokerFailureSchema` | `BrokerRequest`, `BrokerResponse`, `BrokerSuccess`, `BrokerFailure`; TC-BROKER/1 |
| `accountSummarySchema`, `calendarItemSchema`, `brokerEventSchema`, `dateValueSchema` | `AccountSummary`, `CalendarItem`, `BrokerEvent`, `DateValue` |
| `ownerBindingSchema`, `stampSchema`, `expectedStampSchema` | `OwnerBinding`, `Stamp`, `ExpectedStamp` |
| `settingsV1Schema`, `ownerSettingsSchema`, `settingsMutationSchema`, `selectionItemSchema` | `SettingsV1`, `OwnerSettings`, `SettingsMutation`, `SelectionItem` |
| `schedulerStateV1Schema`, `claimSchema`, `runV1Schema`, `runStatusSchema` | `SchedulerStateV1`, `Claim`, `RunV1`, `RunStatus` |
| `preferencesSchema`, `parseInactivePreferences` | `InactivePreferences`; strict version 1 and bounded raw UTF-8 |
| `normalizedEventSchema`, `meetingRowSchema`, `meetingWhenSchema`, `coverageSchema`, `publishedSnapshotSchema` | `NormalizedEvent`, `MeetingRow`, `Coverage`, `PublishedSnapshot` |
| `capabilitiesSchema`, `todayStepUpModeSchema`, `statusSchema`, `errorCodeSchema` | `Capabilities`, `TodayStepUpMode`, `Status`, `ErrorCode` |
| `settingsResponseSchema`, `mutationResponseSchema`, `snapshotResponseSchema`, `refreshResponseSchema` | `SettingsResponse`, `MutationResponse`, `SnapshotResponse`, `RefreshResponse` |
| `discoveryAccountsRequestSchema`, `discoveryCalendarsRequestSchema`, `refreshRequestSchema`, `stopRequestSchema` | Corresponding PascalCase types |
| `discoveryAccountsResponseSchema`, `discoveryCalendarsResponseSchema` | `DiscoveryAccountsResponse`, `DiscoveryCalendarsResponse` |
| `ownerInvalidationSchema`, `invalidationReasonSchema`, `apiErrorSchema`, `stepUpRefusalSchema` | `OwnerInvalidation`, `InvalidationReason`, `ApiError`; exact typed refusal |

Primitive exports are `idSchema`, `labelSchema`, `counterSchema`, `instantSchema`, `uuidSchema`, `zoneSchema`, `morningTimeSchema`, `civilDateSchema`, `dateTimeSchema`, `utcTimeSchema`, `privacySchema`, `eventIdentitySchema`, `selectionSchema`, `mutationSelectionSchema`, `metadataThrottleSchema`, `activeRunSchema`, `invalidationEventSchema`.

IDs are nonempty well-formed UTF-8, <=1,024 bytes, without identity normalization (including preservation of leading U+FEFF). Labels are sanitized plain text <=120 Unicode code points; titles <=300. Remove controls and bidi formatting using `sanitizeTodayText`, then validate the projected result. Fallbacks are `Google account`, `Calendar`, `Busy`. These remain plain text: render through escaped text nodes, never Markdown/HTML, links or instructions. Broker summaries are untrusted bounded source text; P1 sanitizes and redacts. Unknown provider privacy maps to the literal `unknown` before broker validation. Private, confidential and unknown normalized/output rows require literal `Busy`.

All numeric instants are finite epoch milliseconds; counters are nonnegative safe integers. Refuse overflow rather than wrap. Civil dates validate leap days without Date rollover; timed values require explicit offset, positive duration and UTC `updatedAt`. UTC bounds have positive duration <=26 hours (a conservative envelope ceiling, not permission to read arbitrary windows); P1 additionally proves exact saved-zone civil-day bounds. Zones must resolve as named IANA zones. Offsets are not zone names.

`TODAY_CALENDAR_LIMITS` is the single exported bounds table: 20 selections; 64-KiB write/preference input; 4-KiB tokens; 2-MiB streamed success/error body; 10-MiB attempt; 15-second request and 120-second whole attempt; 64 requests, 20 pages, 2,000 items; sequential pageSize 100; metadata TTL 5 minutes, 30 seconds/account, 20 starts/home/5 minutes; lease 3 minutes; manual throttle 5 minutes; automatic attempts 3/manual 1; heartbeat 5 seconds/liveness 15 seconds; 8 dates/64 manual terminal records. Limits apply before allocation/read as well as validation. Discovery and event budgets are separate. Small recipes generate huge streams without checking huge files into git.

`matchesStamp` accepts exactly equal version/ownerEpoch/generation/snapshotRevision, after strict validation. Pass the extracted stamp, not an entire response. Owner epoch is process-and-owner incarnation; generation is durable settings/consent; revision changes on every publication/purge/reprojection. None is an authority token. `matchesBrokerResponse` validates request and response and checks requestId, operation, broker principal and exact account echo. A typed failure only correlates requestId. It does not prove calendar membership or page-token binding; those require broker checks and P1's current authority before/after every page.

Settings PUT selection requires `{accountId,calendarId,discoveryId:string|null}` with key present; string length 1–200 UTF-16 units. The store admits null only if settings were enabled, stay enabled, and the exact pair is already saved. Every new/replaced pair and every off→on pair requires fresh owner/epoch/account-bound discovery within five minutes. Shape validity alone never admits null on a new pair. Labels and source zones come only from validated discovery, never PUT text. OwnerSettings omits binding and consentedAt and returns hasConsent and lastMutationId.

`RUN_TRANSITIONS` / `canTransitionRun` freeze the structural graph:

- queued → claimed / cancelled / expired
- claimed → running / cancelled / expired / interrupted
- running → succeeded / retry_wait / failed / cancelled / expired / interrupted
- retry_wait → claimed / cancelled / expired
- interrupted → retry_wait / failed / expired / cancelled
- succeeded, failed, cancelled, expired → nothing

S1 must additionally enforce predecessor CAS, spent attempts, current day, authority and lease. Interrupted work waits for expiry, only retries within remaining budget, and terminal work never re-enters dispatch. Automatic retry delays are 5 then 20 minutes after failure, bounded by coverage end. Metadata history pruning never deletes the automatic watermark/guard or throttles.

**PROVISIONAL INTERFACE (narrow missing representation):** `SchedulerStateV1.metadataThrottle` is an array, at most 20 `{accountId:string|null,startedAt:instant}` entries representing admitted starts in the rolling five-minute home window. Null identifies accounts discovery. Prune only entries outside that window; retain across restart. Both the per-account 30-second and per-home limits are checked transactionally. `NormalizedEvent.identity` is the five-element tuple `[provider,accountId,calendarId,eventId,originalStart ?? start]`, preserving the DateValue tagged union. These representations are not specified structurally in the design and require integrator reconciliation before changing.

Preferences use exactly `today-calendar-preferences.json` (exported `TODAY_CALENDAR_PREFERENCES_PATH`); state uses `today-calendar-state.sqlite`. Projection fields: format, version, morningTime, syncZone, showTitles, showAllDay, selection. Never enabled, consent, owner binding, generation, jobs, watermark, throttles or meeting text. Raw preference bytes use fatal UTF-8 decoding without silently removing a BOM; BOM-prefixed JSON is refused consistently for strings and byte input. `preferences-v1.json` supplies common valid/invalid fixtures for Python and TypeScript. Capture uses one read transaction and never a stale shadow. Absence is distinct from corruption. Nightly and pre-reset capture share `capture_today_preferences`; reset fails before changing data if capture cannot preserve preferences. Restore consumes/validates staged preferences before `place_database_snapshot` removes staging, writes the sanitized import file 0600, deletes runtime DB/sidecars/temp siblings, and imports an inactive draft into a fresh private store. Invalid preferences report `today-preferences-not-restored` without blocking the deny barrier or restore.

## P1 — provider and dedicated transport

The broker endpoint is `POST /v1/today-calendar/read`, bearer outside JSON, contract `murage.today-calendar/1`, providerVersion `google-calendar-v3/1`. Exactly accounts/calendars/events; fixed tools `GOOGLECALENDAR_LIST_CALENDARS` and `GOOGLECALENDAR_EVENTS_LIST`, plus the ownership inventory. No arbitrary tool, URL, headers, owner, credential, session-default fallback or hidden retry. Account/calendar/read-window/operation/version-bound opaque page tokens are short-lived and revalidated per page and immediately before release. Authority replacement aborts; verified token rotation does not replace principal or replenish budgets.

Signatures below use C0 types. The design names operations but leaves parameter packaging unspecified. **PROVISIONAL INTERFACE:** the following minimal context, result and request packaging is the Wave 0 freeze; implementing owners reconcile differences before dependent merges. These declarations are contracts, not runtime stubs. `assertCurrent()` synchronously throws only a typed local error; execution authority is supplied by the host, never request JSON.

```ts
type TodayResult<T> = { ok:true; value:T } | { ok:false; error:{code:ErrorCode;retryAfterMs:number|null} };
interface TodayAuthority { ownerBinding:OwnerBinding; ownerEpoch:string; authorityEpoch:string; generation:number }
interface TodayReadContext {
  signal:AbortSignal; deadlineAt:number; maxResponseBytes:number;
  budget:{ remainingBytes:number; remainingRequests:number }; assertCurrent():void;
}
// server/composio.ts. Local failures have the request's contract/version/requestId and typed error.
function readTodayCalendarBroker(request:BrokerRequest, context:TodayReadContext):Promise<BrokerResponse>;
// server/today-calendar-provider.ts. Every method uses a fresh complete bounded budget, no partial result.
function discoverAccounts(request:DiscoveryAccountsRequest, context:TodayReadContext):Promise<TodayResult<{accounts:AccountSummary[];complete:true}>>;
function discoverCalendars(request:DiscoveryCalendarsRequest, context:TodayReadContext):Promise<TodayResult<{accountId:string;calendars:CalendarItem[];complete:true}>>;
function readSelectedDay(request:{selection:SelectionItem[];coverage:Coverage;showTitles:boolean}, context:TodayReadContext):Promise<TodayResult<{rows:NormalizedEvent[];coverage:Coverage;complete:true}>>;
```

P1 binds provider instances to current owner authority and per-owner-epoch HMAC key through construction/injection, never browser input. Store/route owner creates and persists discovery handles only after complete validated metadata. HMAC tuple encoding must be unambiguous (JSON array of the five canonical identity elements); key never leaves memory or enters fixtures. No readiness/account/discovery/parse step is outside the attempt deadline or aggregate byte/request budget. Stream-cancel on deadline/loss; reject incomplete page lists and repeated tokens. Event dedup keeps strictly newer updatedAt; equal-time conflicting content fails. Raw responses never enter caches, receipts, logs or journals.

## S1 / L1 — store, lifecycle and owner invalidation

**PROVISIONAL INTERFACE:** concrete parameter packaging below freezes the unspecified S1/L1 arguments. Each service instance binds one canonical data root and owner authority. No global singleton survives a root change. Mutations and publication are serialized, transactions are short and never cross a network await.

```ts
interface TodayStore {
  readSettings():SettingsV1;
  mutateSettings(expectedStamp:ExpectedStamp, mutation:SettingsMutation|StopRequest):TodayResult<SettingsV1>;
  claimRun(request:{runId:string;expectedStatus:RunStatus;authority:TodayAuthority;now:number}):TodayResult<Claim>;
  transitionRun(request:{runId:string;expectedStatus:RunStatus;nextStatus:RunStatus;claim:Claim;now:number;error:ErrorCode|null;nextRetryAt:number|null}):TodayResult<RunV1>;
  readSnapshot(authority:TodayAuthority, now:number):PublishedSnapshot|null;
  publishCandidate(request:{claim:Claim;authority:TodayAuthority;now:number;candidate:PublishedSnapshot}):TodayResult<Stamp>;
  exportInactivePreferences():InactivePreferences;
  importInactiveDraft(preferences:InactivePreferences):TodayResult<SettingsV1>;
}
interface TodayLifecycle {
  deny(reason:InvalidationReason):void; // synchronous, before storage/network await
  stop(reason:InvalidationReason):Promise<void>; // idempotent abort/join, then close
  purge(reason:InvalidationReason):void;
  rebind(context:{dataRoot:string;authority:TodayAuthority}):Promise<void>;
  resume(authority:TodayAuthority):Promise<void>;
}
function subscribeOwnerInvalidation(owner:OwnerBinding, callback:(event:OwnerInvalidation)=>void):()=>void;
function publishOwnerInvalidation(stamp:Stamp, reason:InvalidationReason):void;
// composio's observer is registered per service. Callback is synchronous before token/identity changes.
function observeTodayCalendarAuthority(callback:(change:{kind:"lost"|"replaced"|"rotated";previous:OwnerBinding|null;current:OwnerBinding|null})=>void):()=>void;
```

The method's expected stamp and the mutation's expected fields must agree. These are typed results; no upstream free text. Store construction/read/permission failures fail closed with storage_error, no default enabled record. All mutable metadata is transactionally persisted in private rollback-journal SQLite. POSIX 0700/0600 and Windows protected owner DACL verification are required; chmod alone is not Windows evidence. Broker failure is not permission to fabricate success.

Deny precedes awaited work: invalidate revision and owner clients, abort transport, purge eligibility, then durable off/generation. Failed commit retains deny latch and never says Saved. Stop joins before store/lease closure; bounded join timeout retains deny/lease. Resume/rebind waits for prior stop and starts a fresh owner epoch. Token fingerprint is not owner identity. Title-off redacts before echo; title-on cannot recover erased text; all-day visibility may reproject retained authorized rows; mixed selection/schedule/authority mutations purge. Publish compares lease/run/generation/authority/consent/selection, commits succeeded, then swaps memory, then invalidates. Readability of a published snapshot does not depend on the expired producing lease. Restart never resurrects memory content.

## H1 — exact owner routes and transport

`TODAY_CALENDAR_ROUTES` is the exact route/method table from §6. GET settings/snapshot/events has no query or body and no provider I/O. POST accounts/calendars requires explicit metadataConsent:true. PUT uses SettingsMutation. POST refresh uses RefreshRequest and returns 202 RefreshResponse. DELETE selection uses StopRequest, keeps inactive preferences and returns MutationResponse after the barrier and commit. PUT returns the same authoritative MutationResponse; mutationId must equal settings.lastMutationId. All JSON responses are versioned stamps; all reads use Cache-Control:no-store, never 304.

**PROVISIONAL INTERFACE:** route/admission attachment is a callback on the existing server request path, before generic refusal/body parsing:

```ts
type TodayAdmission = {kind:"allow";authority:TodayAuthority;capabilities:Capabilities}
  | {kind:"refuse";status:404;body:null}
  | {kind:"refuse";status:403;body:{error:{code:"step_up_required"}}};
// Wave 2A exports its concrete mount adapter to the Wave 2B integration owner; only it edits index.ts.
```

No claim that this type alone authenticates requests: both Cloud and local admission preserve existing host/origin/CSRF/pairing/session/proof checks. Segment-match `/api/today-calendar(?:/|$)` after unambiguous normalization; reject encoded separators/extra segments/unknown methods including HEAD/OPTIONS/PATCH with empty 404. Denied, wrong-home, remembered/chat-only owner, service, bot, room, shared-link, anonymous or conflicting proofs always get empty 404 before any store/body access. Every write has exact JSON content type and <=64-KiB input. Exact allowed owners lacking Cloud step-up get only `403 {"error":{"code":"step_up_required"}}`.

Local desktop/paired companion capabilities.stepUp = none; Cloud owner-desktop = native; Cloud owner-phone = web-device-key; current passkey owner-browser = web-passkey. UI never infers mode from surface. Phone can Today-discover/save/refresh/stop, but existing provider credential routes stay barred and connect/disconnect use the computer handoff. Error statuses: 400 invalid_input; 409 stale_epoch/stale_generation/consent_required/selection_invalid/busy; 429 throttled plus retryAt; 503 bounded discovery/storage/transport failure. No IDs, counts, rows or upstream prose in errors. Never automatically retry a stale write.

The owner-only fetch SSE emits ready/invalidate/heartbeat/closing with only OwnerInvalidation (stamp + reason). Reauthenticate home and owner before every send/heartbeat. Queue at most one latest invalidation; close slow clients. Opening order is stream → ready → reads. Close/error/15-second heartbeat lapse/offline/sign-out/owner-change/unmount/expiry clears private state. Hidden/suspended document clears displayed meetings; resume establishes a live stream and rereads before display. Invalidation cancels old reads and clears before rereading. Responses require current stream epoch/generation/revision and request serial. No global or persisted browser cache. Five-second status polling is allowed only while an active run and healthy stream remain; no provider polling.

## U1 — hook and step-up

Wave 3A owns `useTodayCalendar()` and `todayWrite`; 3B consumes these contracts and owns locale/help files. The hook exposes `{settings,snapshot,status,capabilities,save,stop,discoverAccounts,discoverCalendars,refresh}`. Settings and snapshot are full authoritative responses or null; capabilities is Capabilities|null and status is Status. Missing capabilities means no active controls/private content. **PROVISIONAL INTERFACE:** method arguments use exact C0 request types and the generic outcome below, avoiding inferred UUID/epoch ownership between concurrent builders. The UI creates a fresh UUID per explicit action, the hook preserves it through readback/step-up and never resubmits ambiguous writes.

```ts
type TodayActionOutcome<T> = {kind:"response";value:T} | {kind:"error";error:ApiError}
  | {kind:"cancelled"} | {kind:"unavailable"};
interface TodayCalendarHook {
  settings:SettingsResponse|null; snapshot:SnapshotResponse|null; status:Status; capabilities:Capabilities|null;
  save(request:SettingsMutation):Promise<TodayActionOutcome<MutationResponse>>;
  stop(request:StopRequest):Promise<TodayActionOutcome<MutationResponse>>;
  discoverAccounts(request:DiscoveryAccountsRequest):Promise<TodayActionOutcome<DiscoveryAccountsResponse>>;
  discoverCalendars(request:DiscoveryCalendarsRequest):Promise<TodayActionOutcome<DiscoveryCalendarsResponse>>;
  refresh(request:RefreshRequest):Promise<TodayActionOutcome<RefreshResponse>>;
}
type TodayWriteOutcome = {kind:"response";response:Response}|{kind:"cancelled"}|{kind:"unavailable"};
// src/lib/today-step-up.ts; exact R1 signature. import loadDevice from cloud-door.
function todayWrite(method:"POST"|"PUT"|"DELETE", path:string, body:unknown,
  deps:{mode:TodayStepUpMode;confirm(action:TodayWriteAction):Promise<boolean>;fetch:typeof fetch;
    loadDevice:typeof loadDevice;webauthnGet(o:CredentialRequestOptions):Promise<Credential|null>;now():number}
):Promise<TodayWriteOutcome>;
```

All five hook writes call todayWrite. JSON.stringify(body) once; content-type application/json; identical bytes on both attempts. First refusal must be 403 and legacy string or exact typed Today envelope (sole error.code key and sole error outer key). none/native returns that response as-is; no renderer second step-up. Web mode confirms the named save/discover/refresh/stop action; no returns cancelled. Missing deviceId/private key/challenge returns unavailable. Compute purpose `step:METHOD:path+query:sha256hex(bodyText)`. POST `/api/cloud/challenge` with `{deviceId,purpose}`. Message is `murage:environmentId:deviceId:purpose:challenge:at`. Device-key uses exported signDoorMessage (one-line export of existing sign). Passkey uses UTF-8 message as challenge, required verification, 60-second timeout; rejection/null → cancelled. Retry exactly once with x-murage-step-up = base64url JSON `{challenge,at,signature}` or `{challenge,at,webauthn:{credentialId,clientDataJSON,authenticatorData,signature}}`. Return the response, no loop/queue. Electron's two adapters duplicate R1's identical prefix predicate, preserving legacy routes and their own one signed native-confirm retry.

Cancellation preserves draft inputs: “Not changed. You cancelled the confirmation.” Unavailable shows “Confirm this change on your computer” with a settings-only handoff. Step-up/passkey actions count in click evidence. Lost response uses lastMutationId readback before claiming Saved; no blind retry. Stop clears immediately while commit awaits; local Stop has no extra confirmation, Cloud still has mandatory step-up.

## T1 — timeline (Wave 3A owns implementation)

The existing `dayTimeline(routines,now,cap=6):DayTimeline`, DayRow shape, interval collapse, ordering and viewer-local midnight remain unchanged. Export `routineDayRows(routines,now)` returning DayTimeline with **all** generated rows and more=0. It uses the same DaySource type (Pick<Routine,id|botId|name|enabled|schedule|nextRunAt>). `meetingDayTimeline` takes that uncapped result, never dayTimeline's capped rows.

**PROVISIONAL INTERFACE:** this return packaging freezes the design's named facts without changing existing routine types:

```ts
type TodayTimelineRow = {kind:"routine";row:DayRow}|{kind:"meeting";row:MeetingRow;ongoing:boolean};
function meetingDayTimeline(routineSource:DayTimeline, snapshot:SnapshotResponse|null,
  visibility:{showAllDay:boolean}, now:number, viewerZone:string, cap?:number): {
    fullRows:TodayTimelineRow[]; rows:TodayTimelineRow[]; more:number; allDay:MeetingRow[];
    next:DayTimeline["next"];hasRoutines:boolean;midnight:number;
    coverage:Coverage|null;fullViewerDayCovered:boolean;hadMeetings:boolean;hadTimedMeetings:boolean;
  };
```

All-day precedes timed and counts toward six; title then opaque-ID order. Ongoing timed meetings first, then future instant, meeting before routine, stable ID. Project by half-open intersection of source-zone all-day boundaries, sync coverage and viewer day. Do not reinterpret source dates or use fixed 24-hour DST arithmetic. Show-all expands local fullRows; keep focus. Empty copy depends on complete full-day coverage and past meetings, not visible truncated rows. No snapshot/partial coverage/failure can claim an empty successful day. Timeline retains Tell-box primary hierarchy, routines, Needs you and lower cards; no grid/model/read-on-open.

## Exact search, locale and help key freeze

Canonical card ID `today-calendar`, title “Meetings in Today”, section `connections`, directly mounted on Apps in both Simple and Advanced, authorized phone included. Anchors:

| Anchor suffix (prefix `today-calendar-`) | Keywords / expansion |
|---|---|
| heading | meetings, calendar, Google Calendar |
| time | morning, meeting time, sync time |
| enabled | turn on, turn off meetings |
| account | choose account, connect Google Calendar |
| calendars | selected calendars, which calendars; More options |
| zone | sync zone, time zone; More options |
| titles | titles, private titles, hide meeting names; More options |
| all-day | all day, all-day events; More options |
| refresh | check meetings, refresh meetings; More options |
| disconnect | disconnect calendar; More options |
| privacy | meeting privacy, retention, bot calendar access; More options + help |
| more | more meeting options |

Open, expand and focus/highlight the real control without changing mode. No private account IDs/calendar labels or meeting text enters search. No capability proof → no private card/search result.

The following **exact keys** are owned by Wave 3B in en/de/es/fr/hi/ja/pt-br/zh; braces name interpolation parameters. 3A consumes them. Dotted spelling follows existing t(key) usage; do not edit locale files in Wave 0.

| Key | English value |
|---|---|
| today.calendar.heading | Meetings in Today |
| today.calendar.provider | Google Calendar |
| today.calendar.add | Add your meetings |
| today.calendar.settings | Meetings settings |
| today.calendar.time | Morning time |
| today.calendar.zone | Sync time zone |
| today.calendar.account | Google account |
| today.calendar.calendars | Selected calendars |
| today.calendar.titles | Show titles |
| today.calendar.allDay | Show all-day events |
| today.calendar.more | More options |
| today.calendar.privacy | Privacy and retention |
| today.calendar.choose | Choose Google calendars for Today |
| today.calendar.continueHelp | Continue lists your accounts and calendars. Meetings are read only after Turn on. |
| today.calendar.continue | Continue |
| today.calendar.showCalendars | Show calendars |
| today.calendar.connect | Connect Google Calendar |
| today.calendar.signInPending | Finish signing in |
| today.calendar.cancel | Cancel |
| today.calendar.checkAgain | Check again |
| today.calendar.signInFailed | Sign-in was not finished |
| today.calendar.tryAgain | Try again |
| today.calendar.noCalendars | No calendars available for this account |
| today.calendar.chooseAnother | Choose another account |
| today.calendar.refreshList | Refresh list |
| today.calendar.removed | No longer available |
| today.calendar.reconnected | Choose calendars for the reconnected account |
| today.calendar.limit | Choose up to 20 calendars. |
| today.calendar.turnOn | Turn on |
| today.calendar.turnOff | Turn off |
| today.calendar.save | Save |
| today.calendar.saved | Saved |
| today.calendar.unconfirmed | Could not confirm the change |
| today.calendar.refresh | Refresh |
| today.calendar.disconnect | Disconnect |
| today.calendar.disconnectConfirm | Disconnecting also stops bots using this account. |
| today.calendar.confirm | Confirm |
| today.calendar.disconnected | Disconnected |
| today.calendar.disconnectFailed | Stopped in Today. Account disconnect did not finish |
| today.calendar.retry | Retry |
| today.calendar.appsSettings | Apps settings |
| today.calendar.computerHandoff | Connect or disconnect this account on your computer |
| today.calendar.consentHelp | Read your selected Google calendars each morning. Visible only to you in Today. |
| today.calendar.titlesReturn | Titles return after the next check. |
| today.calendar.coverage | Meetings checked for {date} in {zone} |
| today.calendar.partialCoverage | Meetings outside this checked period are not loaded. |
| today.calendar.empty | No meetings in your selected calendars today |
| today.calendar.noUpcoming | No upcoming meetings |
| today.calendar.noTimed | No timed meetings in your selected calendars today |
| today.calendar.noUpcomingTimed | No upcoming timed meetings |
| today.calendar.noUpcomingChecked | No upcoming meetings in the checked period |
| today.calendar.showAll | Show all {n} |
| today.calendar.showLess | Show less |
| today.calendar.routines | Routines |
| today.calendar.nowUntil | Now · until {time} |
| today.calendar.allDayGroup | All day |
| today.calendar.tentative | Tentative |
| today.calendar.busy | Busy |
| today.calendar.privacy.public | Public |
| today.calendar.privacy.default | Calendar visibility |
| today.calendar.privacy.private | Private |
| today.calendar.privacy.confidential | Confidential |
| today.calendar.privacy.unknown | Visibility unknown |
| today.calendar.status.off | Add your meetings |
| today.calendar.status.setup_required | Choose calendars for Today |
| today.calendar.status.waiting | Meetings will be checked at {time} |
| today.calendar.status.checking | Checking meetings… |
| today.calendar.status.retry_wait | Meetings will be checked again at {time} |
| today.calendar.status.ready | Morning snapshot · Checked {time} |
| today.calendar.status.refresh_failed | Could not refresh · Last checked {time} |
| today.calendar.status.restarted | Meetings cleared when Murage restarted |
| today.calendar.status.expired | Meeting copies cleared at midnight |
| today.calendar.status.auth_required | Reconnect Google Calendar |
| today.calendar.status.selection_invalid | Choose calendars |
| today.calendar.status.unsupported_connector | Meetings could not be checked |
| today.calendar.status.storage_error | Meetings could not be checked |
| today.calendar.status.unavailable | Meetings could not be checked |
| today.stepUp.title.save | Confirm saving your meeting settings |
| today.stepUp.title.discover | Confirm listing your calendars |
| today.stepUp.title.refresh | Confirm checking your meetings |
| today.stepUp.title.stop | Confirm turning off meetings in Today |
| today.stepUp.cancelled | Not changed. You cancelled the confirmation. |
| today.stepUp.unavailable | Confirm this change on your computer |

`today.calendar.error.<code>` exists for every ErrorCode enum value, with fixed localized reason text and no upstream prose. Exact English values: auth_required “Reconnect Google Calendar.”; account_revoked “This account is no longer connected.”; account_not_owned “This account is not available here.”; calendar_removed “A selected calendar is no longer available.”; unsupported_connector “This connection cannot check meetings yet.”; rate_limited “The calendar service asked Murage to wait.”; upstream_unavailable “The calendar service is unavailable.”; timeout “The check took too long.”; aborted “The check was stopped.”; too_large “The calendar response exceeded the check limits.”; malformed_response “The calendar response could not be read.”; authority_lost “Owner access changed. Meetings were cleared.”; storage_error “The change could not be stored.”; invalid_input “Check your meeting settings.”; stale_generation “Meeting settings changed. Review the latest values.”; stale_epoch “Owner access changed. Reopen meeting settings.”; consent_required “Choose calendars and turn on meetings first.”; selection_invalid “Choose your calendars again.”; busy “A meeting check is already pending.”; throttled “Wait until {time} to check again.”; step_up_required “Confirm this change to continue.”; snapshot_unavailable “No meeting copy is available.”

Help inventory keys are `today.calendar.help.access`, `.scope`, `.retention`, `.coverage`, `.freshness`, in en-help/screens and each translated help file using the existing structure. Values: access “This adds no bot or room access. Existing calendar permissions and screen or computer access are separate. Turning this off does not revoke them.”; scope “Today only reads calendars. Your Google Calendar connection may have broader permissions.”; retention “Meeting copies stay until midnight or until Murage restarts.”; coverage “Only the checked day and time zone are loaded. Meetings outside this period are not loaded.”; freshness “Meetings show the last checked time, not live changes. Disconnected devices clear when connection loss is detected and recheck before showing meetings again.”

Setup defaults: off, generation 0, no binding/consent/selection, 06:00, detected owner zone copied only at consent, titles/all-day on, options/privacy closed. Failed zone detection requires explicit selection before Turn on. A lone account is a draft only; primary calendar is preselected only after explicit discovery. Existing credential controls keep their gates. Every hidden option has exact search access. Mandatory confirmations, Save, passkey prompts and provider/cross-device steps count in Wave 4's click table. Release still requires G1–G10, broker conformance/security evidence, Fable, packaged Mac/Windows/Linux, Astra/Opus and Sean's pre-release evidence review.
