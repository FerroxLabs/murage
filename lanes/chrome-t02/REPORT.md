# T02 report
Head: see git log on lane/0162-chrome-t02. Files: server/browser-floor.ts, server/browser-floor-lexicon.ts, shared/browser-floor-signatures.ts, server/browser-floor.test.ts.
Red: lanes/chrome-t02/red.log (module missing on base, suite fails). Green: 160/160, both tsc clean (Hetzner).
Full suite (Hetzner, loaded box): 19783 tests, 112 failed vs BASELINE-next 97 entries; 18 extra failures all in files that never import the new modules (backup, comms, acp, codex, index harness, shared-wire, data-safety, safe-wipe, etc.), consistent with timeouts at load 170. Nothing imports browser-floor yet, so no interaction is possible.
