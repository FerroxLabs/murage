# T02 notes (floor classifier and lexicon)

Decisions and open points for the lead.

- Result shape is `{ floor, reason, rule, unsure? }`. `floor` is one of the four spec kinds or null. A classifier error, missing facts or unreadable target returns a floor with `unsure: true`; with no better guess the kind is "verification" (generic "needs the owner"). T03 should show the generic "Your turn" text when `unsure` is true.
- `FloorFacts` (server/browser-floor.ts) is my reading of spec 2.5.5. T01 must produce it or the two reconcile. It has no field value anywhere; `buttonValue` is only the value attribute of a button.
- Declining and closing a consent banner is not floor (D2). Opening "Manage preferences", "Cookie settings" or a privacy-policy link inside a banner is also not floor (my addition; it binds nothing). "Save preferences" is floor unless the collector sets `consentOptionalOn: false`.
- A bare "Verify" or "Verify email" is floor everywhere. A bare Accept, Agree, Allow, Confirm or Continue is floor only with consent, challenge or payment context anywhere on the page (spec 2.5.3 table). Subscribe, Start trial and Submit are floor only with payment context.
- Policy and terms links are never floor (reading is allowed), even beside a click-to-agree sentence.
- Order of rules: dialog text, challenge page, target in CAPTCHA, unreadable frame, field entry, upload, verification names, payment, consent, credentials submit, weak words, unsure. A sign-up Create account button with a password field and an agree sentence reports consent; a plain sign-in submit reports credentials.
- Foundry's DESTRUCTIVE_PATTERNS is ported verbatim in the lexicon for T12 (delete, remove, cancel subscription, close account are level 3, not floor). Only the four pay entries are reused for floor, with a word boundary in front.
- Side quest not touched: scripts/hz-test.sh uses plain ssh without ControlMaster=no; I used a private wrapper in the scratchpad.
