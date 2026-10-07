# skills-library

The skill catalog Murage installs from when someone hires a bot or a team. One
directory per skill, each with a `SKILL.md` and a generated `manifest.json`.
The packaged app ships this directory verbatim (`electron-builder.yml`,
`extraResources`).

## Origin and copyright

Copyright 2026 Ferrox Labs, LLC holds the copyright for the whole library,
the imported pack and the Wayland role skills alike (owner's ruling,
2026-10-01). Every Apache-2.0 skill credits `author: Ferrox Labs` (owner's
ruling, 2026-10-02).
The Apache-2.0 text is in [LICENSE](LICENSE).

- **2,106 skills** came from the Wayland skill pack, imported by
  `scripts/import-wayland-skills.mjs` (see `.wayland-import.json` for the
  counts and the nine name collisions). Frontmatter: `author: Ferrox Labs`,
  `license: Apache-2.0`.
- **110 skills** are Wayland's role skills and business suite skills, also
  `author: Ferrox Labs`, imported by `scripts/import-wayland-role-skills.mjs` and
  `scripts/import-wayland-business-skills.mjs`, or written by hand here. They
  are Apache-2.0 (the importer writes the line). That includes the 10 business
  suite skills that used to say `license: MIT` and `author: wayland`.
- **11 skills** are the published tvcontrol skills, Apache-2.0 licensed, imported by
  `scripts/import-tvcontrol-skills.mjs`.

2026-10-02 owner ruling: the 21 skills that said `license: MIT` (10 business suite,
11 tvcontrol) are Ferrox Labs' own work and are relicensed Apache-2.0, with no
upstream attribution line.

[LICENSE-AUDIT.md](LICENSE-AUDIT.md) records what those 21 said before the ruling.

The rest of Murage is under the GNU AGPL-3.0-or-later (see the root `LICENSE`).
Each skill file's own `license` line is the license for that file.
