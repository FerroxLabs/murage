# Pending remote fixture extension

Proposal only. Do not apply or run until Sean explicitly extends the two-round limit. Candidate remains `ae674dea`; no production change is proposed. Apply from `/Volumes/Mando/WaylandBots/murage-astra/.planning/swarm-0150-cloud-window`.

The patch moves the standalone Node native runner outside Vite's `electron/**/*.test.mjs` discovery and uses the existing launcher's fixture-only instrumentation hook to serve the already-built UI. `fileURLToPath` preserves filesystem paths containing escaped characters. The instrumentation runs before `server/index.ts` imports, so its existing MURAGE_STATIC_DIR setting is captured correctly.

```diff
*** Begin Patch
*** Update File: electron/server-connection.electron.test.mjs
*** Move to: electron/server-connection.electron-smoke.mjs
@@
 import { createRequire } from "node:module";
+import { fileURLToPath } from "node:url";
@@
-  const engine = await launchVerificationServer();
+  const staticDir = fileURLToPath(new URL("../dist/", import.meta.url));
+  const engine = await launchVerificationServer(process.env, undefined, {
+    instrumentationSource: `process.env.MURAGE_STATIC_DIR = ${JSON.stringify(staticDir)};`,
+  });
*** End Patch
```

Exact single confirmation command, after applying that patch in the isolated worktree:

```sh
rtk proxy /Users/seandonahoe/.nvm/versions/node/v24.20.0/bin/node --test electron/server-connection.electron-smoke.mjs
```

Node executable verified read-only with `--version`: v24.20.0. The server launcher uses `process.execPath`, so the fake-engine harness also uses this Node24 binary. Native renderer remains Electron43.4.0. Existing `dist` was built successfully in this worktree during the original fixture preparation; if candidate renderer sources change before approval, that prerequisite becomes stale and root must include rebuilding it in the authorised extension rather than silently reusing it.

Expected disposition: terminal native pass plus its screenshots/chat evidence and owned cleanup, or one precise failure with no automatic retry. Current state: paused, no patch applied and no confirmation run.

2026-09-10 current dispatch: user explicitly approves blocked closeouts; root
assigns create-bot201 correction and ONE native confirmation, preserving original
2rounds plus prior static/discovery extension. StaticDir and runner rename are
already prepared in the worktree; candidate remains ae674dea, dist exists.
Read-only preflight identifies further stale fixture assertions: send expects200
but index.ts11087 returns202; reply expects role assistant but Murage stores bot.
Existing create-bot greeting could also satisfy a naive bot-role replacement.
Proposed exact compatibility adjustment: create201, create fresh empty task201
(index.ts11325), assert empty messages, send202 with explicit threadId, require
new nonempty bot text reply. Preserve pairing/authority/renew/revoke/disconnect
and local-session assertions unchanged. Root notified for scope disposition
before the sole run; no native invocation or fixture correction spent yet.

Root approves all identified preconditions before ONE run: create201, fresh
emptytask201, matching bot/thread IDs, explicit send202 receipt.threadId, new
nonempty rolebot text from that empty thread. Applied only these fixture changes;
all original authority/pairing/renew/revoke/disconnect checks retained. Frozen
command above uses existing built ae674dea renderer and explicit Node24. No
product edits, owner preview or live profile. Stop on further failure.

Confirmation6960 exit1 in10.7s: native ready, isolated prompt/cancel/connect,
sandbox/no-preload/no-Node exposure, pairing/full renderer, fresh task and fake
chat reached; safe chat receipt/screens retained at
`/var/folders/8h/chxws5390hx17g49p75b2xn00000gn/T/murage-server-window-proof-2oh7OF`.
Server evidence log `server-1789020426057-28051.log` in murage-verification-evidence.
FAILED preserved forwarding assertion expecting x-murage-surface=browser.
Read-only diagnosis: companion/src/browser.ts448–461 builds headers from nothing,
strips client surface and stamps x-murage-companion=1 (remote authority). Fixture
records only surface and therefore tests the wrong established protocol.
Proposed recorder addition: companion:req.headers['x-murage-companion']; require
companion==='1', surface===undefined, secret===undefined on forwarding. No
product/header policy change or assertion reduction. Renewal/revoke/disconnect
unreached; full acceptance BLOCKED. Original2rounds+staticextension+thisextension
consumed. No further correction/run; root notified. Existing fixture finally
destroys windows/closes gateway and engine; no normal profile touched.

