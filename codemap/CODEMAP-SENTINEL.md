# Sentinel integration code map (server/index.ts, 1.0.9 lane C1)

Scoped map of the server/index.ts regions the Sentinel host integration touches. Line numbers are at base 53873d262
(31,048 lines); grep the symbol, then read only the range. Regenerate after a large merge.

| Symbol / region | Lines | What it is |
|---|---|---|
| health producer hook imports (lane A2) | 192 | turn-observer import; leave as is |
| notification preferences import | 982 | applyNotificationPreferences, resolveNotificationPreferences |
| `dataDirLease = acquireDataDirLeaseForProcess(DATA_DIR)` | 1105-1109 | data owner boundary: lease, package-import recovery, restore review |
| `ensureDirs()` / `configureLocalServerStore` | 1130-1133 | first data-dir writes after the lease (health/ initializes here) |
| `backupFailedNotice` | 1391 | desktop failed-backup Inbox notice (set at ~21117-21123) |
| `cloudHome` | 1478 | MURAGE_CLOUD_ROLE === "home" |
| `broadcast(payload, ...)` | 5653-5683 | SSE frame fan-out (sse-visibility.ts scopes frames) |
| `announceInboxChanged()` | 5698 | Inbox invalidation frame |
| `presence = new Presence()` | 6898 | owner-at-desk presence |
| `notify(notification)` | 7036-7058 | the existing server -> desktop notification path: preference filter, `{kind:"notify"}` frame, phone push outbox |
| `json(res, status, body)` | 20592 | JSON responder |
| `handleRequest` HTTP dispatch | 20884-20950 | cloudAuth, loopback/origin gates, route-policy class gate (`routeClass`, `routeAdmits`) |
| `/api/inbox` GET/POST | 21223-21252 | inboxRequest + withBackupNotices + other owner rows |
| `/api/desktop/tray` | 21289-21300 | tray summary |
| `PUT /api/owner/timezone` | 28398-28411 | Cloud owner time zone (cloud-home/timezone.ts) |
| `GET /api/health` | 28412-28454 | liveness probe; Cloud public body is `publicHealthBody()` (unchanged) |
| `GET /api/diagnostics/incident` | 28457 | selected incident diagnostics |
| `server.listen` + `runAfterListen` | 30706-30902 | after-listen background steps |
| `dataWriterGate` / `gracefulShutdown` cleanup list | 30904-30950 | orderly shutdown jobs (health producer stops here) |
