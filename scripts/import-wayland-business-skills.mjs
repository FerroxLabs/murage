#!/usr/bin/env node
// Import the 32 business-pack skills the published assistant profiles declare.
//
// These are NOT in the Wayland role-skill tree that import-wayland-role-skills
// reads (waylandteams/skills/<role>/*.md). They live one directory over, in
// `bundled-extensions/business-<pack>/skills/<id>/SKILL.md`, which no importer
// ever looked at — so coin declared 11 skills and installed 3, and seven other
// profiles shipped the same way.
//
// 28 of the 32 are self-contained procedures and are copied body-for-body. The
// four orchestrators (legal, hr, market, support) are NOT: upstream routes them
// to 40+ sub-skills that exist in neither pack, so a verbatim copy would ship
// four routing tables to nothing. Those are hand-authored in skills-library/
// and this script leaves them alone — see ORCHESTRATORS below.
//
// Frontmatter is rewritten rather than copied: upstream carries plugin-only
// keys (slash_command, argument-hint, triggers, prerequisites) and a
// capability-list description. The house form is name / description / license /
// metadata, and the description is the trigger — so each one is authored here
// to say what the skill does, when to reach for it, and which sibling to use
// instead. Upstream lineage is preserved under metadata.attribution because
// several of these are MIT and Apache-2.0 ports.
//
// Usage: node scripts/import-wayland-business-skills.mjs [--src <dir>] [--out <dir>] [--dry-run]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const SRC = flag("--src", "/Volumes/Mando/wayland/app/resources/bundled-extensions");
const OUT = flag("--out", join(repoRoot, "skills-library"));
const dryRun = argv.includes("--dry-run");

/** Hand-authored in skills-library/; this script must not overwrite them. */
const ORCHESTRATORS = new Set(["legal", "hr", "market", "support"]);

const PACKS = {
  finance: "business-finance",
  legal: "business-legal",
  hr: "business-hr",
  sales: "business-sales",
  market: "business-marketing",
  content: "business-content",
  support: "business-support",
  commerce: "business-commerce",
};

