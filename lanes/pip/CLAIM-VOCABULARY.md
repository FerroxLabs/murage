---
title: PIP claim vocabulary v1
status: published with PIP P2 core batch B1 (server/memory/pip-vocabulary.ts is the source; a test keeps this file in step)
---

# PIP claim vocabulary v1

The lists the owner-evidence grammar (I-3) and the authored-statement grammar (I-3b) read, and the rules that compare two parsed claims (A.4). Everything here is deterministic: no model, no network. The model proposes only an act and the spans of the owner's own words; the grammar turns the owner's bytes into a claim and a template sentence.

## 1. Contraction table

Applied after lower-casing and folding curly apostrophes, before any matching.

| Written | Folded to |
|---|---|
| `you'd` | `you would` |
| `you'll` | `you will` |
| `you're` | `you are` |
| `you've` | `you have` |
| `we're` | `we are` |
| `we'd` | `we would` |
| `we'll` | `we will` |
| `i'm` | `i am` |
| `i'll` | `i will` |
| `i'd` | `i would` |
| `don't` | `do not` |
| `doesn't` | `does not` |
| `won't` | `will not` |
| `can't` | `cannot` |
| `isn't` | `is not` |
| `aren't` | `are not` |
| `shouldn't` | `should not` |
| `mustn't` | `must not` |
| `wouldn't` | `would not` |
| `haven't` | `have not` |

## 2. Sentence handling

- A message is split on `.`, `!`, `?` and line breaks after pasted third-party segments (quote blocks, forwards, mail headers) are removed.
- A sentence that contains `?` is a question and is refused.
- A sentence is refused as uncertain, on token boundaries, when it contains a quotation pair, a coordinating split (`, but`, `;`, ` or `), or any of these phrases.

| Group | Phrases |
|---|---|
| Reported speech | `you said`, `you wrote`, `you claimed`, `you told me`, `according to` |
| Subordinators | `if`, `unless`, `when`, `whenever`, `because`, `although`, `so that`, `in case`, `whether`, `as long as`, `until`, `while` |
| Hedges | `maybe`, `perhaps`, `sometimes`, `probably`, `possibly`, `i think`, `i guess`, `i suppose`, `kind of`, `sort of`, `a bit`, `seem`, `seems`, `seemed`, `appear`, `appears`, `might`, `could` |

A refused sentence produces nothing. The model may surface it as a plain suggestion with a text box; typed text is stored as an owner-attested row.

## 3. Productions (I-3)

Anchored at the sentence start after an optional vocative or filler (`ok`, `so`, `well`, `hey`, `hi`, `also`, `and`, `then`, `right`) and the bot's name. Priority: RETRACT, INSTR-STOP, INSTR-BE, INSTR-DO, AGREE, OBS-HABIT, OBS-TEND, OBS-STATE. The first production whose pattern matches decides; if it then refuses, the sentence is refused.

| Production | Pattern | Claim | Template statements |
|---|---|---|---|
| OBS-STATE | `you are (not )?PRED` | self-trait, state | `I am PRED`, `I am not PRED` |
| OBS-HABIT | `you (always\|usually\|often\|never) VP` | self-trait, habit, frequency kept, `never` negative | `I always VP`, `I usually VP`, `I often VP`, `I never VP` |
| OBS-TEND | `you (tend to\|tend not to\|tend to not\|keep) VP` | self-trait, habit; the two negative anchors give negative polarity; `you keep not VP` is refused; `keep` takes a gerund phrase | `I tend to VP`, `I tend not to VP`, `I keep VP` |
| INSTR-DO | `(please )?(do\|always\|from now on\|going forward\|next time\|make sure to\|make sure you\|try to\|you should\|you need to\|you must\|I want you to\|I would like you to) (not )?VP` | commitment; modality should (should, need to, want, would like), must (must, make sure), attempt (try to), else none | `I will VP`, `I should VP`, `I must VP`, `I will try to VP`, `I will always VP`, `From now on, I will VP`, `Next time, I will VP`; negative: `I will not VP`, `I should not VP`, `I must not VP`, `I will try not to VP`, `From now on, I will not VP`, `Next time, I will not VP` |
| INSTR-STOP | `(please )?(do not\|never\|stop\|no more) VP` | commitment, negative; `stop` is cessation and takes a gerund phrase | `I will not VP`, `I will never VP`, `I will stop VP`; `No more VP` gives `I will not VP` |
| INSTR-BE | `(please )?(be\|always be) PRED` (`do not be`, `never be` and `stop being` are INSTR-STOP) | commitment about manner | `I will be PRED`, `I will always be PRED` |
| AGREE | `we agreed to (not )?VP`; `we agreed that you (will\|would\|should) (not )?VP` | commitment (`would` gives `will`) | `I will VP`, `I should VP`, `I will not VP`, `I should not VP` |
| RETRACT | `you do not need to VP any ?more`; `you can stop VP`; `we are not doing VP`; `never mind about VP`; `forget about VP`; `you are not PRED any ?more` | a stance event only; the target is the current-generation record whose kind and key match, at any polarity; no match, no event | none |

