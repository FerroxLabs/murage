// THE BRIEF, AS A PAGE.
//
// One pure function: brief data in, a complete HTML document out. No network,
// no model call, no imports beyond the shape. That is not a style preference,
// it is the security property the whole sample-brief idea rests on: a page
// nobody has to spend anything to produce is a page with no abuse surface,
// which is what lets the first run show somebody what this product does
// before asking them for anything at all.
//
// WHAT "SPECTACULAR" MEANS HERE, because the brief is asked to be genuinely
// impressive and is also read by somebody in their seventies who is bad with
// computers, and those pull against each other.
//
// It means typographic confidence, not decoration. No animation, no gradients
// for their own sake, no cleverness. It should read like something a good
// private secretary left on a desk: generous margins, a real hierarchy, one
// accent used sparingly, and the most important thing unmistakably first.
// Everything that makes it feel considered is restraint rather than addition.
//
// It is a standalone document on purpose. Everything is inline: no
// stylesheet, no font file, no script, no image request. It therefore renders
// identically with no network at all, prints properly, survives being emailed
// to somebody, and cannot phone home. On a machine that has not yet connected
// anything, the brief still looks exactly as intended.

import { BRIEF_SECTIONS, type BriefData, type BriefEntry, briefIsQuiet } from "./brief.ts";

/**
 * Everything that goes into the page goes through here first.
 *
 * The brief is assembled from the owner's own mail, calendar and documents,
 * which is to say from text other people wrote. A subject line containing
 * `<script>` is not exotic, it is Tuesday, and this document is opened in a
 * real browser. Escaping at the single seam where text becomes markup is the
 * only version of this that can be checked by reading one function.
 */
function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A section's rows, or "" when it has none. An empty section is omitted
 *  entirely rather than rendered as a bare heading, because a heading with
 *  nothing under it is the assistant filling a quota. */
function section(heading: string, entries: readonly BriefEntry[]): string {
  if (entries.length === 0) return "";

  // THE TIME COLUMN IS PER SECTION, NOT PER ROW.
  //
  // "Today" has times on everything and lines them up, which is most of why
  // it reads as a day rather than a list. "Overnight" and "Handled for you"
  // have times on nothing, because nobody needs the minute an email arrived.
  // Reserving the column anyway left every row in those sections indented
  // past a gutter with nothing in it, which reads as a bug rather than as
  // alignment. So a section with no times does not have the column at all.
  //
  // Decided by looking at the rendered page, not by reading the markup.
  const timed = entries.some((entry) => Boolean(entry.when?.trim()));
  const rows = entries.map((entry) => {
    const when = timed ? `<div class="when">${escape(entry.when?.trim() ?? "")}</div>` : "";
    const detail = entry.detail?.trim() ? `<p class="detail">${escape(entry.detail.trim())}</p>` : "";
    return `<li>${when}<div class="body"><p class="title">${escape(entry.title)}</p>${detail}</div></li>`;
  });
  return `<section><h2>${escape(heading)}</h2><ul class="rows">${rows.join("")}</ul></section>`;
}

/**
 * The decisions section, which is shaped differently because it is doing a
 * different job.
 *
 * Every other section informs. This one asks, so each item carries the
 * recommendation on its own line, set apart, because "what would you do" is
 * the question the owner is actually holding while they read it. A list of
 * options with no recommendation is a failure to do the job, and the layout
 * is built so that failure would be visible as a gap.
 */
function decisions(data: BriefData): string {
  const items = data.needsYou ?? [];
  if (items.length === 0) return "";
  const rows = items.map((item) => {
    // A real time, never a word like "urgent". A deadline is a fact; urgency
    // is a feeling, and manufacturing it is what spam does.
    const by = item.by?.trim() ? `<span class="by">${escape(item.by.trim())}</span>` : "";
    const recommend = item.recommend?.trim()
      ? `<p class="recommend"><span class="mark">My suggestion</span>${escape(item.recommend.trim())}</p>`
      : "";
    return `<li class="decision"><div class="head"><p class="title">${escape(item.title)}</p>${by}</div>`
      + `<p class="detail">${escape(item.detail)}</p>${recommend}</li>`;
  });
  return `<section class="needs"><h2>Needs you</h2><ul class="rows">${rows.join("")}</ul></section>`;
}

