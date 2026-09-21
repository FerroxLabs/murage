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
// It means the page looks AUTHORED. Somebody sat down and made this for you:
// a masthead, decisions that look like decisions, a timeline that looks like
// time, and a signature at the bottom. What it does not mean is
// decoration. No animation, no gradients for their own sake, no cleverness.
// It should read like something a good private secretary left on a desk.
//
// It is a standalone document on purpose. Everything is inline: no
// stylesheet, no font file, no script, no image request. It therefore renders
// identically with no network at all, prints properly, survives being emailed
// to somebody, and cannot phone home. On a machine that has not yet connected
// anything, the brief still looks exactly as intended.
//
// TYPE IS SYSTEM TYPE, and that is a constraint rather than a shortcut. A web
// font would be a network request, and embedding one would be hundreds of
// kilobytes in every copy. Everything below is done with weight, size,
// spacing, colour and rules instead, which is how print did it for four
// hundred years.

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
  return `<section><h2><span>${escape(heading)}</span></h2><ul class="rows${timed ? " timed" : ""}">${rows.join("")}</ul></section>`;
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
      ? `<div class="recommend"><span class="mark">My suggestion</span><p>${escape(item.recommend.trim())}</p></div>`
      : "";
    return `<li class="decision"><div class="head"><p class="title">${escape(item.title)}</p>${by}</div>`
      + `<p class="detail">${escape(item.detail)}</p>${recommend}</li>`;
  });
  return `<section class="needs"><h2><span>Needs you</span></h2><ul class="rows">${rows.join("")}</ul></section>`;
}

/**
 * The page.
 *
 * Self-contained by design. The CSS is long because everything that would
 * normally be a font file or an image is done here with type and rules
 * instead.
 *
 * THE VIEWPORT META IS LOAD-BEARING, and it is why this page is handed to a
 * frame verbatim rather than through the artifact scrubber. That scrubber
 * strips every <meta>, which is right for hostile HTML and wrong for ours.
 *
 * Without it a frame on a scaled display lays the document out at
 * a width that is not the frame's width, and the page renders centred on a
 * viewport wider than the box it is in, so its right-hand side is clipped and
 * a dead gutter appears on the left. Seen on a Windows machine at 2x scaling;
 * it cannot be reproduced at 1x, which is why the first attempt to fix it
 * missed. Anything that strips this tag breaks the page on exactly the
 * machines most people own.
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>
:root {
  color-scheme: light dark;
  --paper: #faf7f2;
  --sheet: #ffffff;
  --ink: #17161a;
  --soft: #6a665e;
  --faint: #938f86;
  --rule: #e6e0d6;
  --accent: #9a6f36;
  --accent-soft: #f6efe3;
  --shadow: 0 1px 2px rgba(23,22,26,.04), 0 8px 24px -12px rgba(23,22,26,.14);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #100f0d;
    --sheet: #191814;
    --ink: #f2eee6;
    --soft: #a09a8e;
    --faint: #7d786e;
    --rule: #2b2925;
    --accent: #d2ab6a;
    --accent-soft: #241e14;
    --shadow: 0 1px 2px rgba(0,0,0,.5), 0 10px 30px -14px rgba(0,0,0,.7);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 0 20px 80px;
  background: var(--paper);
  color: var(--ink);
  font: 15.5px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  font-feature-settings: "kern" 1, "liga" 1;
}
main { max-width: 42rem; margin: 0 auto; }

/* ── masthead ─────────────────────────────────────────────── */
header { padding: 46px 0 0; }
.eyebrow {
  margin: 0 0 14px;
  color: var(--accent);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: .22em;
  text-transform: uppercase;
}
h1 {
  margin: 0;
  font-family: ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif;
  font-size: clamp(30px, 6.4vw, 42px);
  font-weight: 500;
  letter-spacing: -.02em;
  line-height: 1.08;
}
.date {
  margin: 10px 0 0;
  color: var(--faint);
  font-size: 12.5px;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.masthead-rule {
  margin: 22px 0 0;
  height: 2px;
  background: linear-gradient(90deg, var(--accent) 0%, var(--accent) 22%, var(--rule) 22%, var(--rule) 100%);
}

/* ── sections ─────────────────────────────────────────────── */
section { padding: 28px 0 0; }
h2 {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 0 16px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .18em;
  text-transform: uppercase;
  color: var(--faint);
}
h2::after {
  content: "";
  flex: 1 1 auto;
  height: 1px;
  background: var(--rule);
}
.rows { list-style: none; margin: 0; padding: 0; }
.rows > li { padding: 0 0 18px; }

/* Today reads as time passing: a rule down the page with a mark per entry. */
.rows.timed > li {
  display: grid;
  grid-template-columns: 4.6rem 1fr;
  gap: 16px;
  position: relative;
}
.rows.timed > li::before {
  content: "";
  position: absolute;
  left: 4.6rem;
  top: 10px;
  bottom: -8px;
  width: 1px;
  background: var(--rule);
  transform: translateX(-8px);
}
.rows.timed > li:last-child::before { display: none; }
.rows.timed > li::after {
  content: "";
  position: absolute;
  left: 4.6rem;
  top: 7px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  transform: translateX(-11px);
}
.when {
  color: var(--soft);
  font-variant-numeric: tabular-nums;
  font-size: 14px;
  font-weight: 550;
  padding-top: 1px;
}
.body { min-width: 0; }
.title { margin: 0; font-weight: 600; }
.detail { margin: 3px 0 0; color: var(--soft); }

/* ── the decisions ────────────────────────────────────────── */
.needs .rows > li {
  background: var(--sheet);
  border: 1px solid var(--rule);
  border-left: 3px solid var(--accent);
  border-radius: 12px;
  padding: 16px 18px;
  margin-bottom: 12px;
  box-shadow: var(--shadow);
}
.needs .head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}
.needs .title {
  font-family: ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: -.01em;
}
.by {
  flex: 0 0 auto;
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .09em;
  text-transform: uppercase;
  white-space: nowrap;
  background: var(--accent-soft);
  border-radius: 999px;
  padding: 3px 10px;
}
.recommend {
  margin: 14px 0 0;
  background: var(--accent-soft);
  border-radius: 9px;
  padding: 11px 13px;
}
.recommend p { margin: 0; font-size: 15px; }
.mark {
  display: block;
  color: var(--accent);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: .13em;
  text-transform: uppercase;
  margin-bottom: 4px;
}

/* ── the quiet day, and the signature ─────────────────────── */
.quiet { font-size: 19px; }
.quiet p { margin: 0; }
footer {
  margin-top: 34px;
  padding-top: 16px;
  border-top: 1px solid var(--rule);
  color: var(--faint);
  font-size: 12px;
  letter-spacing: .03em;
}
footer .sig {
  font-family: ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif;
  font-style: italic;
  font-size: 14.5px;
  color: var(--soft);
}

@media (max-width: 30rem) {
  header { padding-top: 32px; }
  .rows.timed > li { grid-template-columns: 1fr; gap: 2px; }
  .rows.timed > li::before, .rows.timed > li::after { display: none; }
  .when { font-size: 13px; }
}
@media print {
  body { background: #fff; color: #000; padding: 0; }
  .needs .rows > li { box-shadow: none; }
}
</style>
</head>
<body>
<main>
<header>
<p class="eyebrow">Morning brief</p>
<h1>${escape(greeting)}</h1>
<p class="date">${escape(data.dateLabel)}</p>
<div class="masthead-rule"></div>
</header>
${body}
<footer><span class="sig">Prepared for you by your chief of staff.</span></footer>
</main>
</body>
</html>`;
}