Anything else matches nothing: bare `let's VP`, bare `agreed`, `we agreed that <clause>` not of the `you will` shape, bare `forget that`, `that's no longer true`, third-party subjects, evaluations.

### Negation

Polarity is negative when the anchor is negative (`do not`, `never`, `stop`, `no more`, `you are not`, a `not` taken by the production) or when the first token of PRED or VP is `not`, `never` or `no longer`, which is stripped from the key. If the anchor is already negative and a token is also stripped, the sentence is refused (no double negation). Any negation token remaining inside PRED or VP after stripping refuses the sentence. A leading `always`, `usually`, `often` or `never` inside PRED of OBS-STATE refuses the sentence (that shape belongs to OBS-HABIT). `without` is not a negation token. A negative with the `always` anchor has no template and is refused.

Negation tokens: `not`, `never`, `no`, `nor`, `neither`, `cannot`, `nothing`, `nobody`, `none`, `nowhere`.

### Verb phrases (N16)

VP is one or more tokens whose first token is on the base-verb list in section 8: `apologize` is admitted, `apologizing` is refused, so "No more apologizing" is surfaced, not produced. After `stop` and `keep` the first token is a gerund of a listed base verb (`stop apologizing`, `keep apologizing`).

## 4. Parsed claim

`{ kind, subject: "bot", predicateKey, property, value, polarity, aspect: state | habit | cessation, frequency: always | usually | often | never | null, modality: none | should | must | attempt, temporalScope: present | prospective | from-now-on | next-time, predicateScope, temporalBucket, act }`.

- `predicateKey`: the PRED or VP bytes after the anchor and any leading negation, lower-cased, whitespace collapsed, punctuation stripped. A leading light verb (`be`, `being`) is dropped, so `be brief`, `being brief` and `brief` share the key `brief`.
- `property` and `value`: set when any token of the key is an accepted lexical form (section 5).
- `predicateScope`: the key with the value token removed, whitespace collapsed; may be empty (`brief with invoices` has scope `with invoices`).
- `temporalBucket`: `present` for observations; `standing` for instructions and agreements without a `next time` anchor (`from now on`, `going forward`, `always`); `next-time`.
- `aspect` of a commitment is `cessation` for `stop`, `state` when the verb phrase starts with `be` or `being`, else `habit`.

## 5. Lexical forms

Within one property, every pair of distinct values is an exclusive pair.

| Property | Value | Accepted forms |
|---|---|---|
| `answer-detail` | `brief` | `brief`, `briefly`, `concise`, `concisely`, `short`, `terse`, `succinct` |
| `answer-detail` | `detailed` | `detailed`, `thorough`, `thoroughly`, `verbose`, `comprehensive`, `lengthy` |
| `formality` | `formal` | `formal`, `formally`, `professional` |
| `formality` | `casual` | `casual`, `casually`, `informal`, `relaxed` |
| `warmth` | `warm` | `warm`, `friendly`, `kind`, `gentle` |
| `warmth` | `cold` | `cold`, `distant`, `curt`, `harsh` |
| `directness` | `direct` | `direct`, `blunt`, `candid`, `frank` |
| `directness` | `indirect` | `indirect`, `vague`, `evasive` |
| `reliability` | `reliable` | `reliable`, `dependable`, `consistent` |
| `reliability` | `unreliable` | `unreliable`, `flaky`, `inconsistent` |
| `punctuality` | `punctual` | `punctual`, `prompt`, `timely` |
| `punctuality` | `late` | `late`, `tardy` |
| `humor` | `playful` | `playful`, `funny`, `humorous` |
| `humor` | `serious` | `serious`, `solemn` |
| `confidence` | `confident` | `confident`, `decisive` |
| `confidence` | `hesitant` | `hesitant`, `tentative` |
| `politeness` | `polite` | `polite`, `courteous`, `respectful` |
| `politeness` | `rude` | `rude`, `impolite`, `disrespectful` |
| `patience` | `patient` | `patient` |
| `patience` | `impatient` | `impatient` |

## 6. Authored statements (I-3b)

`parseAuthoredStatement` accepts the first-person canonical forms only: `I will (not |never |always |try to |try not to )?VP`, `I should (not )?VP`, `I must (not )?VP`, `I am (not )?PRED`, `I will (not )?be PRED`, `I (always|usually|often|never) VP`, `I tend to VP`, `I tend not to VP`, `I keep VP`, `From now on, I will (not )?VP`, `Next time, I will (not )?VP`, `I will stop VP`. It never admits owner evidence and never creates a proposal; it only yields the claim so Reconcile, collapse and compatibility can read the row. Every template statement in section 3 parses under it to a claim equal to the claim that produced it, field by field except `act`.

