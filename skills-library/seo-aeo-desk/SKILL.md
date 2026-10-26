---
name: seo-aeo-desk
description: |
  Runs the search desk loop an agency sells: a keyword and question map, a content brief per target, and a page audit for classic search (SEO) and AI answer engines (AEO). Produces a keyword map, ready-to-write briefs and a prioritised fix list tied to evidence.
  Use when the user asks for keyword research, a content brief, an SEO or AEO audit, why a page does not rank or is not cited by AI answers, or a search plan for a site or client.
  Do NOT use for writing the finished article (use seo-blog-post), paid search ads, or local listings and reviews (use local search skills).
license: Apache-2.0
metadata:
  author: Ferrox Labs
  version: "1.0.0"
  category: "marketing"
---

# SEO and AEO desk

One loop, three outputs: **keyword map, brief, audit**. Each step feeds the next, so run them in order unless the owner asks for one part only.

## Inputs to ask for

Ask only for what is missing:

1. The site or page URLs, and who the business serves (audience, location, offer).
2. Seed topics or the product and service names the owner wants to be found for.
3. Optional evidence: Search Console exports (queries, pages, clicks, impressions, position), analytics, a competitor list, a past audit.

Search Console is optional. When it is connected and its tools read queries and pages, use it. When it is not, work from supplied exports, the live pages, and public search results the owner can verify, and say which conclusions would sharpen with it.

## Step 1: keyword and question map

- Group terms by **intent**: learn, compare, buy, fix, local. One page serves one primary intent.
- For each group record: primary term, close variants, the questions people ask (the AEO layer), the page that should own it, and the evidence behind it (Search Console row, visible result, or "estimate").
- Mark **cannibalisation**: two pages competing for one group.
- Never invent search volumes. If no data source gives a number, write "volume not measured" and rank by business value and intent instead.

Output table: `group | intent | primary term | questions | owning page | evidence | priority`.

## Step 2: content brief per target

For each priority group, write a brief a writer can start from today:

- Working title and the one question the page must answer in its first two sentences (answer engines quote openings).
- Search intent and the reader's next step.
- Outline: H2s that map to the questions from step 1, each with the fact or example it needs.
- Entities and terms to cover, internal links to and from, and the proof the page needs (data, quotes, screenshots).
- AEO block: a short, direct answer paragraph, an FAQ section with plain question headings, and structured data to add (FAQPage, HowTo, Product, Organization, as fits).
- What not to do: thin rewrites of competitors, keyword stuffing, claims the business cannot support.

## Step 3: page audit

Audit the owning page (or the whole site sample) against the brief. Check and report each with evidence:

- **Indexing**: status code, canonical, robots and noindex, sitemap presence, duplicate titles.
- **On page**: title and meta description match intent, one H1, headings follow the questions, answer appears early, images have alt text.
- **AEO readiness**: a quotable answer near the top, clear entity names, author and date, structured data validates, sources cited on the page.
- **Experience**: mobile layout, slow or shifting content, intrusive pop-ups.
- **Links**: internal links into the page from related pages, broken links out.

Rank fixes by impact and effort: `fix | page | evidence | impact | effort | owner`.

## Rules

- Separate what you observed, what you calculated and what you estimate. Mark a gap with `[TK: fact needed]`.
- Do not promise rankings, traffic or AI citations. Say what the fix makes more likely and how to measure it (Search Console position, clicks, cited answers checked by hand).
- Publishing, editing a live site, submitting sitemaps or changing Search Console settings is the owner's call. Prepare the change and ask first.

## Output

Return, in this order: the keyword map, the briefs, the audit fix list, then a short "measure next" list naming the queries and pages to recheck in four weeks.
