# Murage 0.1.52 frozen shared contracts (K0)

Written by lane K0 on `lane/0152-K0`. Every 0.1.52 lane follows these shapes. If a lane truly has to change one, it records why in its report and in its commit message. Line references are approximate; search for the named symbol.

## Shared types

| File | Exports | Consumers |
|---|---|---|
| `shared/workspace-files.ts` | `OUTPUT_NAMESPACE`, `WORKSPACE_FILES_ROUTES`, bounds (`WORKSPACE_LIST_PAGE_SIZE` 200, `WORKSPACE_SEARCH_MAX_ENTRIES` 2,000, `WORKSPACE_SEARCH_MAX_DEPTH` 8, `WORKSPACE_TEXT_MAX_BYTES` 2 MiB), `WorkspaceScopeRef`, opaque `FileRevision`, `WorkspaceRootInfo`, `WorkspaceEntry`, list/search request and response (`cursor`, `incomplete`), `WorkspaceReadResult`/`ReadResult` (`revision`, `encoding`, `bom`, `newline`), `WorkspaceWriteRequest`/`WriteRequest` (`baseRevision`, `requestId`, `content`, `bom`), `SaveReceipt`, save-version request and response, `WORKSPACE_FILE_ERROR_STATUS` (code → HTTP status), and the guards `isWorkspaceScopeRef`, `isFileRevision`, `isWorkspaceRelativePath`, `isOutputNamespacePath`, `isWorkspaceFileErrorCode` | R3-T1, R3-T2, F4-T1..T4, F4-T7 |
| `shared/output-publication.ts` | `LocalOutputReceipt` (`producer`: `shell-output`, `image-operation` or `assistant-image`; `stage`: `retained`, `attached`, `registered` or `failed`), `OUTPUT_PUBLICATION_LIMITS` (25 MiB per file, 20 files per turn, 1 host card per turn), `OUTPUT_STAGE_TRANSITIONS`/`canAdvanceOutputStage`, and the guards | R3-T3, R3-T4 (C2), F5-T5 |
| `shared/media-assets.ts` | `MediaAsset` (exactly as in the media design), `MediaAssetRef`, `MEDIA_ROUTES`, `MediaResolveResponse`, capability constants (`MEDIA_CAPABILITY_QUERY_PARAM` `cap`, `MEDIA_CAPABILITY_TTL_MS` 10 min, token shape `mc1.<claims>.<hmac>`), `MEDIA_BYTES_RESPONSE_HEADERS`, `redactMediaCapability`, `MEDIA_PLAYABLE_MIMES` (U-28), `ImageReferenceSource` (attachment, artifact+sha256, or workspace-relative), `ResolvedImageReference {id, sha256, mime, bytes}`, `IMAGE_REFERENCE_LIMITS` (4 references, 10 MiB each, 20 MiB total), `isImageReferenceSource` | F5-T1..T5 |
| `shared/artifacts.ts` | `Artifact.producer?: OutputProducer`. The field is absent for manual or tool registration and for older rows. | R3-T2, R3-T3 |
| `server/contracts.ts` | `ProviderStopResult` (`{closeConfirmed:true}` or `{closeConfirmed:false, reason:"timeout"\|"stop-failed"}`). `interruptTurn` now returns `Promise<void \| ProviderStopResult>`. Optional `awaitTurnTeardown?(threadId, turnId)`. `stopCloseConfirmed(result)` returns `undefined` for legacy `void`. | R1-T2 (ACP core, Pi), R1-T8 |
| `electron/main-trust.mjs` | `isOwnedMainSender(event, {window, origin})` checks the same webContents, top frame, non-detached frame and exact origin, and fails closed. `mainRendererOrigin({packaged, serverPort, devUrl})`. | R2-T1, S1-T3, F4-T5 |
| `shared/questions.ts` (K0 amendment, ASK2) | `QuestionOption {label, description?}`, `QuestionSpec {id, question, header?, options[], multiSelect, allowOther, secret?}`, `QuestionAnswer {id, selected[], other?}`, `QUESTION_LIMITS` (4 questions, 10 options, 2,000-char free text), `QUESTION_TIMEOUT_MS` (30 min), `isQuestionCard`, `questionsForCard`, `questionFromChoices`, `answerComplete`, `answersAsMessage` | ASK2 (Claude), later question lanes (Codex, Fuigo/ACP, Pi, Telegram) |

## Routes (all wired in `server/index.ts`; modules own the behaviour)

