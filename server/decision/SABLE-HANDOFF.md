# Sable item 7: production owner handoff

Owner: **S4 integrator**, exclusive file `server/index.ts` (DESIGN-ONERULE-r3.1 §C).
This is the exact other slice owning the producer that still cards owner turns
and owner routines at No limits after outside reads. S1 does not claim that the
unintegrated application has zero cards.

The legacy engine request producer computes `routineTurnApproval` at lines
9713 onward from `turnOutsideRead`, calls the inert BASE compatibility adapter
`approvalDecision` at 9994, and writes its options/card with `pushMessage` at
10000. Its alternate routine answer paths at 9817/9820 and 9909 also use that
adapter. Working-folder refusal at 9704/9707 is another branch of this producer.
The BASE callback still returns `outside-turn` (auto-approve.ts 1273) and
`unreadable` (941 and reader findings). That is input to the registered decision,
not permission to present a card. The DB seam rejects an unregistered card.

S4 must install the declared ingress/provenance/transport/host adapters, use
`openRequest({kind:'engine',threadId,requestId})`, pass the legacy verdict as
`decide`'s BASE callback, deliver RUN/refusal through `deliverRequest`, and
present only the issued ref. Routine actor provenance must come from the live
run/wake/peer/project-room source, never from outside-read state. S1 provides
these APIs through `decision/index.ts`; no S4 implementation was copied here.

`server/decision/sable-shapes.test.ts` is a fake-transport shape replay, using
the real autoVerdict BASE callback: web page, earlier turn and cloned folder;
Bash, Write, artifact registration, quote batch, browser open/screenshot/title,
Thrivecart and connectors; eight heredoc/redirect write shapes. Both registered
owner and owner-routine actors produce 51 Allow witnesses and zero records/cards.
The owner BASE callback still produces 51 legacy holds; the owner-routine BASE
callback produces six. These counts explicitly expose the remaining integration
work. B1 mutant restores BASE holds on the registered owner branch and is killed.
This does not claim to reproduce private historical command text or dispatch
through S4's production wiring. Protected target twins are tested separately in
review-blocks.test.ts and the existing faults/exec-mode suites.
