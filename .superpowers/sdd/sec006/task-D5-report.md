# D5 report: device registry holds the approval key, set only at pairing

Summary: `DeviceRecord.approvalKey` added (additive, optional). `cleanApprovalKey` accepts only an 87-char base64url uncompressed P-256 point on the curve. `redeem` takes a fifth argument and stores the key only with a valid install id; nothing else writes it. `approvalIdentity(id)` returns `{id, cls, key?}`. The key is kept off `PublicDevice`. `BrowserDeviceStore` and `ProxyOptions` gained `approvalIdentity`; index.ts passes it to the proxy.

| Item | State |
|---|---|
| Tests written first; all 16 failed (no export, no method) | done |
| Implementation | done |
| devices-approval, devices, devices-push: 98 pass | done |
| tsc -b and tsc -p tsconfig.server.json clean (8 test fakes got an approvalIdentity stub) | done |
| Full companion run: 898 pass, 1 fail (server/companion-authority.test.ts "cloud desktop join route boundary ... real isolated harness", launches a real harness, not touched by D5) | noted |

Important notes
- Old records without a key load as before and cannot approve from the phone; they re-pair once (decision 2). The re-pair sentence is still P15, not part of D5.
- Redeem in index.ts proxy options and the browser door's redeem call do not yet forward installId or key; that is D6.
- P23: class app is claimed by sending an install id; no attestation exists on the desktop.
