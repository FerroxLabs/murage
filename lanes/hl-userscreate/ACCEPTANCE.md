# users.create redesigned acceptance matrix

Binding MAIN rulings of 2026-11-11 supersede the native password acceptance rows in `docs/verification/evidence/bld-hlpw3/README.md`. The old records remain historical evidence. Removing their code or tests is not acceptance. The replacement checks below are the active matrix for this lane.

| Row | Removed | Retained or replaced check | Qualification |
| --- | --- | --- | --- |
| R1 | Native password readiness | Full users grants, verified scopes, end-to-end access | Fake full-grant host; production grant/scope prerequisites remain enforced. Default false recipient flag prevents automated creation. |
| R2 | Secret submission routes, native nonce/session and password IPC | Authenticated exact approval and one-use dispatch | Ordinary desktop digest approval, durable dispatch barrier, in-process one-use template; retired HTTP routes return 404. |
| R3 | Password-field capture protection and native input/read blocking | Owner authority; no secret tool/model access | Direct owner provenance rechecked; password-free strict tool schema and exact review. |
| R4 | Custom password entry and renderer generation | Private generation and provider-policy validation | OS randomInt rejection sampling, four required classes, shuffled 32 ASCII bytes, provider schema validation before send. |
| R5 | Persistent secret dialog and expiry-clearing handshake | Ordinary review, cancellation and Stop | Ordinary rendered-value approval, cancelled admission creates no credential; a sent request is not recalled. |
| R6 | Clipboard retention, history/sync and death clearing | Prove no secret export exists | No password IPC, widget, renderer generator or clipboard action remains. Shared clipboard keeps its original trust checks. |
| R7 | Secret renderer/main IPC surfaces | Transport, logging, transcript and response leak protection | Fixed HTTPS origin, manual redirects, one bounded POST; response projection, encoded echo refusal and injected-secret scanner/grep. |
| R8 | Secret-dialog restoration | Durable dispatch/identity crash recovery | File action/approval journals and SQLite identity barrier survive settlement interruption and restart. No credential retry state. |
| R9 | Desktop completion recovery | Conservative reconciliation and duplicate prevention | Complete, empty, partial and contradictory restart inventories; only read reconciliation, zero replacement creates. |
| R10 | Widget/clipboard interception | Successful whole-flow leak checks | Isolated control fixture with fake provider; private transport, journals, transcripts/results, WAL and archives scanned. Positive controls and secret-result mutant required. |
| R11 | Native capture/input adapters; secret-bearing renderer/main variants | Secret-bearing server memory and crash qualification | Owned buffers cleared in finally on success, echo, refusal, redirect, timeout, disconnect and Stop. Settlement crash/restart covered. No universal V8/TLS, OS swap, or native process dump erasure claim. |
| R12 | Packaged native password UX | Ordinary packaged approval/recovery qualification | Source/UI approval tests and isolated server fixture. Interactive packaged desktop remains unqualified on this Linux container; no Mac use. |

Required mutants: result secret echo, replacement create on restart, missing finally clearing, recipient flag default true. Each must fail a named behavior assertion against a passing baseline, with source hashes restored.

Recipient access is deliberately not certified by fakes. `HL_USERSCREATE_RECIPIENT_VERIFIED` accepts only literal `true`; unset and every other value are false. MAIN alone flips it after Sean authorizes a live new-account recipient access check. False gives the exact external handoff and Open HighLevel link; true gives the ordinary Add user review. No invitation or email-delivery claim.