/**
 * The page.
 *
 * Self-contained by design, and the CSS is deliberately plain: system fonts
 * so it renders instantly and looks native on every machine, a light and dark
 * scheme that follows the person's own setting, and one accent colour used
 * for exactly two things, the rule under the name and the decision marker.
 */
export function renderBriefHtml(data: BriefData): string {
  const name = data.ownerName.trim();
  const body = briefIsQuiet(data)
    ? `<section class="quiet"><p>${escape(data.quiet?.trim() || "Nothing needs you this morning.")}</p></section>`
    : BRIEF_SECTIONS.map((entry) =>
        entry.key === "needsYou" ? decisions(data) : section(entry.heading, data[entry.key] ?? []),
      ).join("");

  // The greeting names them, and that is most of why this feels made for
  // them rather than screenshotted from somewhere else.
  const greeting = name ? `Good morning, ${escape(name)}` : "Good morning";
  const title = name ? `${escape(name)}, your morning brief` : "Your morning brief";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root {
  color-scheme: light dark;
  --paper: #fbfaf8;
  --ink: #1a1a18;
  --soft: #6b6862;
  --rule: #e3dfd8;
  --accent: #8a6d3b;
  --card: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #14140f;
    --ink: #f0ece4;
    --soft: #9c978c;
    --rule: #2e2d27;
    --accent: #c9a96a;
    --card: #1c1b16;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0 16px 96px;
  background: var(--paper);
  color: var(--ink);
  font: 16px/1.62 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 40rem; margin: 0 auto; }
header { padding: 72px 0 26px; border-bottom: 2px solid var(--accent); margin-bottom: 8px; }
h1 {
  margin: 0;
  font-family: ui-serif, Georgia, "Times New Roman", serif;
  font-size: clamp(30px, 7vw, 44px);
  font-weight: 500;
  letter-spacing: -0.015em;
  line-height: 1.12;
}
.date { margin: 12px 0 0; color: var(--soft); font-size: 14px; letter-spacing: 0.055em; text-transform: uppercase; }
section { padding: 30px 0 4px; }
section + section { border-top: 1px solid var(--rule); }
h2 {
  margin: 0 0 18px;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  color: var(--soft);
}
.rows { list-style: none; margin: 0; padding: 0; }
.rows > li { display: flex; gap: 18px; padding: 0 0 20px; }
.when {
  flex: 0 0 5.4rem;
  color: var(--soft);
  font-variant-numeric: tabular-nums;
  font-size: 14.5px;
  padding-top: 1px;
}
.body { flex: 1 1 auto; min-width: 0; }
.title { margin: 0; font-weight: 550; }
.detail { margin: 3px 0 0; color: var(--soft); }
.needs .rows > li {
  display: block;
  background: var(--card);
  border: 1px solid var(--rule);
  border-left: 3px solid var(--accent);
  border-radius: 9px;
  padding: 16px 18px;
  margin-bottom: 12px;
}
.needs .head { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; }
.needs .title { font-size: 17.5px; }
.by { flex: 0 0 auto; color: var(--accent); font-size: 13px; font-weight: 600; white-space: nowrap; }
.recommend {
  margin: 12px 0 0;
  padding-top: 12px;
  border-top: 1px dashed var(--rule);
  font-size: 15px;
}
.mark {
  display: block;
  color: var(--soft);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-bottom: 3px;
}
.quiet { font-size: 19px; }
.quiet p { margin: 0; }
@media (max-width: 34rem) {
  header { padding-top: 48px; }
  .rows > li { display: block; }
  .when { margin-bottom: 2px; font-size: 13.5px; }
}
@media print {
  body { background: #fff; color: #000; padding: 0; }
  .needs .rows > li { background: none; }
}
</style>
</head>
<body>
<main>
<header>
<h1>${escape(greeting)}</h1>
<p class="date">${escape(data.dateLabel)}</p>
</header>
${body}
</main>
</body>
</html>`;
}
