# sc-cloud independent copy review

Reviewer: sc-cloud-r3 builder, 2026-11-13. This is a fresh textual review of the
merged lane, written by the reviewer; prior lint receipts are supporting checks.

References: `/fixture/jobs/_designs/MURAGE-UX-BAR.md` (the supplied
`designs/MURAGE-UX-BAR.md`, locked 2026-11-09), `release-notes/1.0.19.md`, and the
complete added-source inventory at
`/fixture/jobs/sc-cloud-r2/evidence/new-english-source-inventory.json`.
The release note says only “Murage 1.0.19 includes Fuigo 1.0.43.” It makes no
Cloud availability, sign-in, migration or permission promise that conflicts with
this lane. No release-note expansion is needed to approve this copy.

| Surface | Review and decision |
| --- | --- |
| Cloud sign-in status and refusal, `server/cloud-home/copy.ts` | Approved. Names the bot and Antigravity, states the current state and gives one action: sign in, retry, or check Connect. The sign-in-code refusal directs the user to the sign-in dialog. It makes no promise to forward or retain the code. Legacy Google code strings are unchanged and are not production ingress responses. |
| Google/Antigravity confirmation, `EngineSignIns.tsx`, `BotSignInOffer.tsx`, `engine-login-terminal.ts`, `EngineLoginTerminal.tsx` | Approved. The confirmation names the bot and Cloud home; replacement is stated before Continue when an existing sign-in is present. Continue and Cancel use familiar words. The code field stays masked, the instruction identifies Google's code, and status appears as words. No OAuth/epoch/FD terminology is introduced on the surface. |
| External browser client recovery, `browser-extension-mcp.ts` | Approved. Explains that the data folder moved and tells the user to pair again and replace the configuration; no silent rewrite of unknown client files is promised. |
| Browser helper and login-item repair failures | Approved. Existing repair wording remains specific to the browser helper or login item. Internal root-path constructors and receipt fields remain implementation details. |
| Recovery, VM, and Flux manifest diagnostics | Approved as diagnostics. These describe a refused or failed operation; they do not promise successful migration after refusal. Ordinary controls retain their existing labels and defaults. |
| Paired DM and ONECODE | No new end-user English in the merged runtime requires a new action label. Authority and admission checks introduce no new permission card or owner claim. |

Disposition: approved for this lane's added/changed English; no genuine copy
conflict found. This review does not claim a packaged visual/click review or a
new translation review. Neither the UX bar's cross-platform visual proof nor
independent release qualification is replaced by this textual approval.
