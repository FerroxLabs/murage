---
name: maintain-verification-skill
description: "Keep a generated verify-<app> skill honest: re-walk its feature map against the live app, fix drifted drive recipes, add stubs for new features, and surface real product bugs instead of papering over them. Use for /maintain-verification-skill or when a verification skill's instructions stopped matching the app."
---

# Maintain a verification skill

1. **Load** the target skill from `~/.openmausbot/skills/verify-<app>/`
   (ask which app only if several exist). Read `SKILL.md` and every file in
   `features/`.
2. **Doctor first.** Run the skill's own Doctor check. If the app will not
   launch at all, stop and report that as the finding — do not rewrite a
   map against an app you could not run.
3. **Walk the map.** For each feature file (all of them if quick, else the
   most-used plus any the user named): follow `Driving it` exactly as
   written. Three outcomes:
   - **Works** — leave it alone.
   - **Drifted** — the app changed (renamed control, moved route, new
     step): update the recipe and `Gotchas` to match reality.
   - **Broken product** — the feature itself fails when driven correctly:
     report it as a bug with evidence. Never edit the map to hide a
     product bug.
4. **Catch what is new.** Note user-facing features you encountered that
   the map does not cover; add stub files for the significant ones with at
   least `How to get to it (user POV)` filled in.
5. **Version and report.** Bump the skill's manifest patch version, clean
   up whatever you launched, and summarize: features checked, entries
   updated, stubs added, product bugs found — with evidence for anything
   you changed or reported.