2026-09-10 resumed closeout: user "blitz all, no limits, no new features" authorizes targeted fixture corrections and confirmation beyond the historical limits, which remain recorded above. Parent assigns this existing cloud gate after accepted Flux entrypoint closure. Outcome and acceptance remain real native prompt/cancel/connect, isolated sandboxed remote window, pairing, full renderer, fresh fake-engine chat, gateway authority, denied config mutation, renewal, revocation, disconnect cleanup, and intact local session. Scope: correct only the evidenced header recorder/assertion to the current forwardedHeaders contract (companion=1, no surface or surface-secret); preserve every remaining assertion. No product change, real credentials, owner data, provider calls or publication. Current ae674dea renderer source is unchanged and existing dist remains its prerequisite. Prior native fixture processes are absent. Frozen check: the single Node24 native smoke command above; inspect resulting screenshots and receipts; accepted fixture commit on pass, otherwise specific failure diagnosis before further correction. Preserve prior rounds/extensions without reset.

Header confirmation PASS 1/1 in 9.25s, native READY/PASS receipts. All gateway/chat/renew/revoke/disconnect/local-session assertions executed. Evidence /var/folders/8h/chxws5390hx17g49p75b2xn00000gn/T/murage-server-window-proof-LeR7i6; server receipt server-1789025668336-71721.log, owned engine PID71832 exited. Visual review: prompt focus and revoked sign-in render correctly; existing connected screenshot occurs at root mount and captures the startup spinner, so it does not yet show a connected workspace. No product defect evidenced. Tighten only this same full-renderer fixture checkpoint using actual App.tsx/Sidebar.tsx UI: navigation mounted and "Connecting to the bot server…" absent before capture. Parent notified. Repeat the one native journey to confirm this corrected visual prerequisite; retain all existing assertions and previous evidence. No source changes or broad reruns.

Connected-state confirmation reached connected workspace and produced inspected connected.png, then completed fresh chat, forwarding, deny, renewal and revocation assertions. Runner FAIL 1/1 (5.73s) on Electron UnknownVizError while capturing revoked-sign-in immediately after loadURL; evidence gChIdp has prompt/sign-in/connected/chat but no revoked-sign-in file. Server log contains only normal startup; owned PID80681 exited. This is a fixture screenshot timing failure after navigation, not a failed authority/lifecycle assertion. Add a double requestAnimationFrame wait to the fixture screenshot helper before capturePage so navigation paints before capture, then confirm the same native journey. Existing assertions are unchanged; no snapshot failures suppressed or retries added.

The double-animation-frame capture wait is unsuitable: juCwgz produced prompt/sign-in only, then the renderer promise did not complete; existing 60s runner timer terminated it (no native PASS; owned PID87490 exited). Remove that unbounded wait. The bounded replacement retries only the observed capturePage UnknownVizError, at most three capture attempts separated by the existing 100ms pause, logs each retry, fails on any other error or third failure and rejects empty images. It never retries a product action/assertion or the full test. This repairs evidence collection while preserving the actual full-renderer/lifecycle contract. Parent notified; final confirmation remains the one existing native journey.

Final disposition ACCEPTED. Node24 v24.20.0 native smoke 1/1 PASS, zero skipped/cancelled, 18.53s terminal duration, native READY/PASS; no capture retry was needed on this run. The real isolated Electron remote window pairs, mounts and connects the production renderer; a fresh empty task receives its own fake-engine reply. Gateway forwards companion=1 with surface/secret absent; config mutation denied403; renewal rotates cookies; revoked device gets401; disconnect clears remote cookies; default-session cookie and local editable window survive. Full original assertion set completed. Final evidence /var/folders/8h/chxws5390hx17g49p75b2xn00000gn/T/murage-server-window-proof-H2XMw6; log server-1789025902176-98018.log; owned engine PID98191 exited. Connected and revoked-sign-in screenshots inspected; connected capture shows the connected empty-workspace state, with the prior gChIdp connected capture also showing initialized Ember. Fake chat is proven through the native renderer's fetch and saved thread receipt, not a composer gesture. All windows/gateway closed by fixture cleanup; isolated evidence retained. Production cloud hosting, real provider calls, other native platforms, and publication are not claimed. Fixture-only commit is ready for root integration; no background cross-model audit or broad rerun.
