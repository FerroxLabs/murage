# HighLevel F0.2.3 live approval invocations

`runApprovedInvocation(journal, approvalId, requestDigest, invoke)` in
`server/highlevel/approval-invocations.ts` registers the live owner synchronously.
Call it as soon as approval identity is known, before the first post-approval
await. Every original and replay path must use the same journal storage key and
approval ID. A concurrent caller joins the owner, including when no approval
journal entry exists yet. A different request digest refuses the join.

The callback owns authorization, dispatch preparation, `runApprovedWrite`, and
its durable outcome. Each caller independently checks authority before releasing
the returned result. Results are cloned. Completion or rejection clears live
ownership; no timer can make an active invocation look interrupted. After a
restart, the durable RPC association/pending approval triggers read-only
reconciliation. The registry does not replace the journal or provide an
interprocess lock.

`runRpcApprovedWrite` now applies this boundary before its first post-prepare
authorization await. It retains the RPC-keyed join covering preparation before
an approval is known. It handles different RPC references to the same approval,
checks each caller's authority, and retains the F0.2.2 recovery contract.

Do not wrap `runRpcApprovedWrite` in `runApprovedInvocation` for the same
approval: the RPC helper owns that boundary. A manual host path may wrap its
`runApprovedWrite` call and the awaits preceding it. Do not recursively enter
`runApprovedInvocation` for an approval already owned by that callback.

## Lane adoption

The shared host and family dispatchers remain placeholders. For the host reviewed
at `fd225afa5`, in `#reviewedRequest` obtain and validate the durable approval ID
and request digest immediately after `awaitDecision` returns `approved`. For
writes, enter `runApprovedInvocation` **before** `#stillAuthorized` (reviewed
line 472). Move that authorization, approval-context validation, dispatch
preparation and `runApprovedWrite` (reviewed line 535) into the callback. Keep
`#publishWrite` and its per-caller release check after the returned outcome. Keep
the reviewed-read path separate.

In `#replayWrite`, retain its own authority/binding checks, then wrap the existing
`runApprovedWrite` (reviewed line 611) in `runApprovedInvocation` with the original
approval ID and request digest. A duplicate that authorizes before the original
now joins the original's registered work. Without a live owner, use the durable
F0.2.2 read targets/effect comparison for **both** the missing-claim and pending
callbacks; neither may resend or blanket-settle `unconfirmed` without the read.

hlf1/hlf2 hosts adopting `runRpcApprovedWrite` receive this boundary internally.
Their `prepare` must return the frozen association immediately after approval;
post-approval asynchronous checks belong in `authorize`, not in a gap before the
shared boundary. Hosts retaining the manual paths above must wrap both paths.
The same applies to hlc2. Preserve F0.2.2 tag confirmation, durable associations,
approval retention, and result-envelope mapping; no wire/identity schema changes
are needed for F0.2.3.

## Verification

Run tests only in an isolated container/fixture, following the job's execution
rules. The regression suite is `server/highlevel/approval-invocations.test.ts`.
It uses temporary journals and an ephemeral loopback HTTP provider. Its exact
reviewer-ordering witness records duplicate authorization before original
authorization, zero pre-resume journal entries, exactly one PUT, zero GETs, and
identical applied outcomes. Another witness crosses RPC keys with one approval.

Child-process witnesses exit after the RPC association but before the approval
claim, or after the provider PUT but before settlement. Restart performs exactly
one reconciliation GET and zero resends; terminal replay adds no read. The
before-claim case confirms non-application; the after-send case confirms the
approved effect.

The required mutant replaces `const running = live.get(key)` with an absent
running entry. The reviewer-ordering and cross-RPC witnesses must fail. Keep the
JSON test reports and exact mutation/run commands with the job evidence. Launch
the isolated fake-engine Murage fixture and run Doctor with its explicit URL as
specified in the verification README. Startup/Doctor and the shared boundary
tests do not prove that a lane's production host has adopted the integration.
