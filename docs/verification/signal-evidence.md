# Signal evidence binding

The release assertion and activation gate must verify the same reviewed G0
manifest. A matching SNAPSHOT version is not identity. The committed pin stays
`g0: null` until scrubbed live captures and their independent review exist;
`signalNetwork.syncProof` stays null until its separate source review agrees.
Synthetic test inputs do not satisfy either obligation.

The non-null `g0` record includes `signalCliVersion`, the full
`signalCliCommit`, `manifestSha256` (the SHA256 of the exact manifest bytes),
`artifactSha256`, `reviewedBy`, `review`, and `citation`. The artifact binding is
SHA256 of recursively key-sorted JSON containing the full source commit,
version, signal-network version/hash, all target records, and all three
release inputs. Changing a jar, native library, JRE, archive, or input location
requires new evidence binding and review. Do not use a hash taken only from
the unreviewed manifest as the trust anchor.

The source manifest lives at `server/channels/signal/fixtures/g0/manifest.json`.
Staging copies that directory to the packaged runtime's `g0/`; startup verifies
those copies. Its contract is `murage-signal-g0/1.0`, with `capture: "live"`,
`signalCliVersion`, `signalCliCommit`, `artifactSha256`, `fixtures`, `results`,
and `securityInvariants`. A fixture row has a unique `id`, a flat `.json` path,
and a SHA256. Every file is checked, including optional captures. Symlinks,
missing files, unlisted files and duplicate identities/paths fail closed.

Required fixture IDs are version, listAccounts-one, listAccounts-two,
startLink, finishLink, subscribeReceive, own-note, edit, remote-delete, expiry,
owner-to-friend, desktop-note, own-echo, send-with-timestamp,
send-without-timestamp, other-account-text, other-account-attachment,
phone-removal, other-sender-sync, pni-sync, group-sync, history,
malformed-identity, long-text, and timer-update. Record a rate-limit fixture
if produced; its absence never authorizes retry (`rateLimitNotSentProof`
remains null).

`results` contains boolean `S1-TS` and `S1-ECHO` results. At least one must pass
before release or activation. The required `securityInvariants` are
authenticated-sender, pni-endpoint, own-echo, group, history,
malformed-identity, long-text, and immutable-expiry. Each result has
`passed: true` and a nonempty list of `fixtures` naming the captures evaluated
in review/replay. Any failed result (including an additional invariant)
blocks release even if its manifest digest was reviewed. A contradictory
capture is a blocker; it never authorizes weakening the admission rules.
The review must evaluate the raw captures against the production adapters;
the hash verifier establishes custody and does not replace raw replay,
source review, the S6 privacy audit, or packaged qualification.

The archive contract is `signal-cli.jar`, `lib/`, `native/`, and `jdk/` at
root. In the existing `prelinked-jre` format, `jdk/` transports the already
constructed JRE image, which staging copies to `jre/`. The pin's JRE digest
always describes the resulting `jre/` tree. For JDK inputs, jlink must produce
that digest; a digest of the input JDK cannot substitute for it.

`T-PIN-RELEASABLE` is a committed-configuration acceptance gate.
`T-RELEASE-NO-SKIP` guards workflow ordering. Archive hash and upstream JNI
checks already existed on 98f8a3ac5; they remain regression checks, not claimed
baseline RED. Full-rig absence is an open acceptance gate, not behavioral RED.