## 7. Comparison (A.4)

`claimsCompatible(a, b)` (reinforce): the same kind, polarity, aspect, frequency, modality and temporal bucket, and either the same key, or the same property, value and scope. Property and value alone never prove equivalence.

`claimsContradict(a, b)`: the same kind and temporal bucket, and one of: the same key with opposite polarity; the same property and scope with the same value and opposite polarity; the same property and scope with two distinct values both stated positively (the exclusive-pair rule: `I am brief` and `I am not detailed` are not in tension, `be brief` and `be detailed` are); or a RETRACT resolving to the target (the retracted key, with a gerund first token also tried as its base verb).

`claimsRelated(a, b)`: shown together, never counted: the same kind, and they share a key or a property without being compatible or contradictory.

Examples: `be brief with incident reports` against `be brief with invoices` is related; `be brief` against `be brief with invoices` is related; `be brief with invoices` against `be detailed with invoices` is a contradiction; against `be detailed with incident reports` it is related. `you often apologize` against `I always apologize` is related.

Known limit (v1): there is no lemmatizer, so `stop apologizing` and `do not apologize` keep different keys; RETRACT tries the base form of a gerund for that reason.

## 8. Base verbs

`accept`, `acknowledge`, `act`, `add`, `address`, `admit`, `adopt`, `advise`, `agree`, `allow`, `announce`, `answer`, `apologize`, `appear`, `apply`, `approve`, `argue`, `ask`, `assume`, `attach`, `avoid`, `back`, `be`, `begin`, `believe`, `bring`, `build`, `bump`, `call`, `cancel`, `care`, `carry`, `change`, `charge`, `chase`, `check`, `choose`, `clarify`, `clean`, `close`, `comment`, `commit`, `compare`, `complain`, `complete`, `confirm`, `consider`, `contact`, `continue`, `copy`, `correct`, `count`, `create`, `cut`, `decide`, `decline`, `default`, `define`, `delay`, `delete`, `deliver`, `describe`, `design`, `disagree`, `discuss`, `dismiss`, `display`, `do`, `double-check`, `draft`, `drop`, `edit`, `email`, `encourage`, `end`, `enforce`, `ensure`, `escalate`, `estimate`, `examine`, `exaggerate`, `expand`, `explain`, `explore`, `fail`, `fill`, `find`, `finish`, `fix`, `flag`, `focus`, `follow`, `forget`, `forward`, `frame`, `gather`, `get`, `give`, `go`, `greet`, `guess`, `handle`, `hedge`, `help`, `hide`, `highlight`, `hold`, `hurry`, `ignore`, `include`, `indicate`, `inform`, `insist`, `interrupt`, `introduce`, `invent`, `invoice`, `involve`, `join`, `jump`, `justify`, `keep`, `know`, `label`, `lead`, `leave`, `let`, `lie`, `limit`, `link`, `list`, `listen`, `log`, `look`, `lose`, `make`, `mark`, `mention`, `merge`, `mirror`, `miss`, `mix`, `monitor`, `move`, `name`, `narrate`, `need`, `note`, `notice`, `notify`, `offer`, `omit`, `open`, `order`, `organize`, `over-explain`, `overpromise`, `paraphrase`, `pause`, `pick`, `plan`, `point`, `post`, `praise`, `prefer`, `prepare`, `present`, `press`, `pretend`, `prioritize`, `proceed`, `promise`, `propose`, `protect`, `provide`, `push`, `put`, `quote`, `raise`, `rank`, `reach`, `read`, `recap`, `recommend`, `record`, `refer`, `reflect`, `refuse`, `reject`, `remember`, `remind`, `remove`, `repeat`, `reply`, `report`, `request`, `require`, `research`, `reserve`, `respond`, `restate`, `retry`, `review`, `revise`, `rewrite`, `rush`, `save`, `say`, `schedule`, `search`, `see`, `seek`, `select`, `send`, `serve`, `set`, `share`, `shorten`, `show`, `sign`, `simplify`, `skip`, `sleep`, `speak`, `spell`, `split`, `start`, `state`, `stay`, `stop`, `structure`, `submit`, `suggest`, `summarize`, `support`, `surface`, `take`, `talk`, `teach`, `tell`, `test`, `thank`, `think`, `track`, `translate`, `trust`, `try`, `turn`, `type`, `understand`, `update`, `use`, `verify`, `wait`, `warn`, `watch`, `wonder`, `work`, `write`
