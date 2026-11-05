# UX-L3A-2 landing, round 2: stop guessing (1.0.17)

Two Astra BLOCKs (r1, r2) on the same item: the landing guessed which control a card owns (passes of switch, field,
button, link; then the siblings after a heading anchor up to the next id). The guess landed Memory import and Local
model servers on the wrong control, and a whole-card anchor (Starter profiles) could land on the NEXT card's switch
("Use house rules", BotsSettings.tsx:22). Per the house rule there is no third patch to the guess. This replaces it.

## The rule
1. Every registered card (SETTINGS_CARDS, 77 today) names its own landing with ONE attribute:
   `data-setting-control="<the card's anchor id>"`. The value is the anchor, so a mark can never be claimed by a
   neighbouring card, and a static test can count marks per anchor.
2. The mark sits on the control a person came for: the switch, field or select of the setting; for an action card,
   its first action (Memory import: the "Import" button that opens the import panel, so no React state has to be
   reached from outside; Local model servers: "Add a server"). A read-only card (version, what's new, news) puts the
   mark on its anchor element itself, which means "land on the card".
3. `landingControl(anchor)` does exactly one lookup: `[data-setting-control="<anchor.id>"]` in the anchor's document,
   exactly one matching element, and only if it is enabled and not inside `hidden`. Nothing else. No passes, no sibling scan (`siblingsAfter` is
   deleted), no tag lists, no aria-expanded rule (a mark is trusted, even on a disclosure button). Inside-the-anchor
   cannot be the scope: most anchors are heading ids (`*-heading`) that `aria-labelledby` points at, so their controls
   are never inside them; the anchor-keyed value gives the same guarantee (only this card's control) without moving
   77 ids.
4. Folds: `openFoldsAround` runs on the anchor AND on the marked control (a control can sit in an inner `<details>`).
5. No mark found (lazy page still mounting, e.g. Memory): focus the anchor (tabindex -1), retry the same one lookup
   every 100 ms for 1.5 s, move focus only if focus is still on the anchor. A disabled mark: land on the anchor, never
   on some other control.
6. Ring + `data-setting-landed` for 2 s on the anchor, unchanged.

## Enforcement (r2 of this note, after Astra DISAGREE on source counting)
- Runtime uniqueness: `landingControl` takes the mark only when EXACTLY ONE element carries it and it is usable.
  Two or more (a mark inside a `.map`, a card rendered twice) land on the card itself and warn in dev; DOM order
  never decides. So a missed duplicate degrades to "land on the card", never to "land on the wrong control".
- Static, gate tier, `settings-card-registry.test.ts`: for every card the component sources hold EXACTLY ONE
  `data-setting-control="<anchor>"` (or `settingControl="<anchor>"` where a shared primitive renders the control and
  forwards it explicitly). A mark inside a list is allowed only as `index === 0 ? "<anchor>" : undefined` (Starter
  profiles: the first profile button is the card's designated action; before the list loads there is no mark, so the
  card takes focus and the 1.5 s retry moves it to that button). No allow-list.
- Correct ownership of each mark is a reviewed choice per card (the raw-patch review lists anchor -> element), not
  something a test can infer; the three regressions get named stand-in tests.

## Tests
- settings-landing.test.ts rewritten on the stand-ins: lands on the marked control only; ignores an unmarked switch
  that comes first (the house-rules case); a mark keyed to another anchor is never taken; a disabled or hidden mark
  lands on the anchor; a late mark takes focus within 1.5 s; folds around the control open.
- Rendered DOM test: the repo has no happy-dom or jsdom (vitest runs in node), and the three regression components
  read the app store and api on mount, so a server render needs a store harness this lane does not own. Adding a
  DOM library is a new dependency and lockfile change in a masterclass slice. Listed for 1.0.18 with the axe sweep
  (plan:359), which needs a real DOM anyway; the runtime uniqueness rule makes a missed case land on the card.

## Out of scope
Bot rows in Settings search (needs BotSettingsIntent in src/state/store.tsx, L2A), help search with a query, the
axe sweep.