// id → { title, license, tags, description }. The description is the index line
// the model reads when deciding whether to open the skill, so it carries the
// what / when / when-not-instead triple every time.
const SKILLS = {
  "finance-pl": {
    title: "Profit and loss statement",
    license: "Apache-2.0",
    tags: "pl accounting finance smb",
    description:
      "Build a profit and loss statement from revenue and expense inputs, with period-over-period comparison, margin analysis, basis-of-accounting handling (cash / accrual / modified cash) and ASC 606 deferred-revenue treatment for subscription revenue. Use when the question is whether a period made money and where the margin went. Do NOT use for what the business owns and owes at a point in time (use finance-balance-sheet), for whether cash actually moved (use finance-cashflow), or for forward-looking burn and time-to-zero (use coin-runway-and-burn). Statements and analysis only — have a CPA review anything filed or handed to a lender.",
  },
  "finance-balance-sheet": {
    title: "Balance sheet",
    license: "Apache-2.0",
    tags: "balance-sheet accounting finance smb",
    description:
      "Build a balance sheet — assets, liabilities and owner equity at a point in time — with entity-aware equity treatment (sole prop, partnership, LLC, S-corp, C-corp) and the GAAP vs tax-basis distinction called out. Use when someone needs the position statement for a loan application, a buyer, an investor, or a year-end close. Do NOT use for how a period performed (use finance-pl) or for where the cash went (use finance-cashflow). Statements and analysis only — have a CPA review before it goes to a third party.",
  },
  "finance-cashflow": {
    title: "Cash flow statement",
    license: "Apache-2.0",
    tags: "cashflow accounting finance smb",
    description:
      "Build a cash flow statement across operating, investing and financing activities, routing accrual filers to the indirect method and cash-basis filers to the direct method, with period-end reconciliation to the bank balance. Use when profit and cash disagree and the user needs to see why. Do NOT use for whether the period was profitable (use finance-pl), for the point-in-time position (use finance-balance-sheet), or for projecting months of runway forward (use coin-runway-and-burn).",
  },
  "finance-receivables": {
    title: "Receivables and collections",
    license: "Apache-2.0",
    tags: "receivables collections dso finance smb",
    description:
      "Age accounts receivable, calculate DSO, and generate an escalating collection sequence for overdue invoices with FDCPA and state-UDAP-aware language, intent-gated escalation, and statute-of-limitations-aware bad-debt write-off guidance. Use when invoices are past due and someone has to write the emails. Do NOT use for money the business owes out (use finance-payroll-prep for payroll liabilities or finance-sales-tax for tax liabilities) or for whether the period was profitable (use finance-pl). Templates only — a demand that escalates to litigation belongs with an attorney.",
  },
  "finance-r-and-d-credit": {
    title: "R&D credit and §174",
    license: "Apache-2.0",
    tags: "r-and-d tax-credit section-174 finance smb",
    description:
      "Walk Form 6765 R&D credit preparation and post-TCJA §174 capitalization together — four-part-test screening of activities, qualified research expense capture (wages, supplies, contract research), and the capitalization schedule software companies now have to keep. Use when the user has engineering payroll and wants to know what qualifies and what documentation to hold. Do NOT use for contractor 1099s (use finance-1099-prep), payroll returns (use finance-payroll-prep) or sales tax (use finance-sales-tax). Preparation package only — a CPA or EA must sign and file.",
  },
  "finance-1099-prep": {
    title: "1099 preparation",
    license: "Apache-2.0",
    tags: "1099 tax contractors finance smb",
    description:
      "Run 1099 season end to end — W-9 collection, the worker-classification gate (IRS 20-factor plus state ABC test) that has to clear first, the 1099-NEC vs 1099-MISC vs 1099-K decision tree, TIN matching and backup-withholding triggers. Use when the user paid contractors last year and January is coming. Do NOT use for W-2 payroll returns (use finance-payroll-prep) or for drafting the contractor agreement itself (use legal-contractor). Preparation workflow only — misclassification carries six-figure exposure, so have a CPA, EA or tax attorney review before filing.",
  },
  "finance-payroll-prep": {
    title: "Payroll tax preparation",
    license: "Apache-2.0",
    tags: "payroll tax form-941 finance smb",
    description:
      "Prepare quarterly Form 941 and annual Form 940 filings — deposit-schedule check, state UI and workers' comp matrix, new-hire reporting, S-corp reasonable-salary documentation (Watson, Glass Blocks, Fleischer factors) and fringe-benefit valuation. Use when the user runs W-2 payroll and a quarter is closing. Do NOT use for contractor 1099s (use finance-1099-prep), sales tax registration and filing (use finance-sales-tax), or whether a hire is affordable at all (use coin-runway-and-burn). Checklists only — have a payroll provider or CPA review before filing.",
  },
  "finance-sales-tax": {
    title: "Sales tax and nexus",
    license: "Apache-2.0",
    tags: "sales-tax nexus wayfair finance smb",
    description:
      "Track post-Wayfair economic nexus state by state, handle marketplace-facilitator law, build the multi-state registration and filing checklist, manage exemption certificates, and resolve tax-on-shipping rules, ending in a state-by-state exposure report. Use when the user sells across state lines and does not know where they are now required to register. Do NOT use for payroll or income tax (use finance-payroll-prep) or for R&D credits (use finance-r-and-d-credit). Analysis only — registration and voluntary-disclosure decisions belong with a state and local tax professional.",
  },

  "legal-dmca": {
    title: "DMCA notices",
    license: "Apache-2.0",
    tags: "dmca copyright safe-harbor legal smb",
    description:
      "Draft a DMCA takedown notice or counter-notice against the six §512(c)(3) elements, and walk designated-agent registration at dmca.copyright.gov plus the repeat-infringer policy a platform needs to keep safe harbor. Use when someone is hosting the user's copyrighted work, when the user has received a takedown they believe is wrong, or when the user runs a platform that hosts user content. Do NOT use for a general IP or breach demand letter (use legal-cease-and-desist) or for the product's own licence terms (use legal-eula). Templates only — a knowingly false notice or counter-notice carries §512(f) liability, so have an attorney review anything contested.",
  },
  "legal-eula": {
    title: "End-user licence agreement",
    license: "Apache-2.0",
    tags: "eula licence app-store legal smb",
    description:
      "Draft an end-user licence agreement — licence grant and scope, restrictions, ownership, warranty disclaimer and liability limits, plus the Apple App Store and Google Play addenda those stores require. Use when the user ships installable software, a mobile app, a plugin or a desktop tool. Do NOT use for a hosted service's terms of service and acceptable-use rules (use sentry-contracts-and-terms) or for how personal data is processed (use legal-gdpr). Template only — have an attorney licensed in the user's jurisdiction review before publication.",
  },
  "legal-cease-and-desist": {
    title: "Cease and desist letter",
    license: "Apache-2.0",
    tags: "cease-and-desist demand-letter legal smb",
    description:
      "Draft a cease-and-desist letter for trademark, copyright, IP misuse, defamation, breach of contract or unpaid debt, choosing tone deliberately (professional, firm, litigation-threat) and assembling the evidence section, the specific demand and the response deadline. Use when the user needs a formal written demand that a behaviour stop. Do NOT use for a platform takedown of hosted content (use legal-dmca) or for drafting the agreement being breached (use sentry-contracts-and-terms). Template only — a letter that threatens litigation can create liability of its own, so have an attorney review high-stakes versions before sending.",
  },
  "legal-gdpr": {
    title: "GDPR and data processing",
    license: "Apache-2.0",
    tags: "gdpr dpa privacy legal smb",
    description:
      "Produce a GDPR data-processing assessment, an Article 28 controller-to-processor DPA, or a sub-processor disclosure — covering lawful basis, transfer mechanism (SCCs and the transfer impact assessment), DPIA triggers, retention, and the data-subject-rights workflow. Use when the user handles EU or UK personal data, or a customer has sent a DPA to sign. Do NOT use for the product's licence terms (use legal-eula) or for general IP and compliance posture (use sentry-ip-and-compliance). Templates only — have a privacy attorney review before signing anything.",
  },
  "legal-contractor": {
    title: "Independent contractor agreement",
    license: "Apache-2.0",
    tags: "contractor ic-agreement abc-test legal smb",
    description:
      "Draft an independent contractor or consulting agreement behind a worker-classification gate (IRS 20-factor, state ABC test, UK IR35) — scope and deliverables, IP assignment, payment terms, confidentiality, exclusivity and termination. Use when the user is engaging a freelancer, agency or fractional operator. Do NOT use for issuing the 1099 at year end (use finance-1099-prep) or for employee offers and classification questions (use sentry-employment-and-classification). Template only — misclassifying an employee as a contractor carries six-figure back-tax and penalty exposure, so have an attorney review before signing.",
  },

  "hr-handbook": {
    title: "Employee handbook sections",
    license: "Apache-2.0",
    tags: "handbook policy hr people-ops smb",
    description:
      "Draft employee handbook sections — the policies law requires at the user's headcount (EEO, anti-harassment, ADA accommodation, FMLA, lactation, voting and jury and military leave, pay transparency, whistleblower, at-will plus the handbook-is-not-a-contract disclaimer, NLRA §7 carve-outs) and the standard-but-optional perks. Use when the user is writing or refreshing the handbook. Do NOT use for one employee's leave eligibility (use hr-leave-of-absence), one accommodation request (use hr-accommodation-request) or a termination (use hr-termination-letter). Templates only — have employment counsel review for the user's states before publishing.",
  },
  "hr-rif": {
    title: "Reduction in force",
    license: "Apache-2.0",
    tags: "rif layoff warn-act hr people-ops smb",
    description:
      "Plan a reduction in force — federal WARN Act analysis, state mini-WARN checks, a four-fifths-rule disparate-impact pre-check on the selection list before anyone is told, the notification timeline, and an OWBPA and ADEA-compliant severance and release framework including the 45-day disclosure for group terminations. Use when more than one person is being let go for business reasons. Do NOT use for a single involuntary termination (use hr-termination-letter) or for the departure logistics checklist (use hr-offboard). Framework only — employment counsel must clear selection and notice timing before any notification goes out.",
  },
  "hr-termination-letter": {
    title: "Termination letter",
    license: "Apache-2.0",
    tags: "termination separation hr people-ops smb",
    description:
      "Draft an involuntary termination letter — performance, RIF, policy violation or at-will — with state-specific final-pay timing, COBRA or state mini-COBRA notice, and an OWBPA and ADEA-compliant separation-agreement variant when the employee is 40 or over. Use when one person is being terminated and the letter has to be right. Do NOT use for a group layoff's WARN and disparate-impact analysis (use hr-rif) or for the checklist of what happens after the conversation (use hr-offboard). Templates only — have employment counsel review before delivery.",
  },
  "hr-offboard": {
    title: "Offboarding checklist",
    license: "Apache-2.0",
    tags: "offboarding separation hr people-ops smb",
    description:
      "Build the offboarding checklist for a departure — state-by-state final-pay timing, federal versus state mini-COBRA routing, OWBPA and ADEA separation-agreement scaffolding for employees 40 and over, McLaren Macomb-compliant non-disparagement wording, and the data-preservation step that has to happen before access is revoked. Use when someone is leaving, voluntarily or not, and the logistics need to be sequenced. Do NOT use for drafting the termination letter itself (use hr-termination-letter) or for a group RIF's WARN analysis (use hr-rif). Checklists only — have employment counsel review the separation agreement.",
  },
  "hr-leave-of-absence": {
    title: "Leave of absence",
    license: "Apache-2.0",
    tags: "fmla pfml leave hr people-ops smb",
    description:
      "Run a leave eligibility analysis and produce the paperwork — federal FMLA (50 employees within 75 miles, 12 months and 1,250 hours), the state PFML programs that stack on top of it, the request-response letter, the return-to-work plan and intermittent-leave tracking. Use when an employee asks for medical, family, parental or personal leave. Do NOT use for a disability or religious accommodation request (use hr-accommodation-request) or for the handbook's leave policy text (use hr-handbook). Analysis and templates only — have employment counsel confirm the user's state programs before the response letter goes out.",
  },
  "hr-accommodation-request": {
    title: "Accommodation request",
    license: "Apache-2.0",
    tags: "ada pwfa accommodation hr people-ops smb",
    description:
      "Document the ADA, PWFA or religious accommodation interactive process — request intake, the essential-functions and effectiveness analysis, the undue-hardship framework, the response letter (grant, alternative, or deny with reasons) and the appeal path. Use when an employee has asked for a change to how, when or where they work for medical, pregnancy or religious reasons. Do NOT use for FMLA or state PFML leave eligibility (use hr-leave-of-absence) or for the handbook policy that describes the process (use hr-handbook). Templates only — denials and undue-hardship claims should be reviewed by employment counsel before they are sent.",
  },

  "sales-prospect": {
    title: "Prospect analysis",
    license: "MIT",
    tags: "sales prospecting osint bant meddic smb",
    description:
      "Run a five-dimension workup on a target company from its URL using public sources only — company research, opportunity qualification, decision-maker mapping, competitive positioning and ICP fit — then aggregate a weighted prospect score, a prioritised action plan and a jurisdiction-gated first email (CAN-SPAM, CASL, GDPR and UWG §7 aware; refuses pure cold outreach to DE, AT and CH). Use when a whole account needs to be assessed before anyone reaches out. Do NOT use for a single BANT/MEDDIC pass on a lead already in play (use sales-qualify), for mapping named people only (use sales-contacts), or for deciding who to sell to at all (use sales-icp).",
  },
  "sales-qualify": {
    title: "Lead qualification",
    license: "MIT",
    tags: "sales qualification bant meddic scoring smb",
    description:
      "Qualify one lead against BANT (budget, authority, need, timeline) and MEDDIC (metrics, economic buyer, decision criteria, decision process, identified pain, champion) using public signals only, producing an opportunity quality score out of 100, an A-to-D grade and the recommended approach. Use when a lead is in the pipeline and the question is whether it is real. Do NOT use for the full five-dimension account workup (use sales-prospect), for mapping the buying committee (use sales-contacts) or for running the call itself (use sales-discovery-call).",
  },
  "sales-contacts": {
    title: "Buying committee map",
    license: "MIT",
    tags: "sales contacts buying-committee multi-threading smb",
    description:
      "Map the buying committee at a target company from public sources only, classify each person by buying role (economic buyer, champion, technical evaluator, end user, blocker, coach), find a genuine personalisation anchor per contact with no invented mutual connections, and propose a multi-threading sequence. Use when a deal is single-threaded and needs more of the account involved. Do NOT use for scoring whether the opportunity is real (use sales-qualify), for the full account workup (use sales-prospect) or for handling pushback once conversations start (use sales-objection-handling).",
  },
  "sales-icp": {
    title: "Ideal customer profile",
    license: "MIT",
    tags: "sales icp personas targeting smb",
    description:
      "Build an ideal customer profile across firmographic, technographic, behavioural, pain-point, budget and channel dimensions, plus the negative ICP, a 100-point scoring rubric, buyer personas, a prospecting playbook and a first-outreach draft that inherits the jurisdiction gates. Use when the user is selling to everyone and closing no one, or when a new segment needs defining. Do NOT use for evaluating one named account (use sales-qualify or sales-prospect) or for the pricing and packaging that follows from the segment (use forge's pricing work).",
  },

  "market-audit": {
    title: "Marketing audit",
    license: "MIT",
    tags: "marketing audit scoring cro seo smb",
    description:
      "Run a five-dimension marketing audit on a business URL — content and messaging, conversion, SEO, competitive position, and brand and strategy — scored in parallel and aggregated into a weighted overall score with a prioritised action plan. Use when the user wants to know what is wrong with their marketing as a whole. Do NOT use for a single page's conversion teardown (use market-landing), for brand identity and visual system work (use mira-brand-foundation) or for a funnel-stage drop-off diagnosis (use marketing-funnel-diagnosis).",
  },
  "market-landing": {
    title: "Landing page teardown",
    license: "MIT",
    tags: "marketing landing-page cro conversion smb",
    description:
      "Run a section-by-section conversion teardown of one landing page — hero, value proposition, social proof, features, objection handling, CTA and footer — plus form, mobile and page-speed audits, ending in prioritised fixes split into quick wins, strategic and long-term, with A/B test hypotheses. Use when one page has traffic and is not converting. Do NOT use for a whole-site marketing audit (use market-audit), for the copy voice and awareness-stage decisions behind it (use copy-awareness-stages) or for the visual system it should sit inside (use mira-visual-system).",
  },

  "content-about-page": {
    title: "About page",
    license: "MIT",
    tags: "content personal-brand about-page storytelling direct-response",
    description:
      "Build a long-form About page that converts — not a bio in paragraphs, but a direct-response asset that opens on the reader's problem, tells the story of discovery, proves the path with results, and closes on an explicit next step, delivered as a section brief plus paste-ready copy. Use when an About page reads like a résumé or a career history, or when building one from scratch for a founder, coach or consultant. Do NOT use for a short bio or speaker blurb, for a sales page (use copywriter), or for the underlying positioning work (use personal-brand-strategy).",
  },
  "content-haro-reply": {
    title: "Journalist source reply",
    license: "MIT",
    tags: "content earned-media haro pr expert-source",
    description:
      "Write a HARO, Qwoted or SourceBottle expert-source reply that gets quoted instead of skimmed — a credentialed one-liner that answers why this source for this query, three to five tight bullets with specifics and a contrarian angle, and a closing pull quote written to be lifted verbatim. Use when a journalist query has landed, the user genuinely has the expertise, and there is a short reply window. Do NOT use for a press release or a cold pitch to a journalist with no query (use content-brief for the underlying angle) or for long-form thought leadership (use copywriter).",
  },

  "commerce-ugc-prompts": {
    title: "UGC and review prompts",
    license: "MIT",
    tags: "ecommerce ugc review-prompt photo-review anti-incentive",
    description:
      "Ask for reviews, photos and video at the moment the customer is most likely to say yes — prompt timing by product category (consumable, durable, cosmetic, apparel), template copy per channel, an incentive structure that stays inside platform anti-incentive rules, and the photo and video CTA. Use when a store has orders but almost no reviews. Do NOT use for responding to reviews already left, for the storefront and merchandising build (use vault-storefront-foundation), or for marketplace listing operations (use vault-marketplace-ops).",
  },
};

