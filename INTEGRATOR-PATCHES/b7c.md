# B7c (landing rules and notice for automatic skill and routine changes): notes for the integrator

No change to server/index.ts or memory/schema.ts is needed. createProcedureReviewHost (already called in index.ts) now
registers the landing host itself, reads the bot's "Ask me first" from `store.bot(ownerId)` and the routine from `options.routines()`.

Shared-file edits made (small, listed so B11 and the integrator can merge them):
- server/memory/learning-history.ts: Undo/Keep route for `guide-applied` events (changeProcedureEvent); each history event now carries `procedure`.
- server/bot-lessons-routes.ts: the chips answer also includes procedureChipItemsForThread.
- server/bot-suggestions-routes.ts: the Suggestions list, apply, edit and not-now also serve ids starting `psug-`.
- server/memory/evolution-forgetting.ts: the existing sweep also drops proposedText, beforeText and editedText of a forgotten suggestion.
- server/memory/procedure-review.ts: new optional host methods `landing` and `appliedChange`; no host that lacks them behaves differently.
- server/skills.ts: new publishOwnerEditedScopedSkill (the owner's edited words, no scores).
- shared/learned-chip.ts: chip kind and template group "improved" (6 templates, learnedChip.improved.N).
- NOT touched: lessons.ts, bot-shapes.ts.

Follow-ups not in this batch:
- Inbox: procedure suggestions appear in Learning > Suggestions only; the Inbox card (inbox-learning-suggestions) is lesson-shaped.
- The chip appears when the thread's chips are next read; there is no live frame for it yet (B5m's learning.remembered is memory-only).
- The Edit field for a skill is the single-line field used for lessons, with a 20,000 character limit; a multi-line editor is a UI follow-up.
