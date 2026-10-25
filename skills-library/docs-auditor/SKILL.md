---
name: docs-auditor
description: |
  Audits product documentation against what actually shipped: compares the docs with the changelog, release notes and merged changes, and returns a list of stale, missing and wrong pages with the exact passage, the evidence and a drafted correction.
  Use when the user asks whether the docs are up to date, to check docs against a release or changelog, to find pages a new feature or rename made wrong, or to prepare docs updates before a launch.
  Do NOT use for writing a brand new help center from scratch (use help center writing skills) or for writing the changelog itself (use changelog-writer).
license: Apache-2.0
metadata:
  author: Ferrox Labs
  version: "1.0.0"
  category: "documentation"
---

# Docs auditor

Docs drift one release at a time. This audit finds each place where the docs now say something the product no longer does, and drafts the fix.

## Inputs

1. The docs: a folder, a site URL, or exported pages.
2. What changed: the changelog or release notes for the window, plus merged pull requests or commit messages if available.
3. The window: "since version X" or "since date Y".

## Method

1. **List the changes.** From the changelog and merges, write one row per user-visible change: new feature, renamed thing, removed thing, changed default, changed limit, new requirement, changed screen or menu path. Record the source line for each.
2. **Extract the terms.** For each change, note the old and new names, setting keys, menu paths, commands, flags, numbers and screenshots it touches.
3. **Search the docs** for every old term and every area the change touches. Read each hit in context.
4. **Classify each finding:**
   - **Wrong**: the page states something the change made false (old default, removed option, old menu path).
   - **Stale**: still true but missing the new option or limit, or showing an old screenshot.
   - **Missing**: a shipped change with no page or section at all.
   - **Unverified**: a change whose effect on the docs you cannot confirm from the material given.
5. **Draft the fix** for each finding: the exact replacement text, in the page's own voice and format.

## Finding format

`page | section | current text (quoted) | change and its source | class | drafted correction | confidence`

## Rules

- Quote the docs exactly. Cite the changelog or merge line that proves the change. No evidence, no "Wrong": use "Unverified".
- Do not rewrite pages that are still correct. Smaller diffs get reviewed and shipped faster.
- Editing or publishing the docs is the owner's call. Present the corrections as drafts and ask before changing any live page or repository.

## Output

Return the findings grouped by page, Wrong first, then Missing, Stale and Unverified; then a coverage line: how many changes were checked, how many pages were read, and anything that could not be searched.
