# PKT0-19 handoff (2026-11-09)

Branch fix/1019-browser-pkt0 in bare repo build-host:/mb-105-git.git, worktree build-host:/fuigo-builds/pkt0/wt. Base 87d645cc6 (40b87b6ef + Hobart guard fix).

## Done (commits)
- 135942f82 OOPIF lock, built-in route: BrowserDocumentGuard asks the page session for child targets (Target.setAutoAttach, flatten), locks on any iframe target or on a failed or timed-out answer. Tests: server/browser-document-guard-oopif.test.ts (fake CDP) and .real-chrome.test.ts (real Chromium, two origins; red against base proven).
- 4d1eba950 OOPIF lock, extension route: Murage.getAllFrames (runtime.mjs, webNavigation.getAllFrames), frameLockVerdict + executor.frameVerdict, service wires transport.frames. Test: server/browser-extension-oopif.test.ts.
- 6482d13c9 frameUnsure is cleared by the next successful look that finds no frame (test: "doubt is not sticky").
- designs/AB-ENGINE-PATCH-1019.md: engine-listener sizing (Fix 1 engine part).

## Fix 1 status
Murage's relay (browser-native-relay.ts:389-420) is a WebSocket CLIENT, not a listener; there is no Murage-side handshake to put a token check on. Token enforcement lives in the engine (see AB-ENGINE-PATCH-1019.md). No Fix 1 code was written; this needs the engine-patch lane and Sean's vendor-binary decision.

## Open, in order
1. Extension lag (ruling 3). The extension is store-distributed (release.json productionIds), so it CAN lag the app. Today an old extension answers Murage.getAllFrames with method_denied and every page locks. Wanted: fall back when getAllFrames is missing. Note chrome.debugger Target.* is not in the extension METHODS allowlist, so Target.setAutoAttach cannot be reached on an old extension. Practical fallback: DOM.getDocument(depth -1, pierce true) and treat an iframe element with no contentDocument as out-of-process (the executor already reads this tree in closedRoot), lock only if both fail. Or add a capability name (for example frames_v1) so the server knows before asking. Not built.
2. tsc (pnpm exec tsc --noEmit) not run.
3. extensions/murage-browser/release.json has no digest field; check scripts/build-browser-extension.mjs and its tests for a hash of runtime.mjs, which changed.
4. Browser suite: command was run.sh "pnpm exec vitest run server/browser server/use-my-chrome server/drivers server/cloud-home" with output in build-host:/fuigo-builds/pkt0/wt/head-suite.raw (EXIT= marker at the end). It was still running when this was written (server/drivers has 15 s ACP waits). One failure seen so far: "NOLIMITS 1.0.19 U8: a fileChange on a marked turn registers its path" (looks unrelated). Run the same file on a BASE worktree (git worktree add build-host:/fuigo-builds/pkt0/base 87d645cc6, copy or re-install node_modules) and diff failing names; 0 NEW required. The suite run began before commit 6482d13c9 and picked up its edits partway; re-run the guard files after.
5. Astra read-only review: CODEX_HOME=~/.codex-acct6 codex exec -m gpt-6-astra --sandbox read-only "Do not execute any code; read only." on the diff (git diff 87d645cc6..fix/1019-browser-pkt0). Not run.
6. Diff file for Fable: build-host:/fuigo-builds/pkt0/pkt0-19.diff (git diff 87d645cc6..HEAD, written by this handoff).
7. Cleanup when the lane closes: build-host:/fuigo-builds/pkt0 (wt, ab-src, run scripts) and the worktree registration in the bare repo. No billable resources were created.

## Known limits of the shipped work
- A fresh iframe still loading when the check runs is seen at the next check, not this one (same snapshot timing as the existing guard).
- The extension frame check locks on a cross-origin frame (not strictly out-of-process); same-origin iframes keep today's behavior there.

