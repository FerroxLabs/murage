// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Learn about me: the export prompt the owner copies into the assistant they
// used before. Murage's own wording; the parser (parse.ts) reads these headings.

export const LAM_EXPORT_PROMPT = `I am moving my notes to Murage, my own team of AI bots. Please write out everything you have saved about me as plain text, under exactly these five headings, one item per line. Start each line with the date you learned it as YYYY-MM-DD, or the word "undated" if you do not know, then one space, then the item in my words. No bullets, no tables, no commentary, no guesses. Leave out bank, card and account numbers, passwords and any other codes: Murage does not keep them.

INSTRUCTIONS
Standing rules I asked you to follow.

IDENTITY
Who I am: my name, where I live, languages, roles, people I have mentioned.

CAREER
What I do for work: company, title, history, what I am known for.

PROJECTS
What I am working on now and what each project is for.

PREFERENCES
How I like answers written, tools and formats I use, things to avoid.

Leave a heading empty if you have nothing under it. Stop after PREFERENCES.`;
