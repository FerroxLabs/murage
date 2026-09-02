# openmausbot-teams

Six team packages vendored into `library/packages/` so the library works with the
network unplugged:

| slug | file |
|---|---|
| `100x-marketing` | `library/packages/100x-marketing.md` |
| `competitor-watch` | `library/packages/competitor-watch.md` |
| `engineering` | `library/packages/engineering.md` |
| `inbox-follow-up` | `library/packages/inbox-follow-up.md` |
| `reddit-lead-miner` | `library/packages/reddit-lead-miner.md` |
| `seo-growth` | `library/packages/seo-growth.md` |

Upstream: <https://github.com/milind-soni/openmausbot-teams>, MIT licensed — the
full text is in `LICENSE` beside this file. Authorship inside each package is
left alone (`author: OpenMausBot`); the only transform applied upstream of here
is the pair of fork renames `scripts/merge-upstream-teams.mjs` documents.

They cover outbound and search ground the Wayland set does not, and they are the
only six library entries with no other source in this repository.

## One thing to know about them

Their catalog entries upstream advertise fifteen `teams/<slug>/skills/<id>/SKILL.md`
paths — `positioning-brief`, `architecture-decision`, `release-readiness` and the
rest. Those ids are **playbooks**, defined inline in the package document with
their full instructions, not skills. The importer installs skills from
`agents[].skills` (`server/index.ts:6648`), and these packages declare none, so
the fifteen SKILL.md files were never installed by any import, online or off.
`scripts/build-local-catalog.mjs` therefore gives these six `skills: []` and
carries the playbooks through the package, which is what actually happens.
