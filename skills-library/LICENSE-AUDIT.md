# Skills library license audit

Generated from the frontmatter of every `skills-library/<id>/SKILL.md`. The
library holds 2,242 skill directories. Frontmatter says:

| `license` line | Skills |
|---|---|
| `Apache-2.0` | 2,242 (2,128 as imported, 88 after the role-skills ruling, 21 after the ruling below, 5 new procedures) |
| `MIT` | 0 |
| none | 0 |

Added 5 Ferrox Labs skills on 2026-10-03 for the ready-made bot library: 3 from the original plan and 2 from its expansion.

| Skill | `license` line | `author` | Source |
|---|---|---|---|
| `month-end-close-checklist` | Apache-2.0 | Ferrox Labs | Original, written for Murage by Ferrox Labs |
| `document-to-table-checklist` | Apache-2.0 | Ferrox Labs | Original, written for Murage by Ferrox Labs |
| `trades-quote-checklist` | Apache-2.0 | Ferrox Labs | Original, written for Murage by Ferrox Labs |
| `payables-match-checklist` | Apache-2.0 | Ferrox Labs | Original, written for Murage by Ferrox Labs |
| `shift-coverage-checklist` | Apache-2.0 | Ferrox Labs | Original, written for Murage by Ferrox Labs |

Every skill is covered by [LICENSE](LICENSE). Copyright in the library as a
whole is held by Ferrox Labs, LLC (owner's ruling), and every skill says
`author: Ferrox Labs`.

2026-10-02 owner ruling: these 21 are Ferrox Labs' own work; relicensed Apache-2.0.

## The 21 skills that said `license: MIT`

The 11 with no `author` line were the published tvcontrol skills (brought in by
`scripts/import-tvcontrol-skills.mjs`); the 10 with `author: wayland` were Wayland
Business Suite skills (brought in by `scripts/import-wayland-business-skills.mjs`).
All 21 now say `license: Apache-2.0` and `author: Ferrox Labs`, and the upstream
`attribution` lines that credited another author were removed. Both importers
write the new form. The table shows what each file said before the ruling.

| Skill | `license` line (before) | `author` (before) | `attribution` (before) |
|---|---|---|---|
| `chart-analysis` | MIT | (none) | (none) |
| `commerce-ugc-prompts` | MIT | wayland | Wayland Business Suite (Original) |
| `content-about-page` | MIT | wayland | The Donahoe Method (Wayland-owned operating system); StoryBrand 'guide not hero' frame (Donald Miller, 2017... |
| `content-haro-reply` | MIT | wayland | Peter Shankman (HARO founder) on journalist time pressure and source quality; Cameron Herold 'Double Double... |
| `learn-from-losses` | MIT | (none) | (none) |
| `market` | MIT | wayland | Wayland Business Suite (Original), port of zubair-trabzada/ai-marketing-claude |
| `market-audit` | MIT | wayland | zubair-trabzada/ai-marketing-claude (skills/market-audit + scripts/analyze_page.py) |
| `market-landing` | MIT | wayland | zubair-trabzada/ai-marketing-claude (skills/market-landing) |
| `morning-prep` | MIT | (none) | (none) |
| `multi-pane-analysis` | MIT | (none) | (none) |
| `multi-symbol-scan` | MIT | (none) | (none) |
| `pine-develop` | MIT | (none) | (none) |
| `porting-pine-versions` | MIT | (none) | (none) |
| `rebuild-from-screenshot` | MIT | (none) | (none) |
| `replay-practice` | MIT | (none) | (none) |
| `sales-contacts` | MIT | wayland | Wayland Business Suite (Original) |
| `sales-icp` | MIT | wayland | Wayland Business Suite (Original) |
| `sales-prospect` | MIT | wayland | zubair-trabzada/ai-sales-team-claude (skills/sales-prospect) |
| `sales-qualify` | MIT | wayland | Wayland Business Suite (Original) |
| `strategy-ab-test` | MIT | (none) | (none) |
| `strategy-report` | MIT | (none) | (none) |

## The 88 Wayland role skills, formerly without a `license` line

All 88 now carry `author: Ferrox Labs` (formerly `wayland`; owner's ruling, 2026-10-02). They are Wayland's own role skills, brought in
by `scripts/import-wayland-role-skills.mjs`, which never wrote a `license` line.
The owner has ruled that Ferrox Labs, LLC holds the copyright for the whole
library and that these 88 are Apache-2.0. Each now carries
`license: Apache-2.0`, and the importer writes it on future imports. The table
below is the audit record of what each file said before that change. Two of
them mention the word "license" in their body text only as subject matter
(`sentry-contracts-and-terms`, `sentry-ip-and-compliance`).

| Skill | `license` line | `author` | `attribution` |
|---|---|---|---|
| `beacon-affiliate-program` | (no license line) | wayland | (none) |
| `beacon-blog-content` | (no license line) | wayland | (none) |
| `beacon-channel-strategy` | (no license line) | wayland | (none) |
| `beacon-email-sequences` | (no license line) | wayland | (none) |
| `beacon-facebook` | (no license line) | wayland | (none) |
| `beacon-funnel-build` | (no license line) | wayland | (none) |
| `beacon-instagram` | (no license line) | wayland | (none) |
| `beacon-linkedin` | (no license line) | wayland | (none) |
| `beacon-newsletter` | (no license line) | wayland | (none) |
| `beacon-paid-acquisition` | (no license line) | wayland | (none) |
| `beacon-podcast` | (no license line) | wayland | (none) |
| `beacon-seo-organic` | (no license line) | wayland | (none) |
| `beacon-short-form-video` | (no license line) | wayland | (none) |
| `beacon-twitter-x` | (no license line) | wayland | (none) |
| `coin-hire-affordability` | (no license line) | wayland | (none) |
| `coin-pricing-math` | (no license line) | wayland | (none) |
| `coin-runway-and-burn` | (no license line) | wayland | (none) |
| `coin-unit-economics` | (no license line) | wayland | (none) |
| `copy-awareness-stages` | (no license line) | wayland | (none) |
| `copy-customer-voice` | (no license line) | wayland | (none) |
| `copy-hook-craft` | (no license line) | wayland | (none) |
| `copy-lens-business-angle` | (no license line) | wayland | (none) |
| `copy-lens-clarity` | (no license line) | wayland | (none) |
| `copy-lens-curiosity-packaging` | (no license line) | wayland | (none) |
| `copy-lens-differentiation` | (no license line) | wayland | (none) |
| `copy-lens-platform-native` | (no license line) | wayland | (none) |
| `copy-lens-positioning` | (no license line) | wayland | (none) |
| `copy-lens-storytelling` | (no license line) | wayland | (none) |
| `copy-lens-value-framing` | (no license line) | wayland | (none) |
| `cross-role-consume-voice-profile` | (no license line) | wayland | (none) |
| `forge-offer-construction` | (no license line) | wayland | (none) |
| `forge-packaging-tiers` | (no license line) | wayland | (none) |
| `forge-value-pricing` | (no license line) | wayland | (none) |
| `helm-decision-frames` | (no license line) | wayland | (none) |
| `helm-founder-cadence` | (no license line) | wayland | (none) |
| `helm-stuck-and-unstuck` | (no license line) | wayland | (none) |
| `humanizer-rewrite-pass` | (no license line) | wayland | (none) |
| `humanizer-tell-detector` | (no license line) | wayland | (none) |
| `humanizer-voice-match` | (no license line) | wayland | (none) |
| `lens-cohort-and-retention` | (no license line) | wayland | (none) |
| `lens-funnel-diagnosis` | (no license line) | wayland | (none) |
| `lens-marketing-attribution` | (no license line) | wayland | (none) |
| `lens-north-star-and-experiments` | (no license line) | wayland | (none) |
| `mend-churn-prevention` | (no license line) | wayland | (none) |
| `mend-onboarding-flow` | (no license line) | wayland | (none) |
| `mend-ticket-triage` | (no license line) | wayland | (none) |
| `mira-brand-foundation` | (no license line) | wayland | (none) |
| `mira-presentation-design` | (no license line) | wayland | (none) |
| `mira-visual-system` | (no license line) | wayland | (none) |
| `patch-crm-hygiene` | (no license line) | wayland | (none) |
| `patch-operating-rhythm` | (no license line) | wayland | (none) |
| `patch-process-design` | (no license line) | wayland | (none) |
| `probe-fake-door-tests` | (no license line) | wayland | (none) |
| `probe-mvp-design` | (no license line) | wayland | (none) |
| `probe-validation-rubric` | (no license line) | wayland | (none) |
| `research-audience-discovery` | (no license line) | wayland | (none) |
| `research-competitive-scan` | (no license line) | wayland | (none) |
| `research-jtbd-interviews` | (no license line) | wayland | (none) |
| `research-market-research` | (no license line) | wayland | (none) |
| `sales-close-and-next-step` | (no license line) | wayland | (none) |
| `sales-discovery-call` | (no license line) | wayland | (none) |
| `sales-objection-handling` | (no license line) | wayland | (none) |
| `sales-partnerships` | (no license line) | wayland | (none) |
| `sentry-contracts-and-terms` | (no license line) | wayland | (none) |
| `sentry-employment-and-classification` | (no license line) | wayland | (none) |
| `sentry-formation-and-structure` | (no license line) | wayland | (none) |
| `sentry-ip-and-compliance` | (no license line) | wayland | (none) |
| `slate-candidate-evaluation` | (no license line) | wayland | (none) |
| `slate-hiring-structure` | (no license line) | wayland | (none) |
| `slate-role-design` | (no license line) | wayland | (none) |
| `smith-agent-handoff` | (no license line) | wayland | (none) |
| `smith-architecture-decisions` | (no license line) | wayland | (none) |
| `smith-shape-and-spec` | (no license line) | wayland | (none) |
| `spark-curriculum-architecture` | (no license line) | wayland | (none) |
| `spark-learner-engagement` | (no license line) | wayland | (none) |
| `spark-long-form-narrative` | (no license line) | wayland | (none) |
| `stage-demo-day-and-q-a` | (no license line) | wayland | (none) |
| `stage-narrative-shift` | (no license line) | wayland | (none) |
| `stage-pitch-deck` | (no license line) | wayland | (none) |
| `vault-agentic-geo` | (no license line) | wayland | (none) |
| `vault-marketplace-ops` | (no license line) | wayland | (none) |
| `vault-storefront-foundation` | (no license line) | wayland | (none) |
| `verdict-flag-and-fix` | (no license line) | wayland | (none) |
| `verdict-score-and-rank` | (no license line) | wayland | (none) |
| `verdict-the-one-edit` | (no license line) | wayland | (none) |
| `voiceprint-voice-compile` | (no license line) | wayland | (none) |
| `voiceprint-voice-interview` | (no license line) | wayland | (none) |
| `voiceprint-voice-maintenance` | (no license line) | wayland | (none) |
