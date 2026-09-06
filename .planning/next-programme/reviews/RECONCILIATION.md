# Programme 2 plan review — reconciliation

Round 1 plan SHA256: `fc801cb55c374c689b1776d4722ef65f2c3e72a53a07323ec42ac6d663b023ea`.
Review context SHA256: `1a86bf9ef686acc2b3e7596c102d1df721c78967a15e2e2327b26cd417309e56`.

Requested reviewers: Fable and Gemini 3.8 Flash.
- Fable CLI observed primary `claude-fable-5-1`; output also records auxiliary Haiku usage. Verdict FLAG, seven findings. No source/tool writes by reviewer.
- Initial Gemini CLI invocation requested 3.8 but reported `gemini-3.5-flash`; this is NOT credited toward the requested gate. The earlier untrusted-directory startup failure did not run a review. Both receipts are preserved.
- Direct provider invocation observed **gemini-3.8-flash**, finish STOP, no tools. Verdict FLAG, six findings. Live model catalogue confirmed exact model availability. See `gemini-3.8-round1.json`.

## Required corrections applied

| Finding | Disposition |
|---|---|
| Fable F1 upstream owner gaps | P02 now binds all ledger groups to named owners or explicit deferral/rejection; notes distinguish research candidates from selected execution. |
| Fable F2 channel origin/authority | Common envelope retains channel origin, unattended restrictions and budgets. Content-bound receipts, not chat text, authorize changes; P12 negative control added. |
| Both Antigravity scope | P06 preserves community agy and explicitly defers absent managed-runtime chain/PR841/846. |
| Fable hosted identity/storage gates | P19 has named mandatory provider/host/storage/domain/retention gates; spec-only until actual values/owners are approved. Does not block offline sharing/downloads. |
| Fable recovery/host dependency | P04 can implement in parallel but cannot close abrupt-VM acceptance before P03's owned host is available. |
| Fable hiding/last-Chief | P08 explicitly evolves existing implementation, separating presentation hiding from role-changing archive semantics and preserving last-Chief protection. |
| Gemini 3.8 Browser availability | P07 cannot advertise headless readiness before P03 capability exists; explicit unavailable/setup state required. |
| Gemini 3.8 SOUL/schema conflict | P02 decision fixed before P09 schema: current storage retained; bounded SOUL instruction interchange plus existing manifests, no wholesale folder/permission migration. Full upstream backend migration explicitly deferred. |
| Gemini 3.8 WhatsApp external gate | P14 live provider verification blocks its acceptance only; independent P13/P15/Wave6 work advances. Required WhatsApp outcome remains open until actually proven. |
| Gemini 3.8 routine continuity | P11 opt-in bounded owned stored report, untrusted/fenced, no caller-selected arbitrary history/authority. |
| Gemini 3.8 no-search-provider state | P17 immediate actionable refusal; no fabricated results, hang or implicit paid fallback. |

## Additional safety clarifications

The misrouted 3.5 review raised transport, exported embedded-secret and headless-key concerns. These are supplemental observations, not the requested reviewer identity. Root retained the underlying useful concerns but rejected unsafe/overbroad prescriptions:
- No upstream public control tunnel/Tailscale Funnel. Use outbound Telegram/Slack/Discord transports; separately authorized minimal webhook collector for public SaaS sources, without admin/execution access.
- Scan selected export content as well as structured credential fields; no promise of universal malware detection.
- Headless browser key storage must handle absent interactive keychains, unreadable keys and fresh restored auth realms. Do not invent a global master-key environment variable or silently regenerate keys.
- Server-owned loop lineage/budgets cannot trust spoofable transit headers. Auto cannot infer paid permission or treat unknown cost as zero.
- Do not restrict WhatsApp to a VPS-only product merely to evade desktop usability; its explicit collector is a separate deployment prerequisite.

Round 2 will confirm the corrected plan with the same two requested reviewer families/models. No new feature scope or renewed audit of accepted 0.1.46 release checks is authorized by this reconciliation.

## Round 2 disposition and execution gate

Both requested reviewers completed round 2 on plan SHA256 `1346e66220e9acf7a0c9e05c4bdb170738140a56638344a2fba74443f74c1ae9`: primary Fable `claude-fable-5-1` and direct API `gemini-3.8-flash`. Both returned FLAG, explicitly allowing Wave 1 after their enumerated clarifications; neither returned unconditional PASS.

Root applied those clarifications: P03 explicit MCP/file ownership; P03/P04 exact installer seams; P04-A/local and P04-B/owned-VM acceptance ordering; named private-host/pilot/signing gates; P15 collector ownership and per-owner mutual authentication; early P11/P12 origin/budget enforcement; community agy diagnostic boundary; existing-Chief-preserving starter import; signing custody; receipt-schema freeze and optional broker decision. The five primary download links versus seven versioned verification payloads are explained. Research ledger candidate wording is subordinate to P02's binding ownership table.

Sean subsequently withdrew public distribution authorization. The final plan now expressly keeps repositories/releases/site/marketplace private until renewed permission. This narrows distribution, not feature implementation. No new third reviewer round is opened.

Verdict: **CONDITIONAL PASS for independent private/local implementation**. Live host/account/service gates remain required for their named acceptance criteria. P03 first MCP transport correction, P06 account-selection helpers and P04 recovery-coverage inventory can proceed without those external gates. These increments do not constitute completion of their parent packages.