| Route | Module entry point | Authority | K0 answer |
|---|---|---|---|
| `/api/workspace-files` and `/api/workspace-files/*` | `workspaceFilesRoute(request, deps)` in `server/workspace-files.ts` | Desktop proof. The entry is in `DESKTOP_AUTHORITY_ROUTES` (GET/POST), and the module hides every non-desktop call (404). | desktop 501 `{code:"not-implemented"}` |
| `/api/media`, `/api/media/resolve`, other `/api/media/*` | `mediaAssetsRoute(request, deps)` in `server/media-assets.ts` | Desktop proof (`DESKTOP_AUTHORITY_ROUTES`) | desktop 501 |
| `/api/media/bytes/<assetId>?cap=` (GET/HEAD, single range) | same | U-03 capability, deliberately exempt from the desktop header, which media elements cannot send. Until F5-T1 issues capabilities, non-desktop callers get 404. | desktop 501 |
| `POST /api/internal/resolve-image-reference` | `resolveImageReferenceRoute(request, claim, deps)` | Active `agents` internal capability. Identity (`botId`/`threadId`/`generation`) comes from the claim, never from the body. | 501; GET 405 |

Modules return `DelegatedResult {status, headers?, body?, bytes?, stream?}`, and `sendDelegated` writes it (`server/route-delegation.ts`). `deps` is `{dataDir, database, store, artifactScopes}` (`featureRouteDeps` in index.ts). Adding a dependency is a one-line change to that object. The routing lines stay as they are.

## Hooks (`server/output-publication.ts`, created once as `outputPublisher`)

- `beforeDispatch({botId, threadId, runId: dispatchClaimId, workspaceRoot: cwd, managed})` runs synchronously at dispatch, after the workspace claim and before the provider sees the prompt. `managed` is true only for the Murage-managed dedicated task workspace (not a custom folder, not a cloud run). It must not throw.
- `publishTerminalOutputs(event)` runs once per `turn.completed` in the main event fold, right after terminal-message marking. It sits **outside** the direct-run lease-release block, so R1-T2 and R3-T3 edit different hunks. It should not reject; index.ts logs a redacted message if it does.

## Schema (`server/artifacts.ts` `initializeArtifacts`, idempotent, frozen)

- `artifacts` gains nullable `producer TEXT` and `publication_id TEXT`, added with guarded `ALTER TABLE`. The existing `run_id TEXT NOT NULL` stays the run column, with `''` meaning unknown. The INSERT now names its columns.
- New `output_publications(id PK, producer, bot_id, thread_id, run_id, path_token, sha256, mime, bytes, stage, artifact_id?, attachment_id?, message_id?, error_category?, created_at, updated_at, UNIQUE(producer,bot_id,thread_id,run_id,path_token,sha256))` with indexes on `(bot_id,thread_id,run_id)` and `(stage,updated_at)`. Stage and producer values are validated in code with the shared guards (no SQL CHECK), so the enums can grow in a later release without a table rebuild.
- **No lane edits the schema after K0.**

## Rules

- **OUTPUT_NAMESPACE (U-02).** Only `outputs/` directly beneath a Murage-managed dedicated task workspace qualifies (`ensureTaskWorkspace`/per-bot default; never a custom cwd, project or HOME). Take a snapshot of `(name,size,mtime,dev/ino)` in `beforeDispatch`, and diff it on `turn.completed ok:true`. Only regular files of at most 25 MiB qualify, at most 20 per turn, with one host card per turn. Cancelled or failed turns leave receipts `retained` and do not auto-register them. Files outside the namespace stay discoverable without invented authorship.
- **Media capability (U-03, U-04).** Use a short-lived HMAC over asset + revision + surface `desktop`, with a 10-minute TTL, sent as `?cap=` on the loopback byte route. Redact it in logs with `redactMediaCapability`. Send `Referrer-Policy: no-referrer`. The reusable desktop secret never appears in a URL. All new routes are desktop-only in 0.1.52, and the companion allowlist stays default-deny (pinned by `companion/test/routes.test.ts`).
- **Image references.** Resolve every reference to pinned bytes before approval or billing. One failed reference fails the whole request, with no silent subset, no provider fallback and no numeric seed substitution.
- **Close-confirmed stop (A2).** A requested kill or an acknowledged cancel is not closure. Keep resource ownership until `closeConfirmed:true`, and retain it on timeout.
- **i18n (U-25).** Add English strings to `src/locales/en.json` only, under a key prefix for your area. Do not edit other locales or `source-hashes.json`; Q1-T4 regenerates them. An `i18n:check` failure caused only by that is expected.
- **Dependencies.** Tiptap `@tiptap/{core,pm,react,starter-kit,markdown,extension-table,extension-task-list,extension-list}` is pinned exactly to `3.31.3` in K0 (React peer `^17 || ^18 || ^19`). No other lane changes `pnpm-lock.yaml` except Q1-T3, and Q1-T3 runs alone.