/** Wayland-plugin call syntax that means nothing outside that host. Each of
 * these is a single line in the source; the replacement keeps the instruction
 * and drops the call. */
const REWRITES = [
  [/\s*using `build_report_path\([^`]*\)` when writing to file/g, " to a dated Markdown file in the workspace"],
  [/`build_report_path\("business-[a-z-]+",\s*"([^"]*)"\)`/g, "`$1` in the workspace"],
  [/`build_report_path\("business-[a-z-]+",\s*f?"[^"]*"\)`/g, "a dated Markdown file in the workspace"],
  [/`build_report_path\([^`]*\)`/g, "a dated Markdown file in the workspace"],
  [/\s*via `skill_view\([^`]*\)`/g, ""],
];

/** Host tool names left in the body after REWRITES. They are named as concepts
 * the body depends on, so they stay — but the reader is told to map them. */
const HOST_TOKENS = /delegate_task|web_extract|`terminal`|execute_code|file_tools|analyze_page\.py/;
const HOST_NOTE = [
  "> **Host tools.** This procedure names Wayland's tool set. Map each to whatever this host provides:",
  "> `web_extract` → the web-fetch tool, `terminal` → the shell, `execute_code` → a scratch script,",
  "> `file_tools.*` → read/write, `delegate_task` → subagents (or run the phases yourself, in order).",
  "> Where a helper script such as `analyze_page.py` is named and not present, do that parsing inline.",
].join("\n");