## Amendment A1 — agent questions (ASK1 + ASK2, `0152-ASK-USER-RESEARCH.md` §4)

Additive only; every field is optional and older consumers keep working.

- **`RuntimeEvent` `request.opened`** gains `questions?: QuestionSpec[]` next to the existing `questionTool?: true` (ASK1). `summary` stays the first question's text and `choices` its option labels, so voice (`CallView`/`GroupCallView`) and older clients degrade gracefully.
- **`ProviderAdapter.respondToRequest`** decision gains `answers?: QuestionAnswer[]`. `message` stays the same answer as plain text for drivers that read one string. A `deny` on a question is an honest "no answer" (skipped), never a refusal — the broker used to reject it, which left the engine waiting out its whole timeout.
- **`OptionCardData`** (`server/store.ts` and the renderer's mirror in `src/state/store.tsx`) gains `questions`, `answers`, `expired`, `sentAsMessage`, `unattended`. Cards persist in `messages.db`, so a question survives a reload; a boot sweep marks anything still open as Expired.
- **Routes.** `POST /api/bots/:id/respond` and `POST /api/threads/:id/respond` accept `answers` (validated against the persisted card) and `behavior:"skip"`, plus `{behavior:"answer", answers, sentAsMessage:true}` to record an expired question's late answer after it went out through the ordinary composer route. A question is never answered with `allow`.
- **`DecisionKind`** gains `question-expired` and `question-skipped`. An answer itself is conversation, not authorization, and is never logged; a secret question's answer is never written to the transcript or the log.
- **Normalizer.** `server/question-normalize.ts` owns every engine mapping (`fromClaude`, `fromMuragebox`, `toClaudeAnswers`, `toMessageText`, `validateAnswers`, `parseAnswers`, `answersFromMessage`, `recordableAnswers`, `QUESTION_NOTES`). Engine input becomes a card only once it is bounded and well formed. Later question lanes add `from*`/`to*` pairs here rather than in a driver.

## Merge-order hotspots (lane map §2)

| File | Owners (region) | Risk | Order / mitigation |
|---|---|---|---|
| `server/index.ts` | K0 stubs · R1-T2 (interruptDirectThread, terminal lease block) · R3-T3 (hook body, `artifactScopes` runId, register) · R1-T6 (approval join) · R3-T4 and F5-T4 (image MCP route) · R2-T3 (provider replace, conditional) | H | K0 → R1-T2 → R1-T6 → R3-T3 → R3-T4 → F5-T4. R3-T3 fills the module, not the call sites. |
| `server/index.test.ts` | R3-T3 (register case) · F1-T3, R3-T4, F5-T4 (image MCP scenario) | H | One owner at a time for the image scenario: F1-T3 → R3-T4 → F5-T4. Others add new `it()` blocks. |
| `electron/main.mjs` | R2-T2 · R2-T1 · R2-T4 · R2-T5 · R2-T3 · S1-T2 · S1-T3 (sweep) · F4-T5 | H | S1-T3 runs after R2 and S1-T2 merge, and F4-T5 after S1-T3. Everyone else uses `main-trust.mjs`. |
| `electron/preload.cjs` | S1-T3 · F4-T5 | M | F4-T5 after S1-T3 |
| `server/artifacts.ts` | K0 DDL · R3-T1 (export validators) · R3-T3 (register runId/producer) · F4-T1 (save-version) · F5-T1 (read) | M | All DDL is in K0 |
| `server/image-operations.ts` (+test) | R3-T4 · F5-T4 · F1-T4 | H (test) | R3-T4 → F5-T4 → F1-T4 |
| `server/image-generation.ts` | F1 lane · F5-T4 (only if needed) | L | single F1 lane |
| `server/drivers/agents-proxy.ts` | R3-T3 · F5-T4 | L | — |
| `src/components/ChatView.tsx` | R0-T1 · F5-T2 · U0-T1 · F4-T3 · F5-T3 | H | R0-T1 → F5-T2 → U0-T1 → F4-T3 |
| `src/components/ChatMarkdown.tsx` | U0-T3 · F4-T6 · F5-T2 · F5-T3 | M | U0-T3 → F5-T2 → F4-T6 → F5-T3 |
| `src/components/Files.tsx` | F5-T2 · R3-T2 · F4-T3 | H | F5-T2 → R3-T2 → F4-T3 |
| `src/components/AttachmentPreview.tsx` | F5-T2 · F5-T3 | M | serial in the media lanes |
| `src/state/store.tsx` | F4-T3 (+ R3-T2) | L | — |
| `server/drivers/acp/core.ts` | R1-T2 · R1-T8 · R1-T4 | H | same lane, serial |
| `server/drivers/pi.ts` | R1-T2 · R1-T5 · R1-T6 | L | merge R1-T5 and R1-T6 first |
| `server/drivers/claude.ts` | R1-T1 · R1-T4 | M | R1-T4 after R1-T1 |
| `server/procs.ts` | R1-T2 · R1-T8 | M | same lane |
| `server/contracts.ts` | K0 · R1-T2 | L | shape frozen here |
| `electron/secure-credential-state.mjs` | R2-T3 · R2-T5 | M | same lane |
| `electron/skill-recorder.mjs` | R2-T1 · R2-T4 | L | same lane |
| `companion/src/browser.ts`, `devices.ts` | S1-T4 · S1-T5 · S1-T7 | M | same lane |
| `installer/bin/murage.mjs` | F2-T1 · F2-T3 · F2-T4 | M | same lane |
| `cloudflare/composio-broker/src/index.ts` | F3-T1..T3 | M | same lane |
| `package.json` / `pnpm-lock.yaml` | K0 (Tiptap) · Q1-T3 · Q1-T4 · S1-T2 (optional script) | H (lockfile) | Tiptap lands in K0; Q1-T3 later and alone |
| `src/locales/*.json` + `source-hashes.json` | every UI task | H | English keys only, under a lane prefix; Q1-T4 regenerates once |
| `.github/workflows/ci.yml` | Q1-T1 · S1-T2 (optional) | L | — |

## F4-T1 notes (lane W_F4T1, no shared shape changed)

- **Routes served.** `GET read` (200 `WorkspaceReadResult`), `POST write` (200 `SaveReceipt`), `POST save-version` (201 `WorkspaceSaveVersionResponse`). A wrong method answers 400 `invalid-request` without reading a body; non-desktop callers still get the hidden 404.
- **Body bound.** `DelegatedRequest.readBody(maxBytes?)` gained an optional per-route bound (default unchanged at 1,000,000 bytes in `server/index.ts` `readBody`). `write` uses `WORKSPACE_WRITE_BODY_MAX_BYTES` (6 × 2 MiB + 64 KiB, because JSON escaping can grow text six-fold). `save-version` uses 64 KiB. Reason: the frozen 2 MiB text bound could not be saved through the old 1 MB body bound.
- **Bot-active hold.** `featureRouteDeps` gained `projectFolders: projectTurnLeases.folders`. Every local bot turn already holds a writer lease on its working folder. An overwrite takes a restore-mode lease on the workspace for its synchronous commit window: an overlapping bot turn answers 423 `bot-writing` (nothing written), and no bot turn can start inside the window. Without `projectFolders` an overwrite fails closed with `bot-writing`. `baseRevision: null` (Save a copy) is an exclusive create (`link`, never replaces) and is allowed while a bot works. External programs do not take Murage leases; the identity recheck just before `rename` narrows but cannot close that race.
- **`SaveReceipt.artifactId`.** Before every overwrite, the revision being replaced is kept as a saved version in Files through `registerArtifact` (idempotent, no producer/run). `artifactId` names that saved version. If it cannot be kept (507 `quota-exceeded`, or `write-failed`), nothing is overwritten. A save of the unchanged bytes rewrites nothing and returns the same revision with no `artifactId`. A create has no prior revision and no `artifactId`.
- **Scope of writes.** Only `.md`/`.markdown`, ≤ 2 MiB including the BOM, well-formed Unicode (a lone surrogate is refused rather than written as U+FFFD), in a root Files already authorizes for that exact conversation (a managed workspace dispatch has not pinned yet is `scope-unavailable`). Files and folders are never created implicitly; the existing file mode is preserved and a new file is 0600. Reads accept any strict UTF-8 regular file ≤ 2 MiB. Hard-linked files answer `not-regular-file` (discovery gives them no revision). A file that changes while it is read answers `revision-conflict` without `currentRevision`.