const yaml = (value) => JSON.stringify(String(value ?? "").replace(/\s+/g, " ").trim());

let written = 0;
const problems = [];

for (const [id, meta] of Object.entries(SKILLS)) {
  if (ORCHESTRATORS.has(id)) continue;
  const pack = PACKS[id.split("-")[0]];
  const source = join(SRC, pack, "skills", id, "SKILL.md");
  if (!existsSync(source)) { problems.push(`${id}: no source at ${source}`); continue; }

  const raw = readFileSync(source, "utf8");
  const split = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  if (!split) { problems.push(`${id}: source has no frontmatter`); continue; }

  let body = split[1].trim();
  for (const [pattern, replacement] of REWRITES) body = body.replace(pattern, replacement);
  if (HOST_TOKENS.test(body)) {
    // After the first H1 so the disclaimer blockquote several of these open
    // with still reads first.
    const heading = body.match(/^# .+$/m);
    body = heading
      ? body.replace(heading[0], `${heading[0]}\n\n${HOST_NOTE}`)
      : `${HOST_NOTE}\n\n${body}`;
  }

  const upstream = raw.match(/^\s*lineage:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "Wayland Business Suite";

  const frontmatter = [
    "---",
    `name: ${id}`,
    `description: ${yaml(meta.description)}`,
    `license: ${meta.license}`,
    "metadata:",
    "  author: wayland",
    '  version: "1.0.0"',
    `  tags: ${yaml(meta.tags)}`,
    `  category: ${yaml(id.split("-")[0])}`,
    `  attribution: ${yaml(upstream)}`,
    "---",
  ].join("\n");

  const dir = join(OUT, id);
  if (!dryRun) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `${frontmatter}\n\n${body}\n`);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      id,
      name: meta.title,
      version: "1.0.0",
      description: meta.description.replace(/\s+/g, " ").trim(),
      defaultEnabled: false,
      triggerTerms: meta.tags.split(" "),
      requiredCapabilities: [],
    }, null, 2) + "\n");
  }
  written += 1;
}

console.log(`business skills written ${written}${dryRun ? " (dry run)" : ""}`);
console.log(`orchestrators hand-authored, left alone: ${[...ORCHESTRATORS].join(", ")}`);
for (const problem of problems) console.log(`  ${problem}`);
process.exit(problems.length ? 1 : 0);
