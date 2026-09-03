// What each assistant profile is FOR, as the words a person would type.
//
// WHY THIS FILE EXISTS. The relevance gate used to ask "does any word of the
// answer appear anywhere in this profile's text?", where "this profile's text"
// meant the catalogue entry PLUS every word of all ~25 of its skill manifests.
// Measured on the shipped library that bag runs 200-600 ordinary English words
// per profile, and the manifests are full of quoted example utterances — so
// ONE common word landed anywhere in it was enough to confirm a profile:
//
//   "ferret keeps escaping the hutch"  -> Customer Success Org, on `keeps`
//                                         (from "the forecast keeps missing"
//                                          inside patch-crm-hygiene's manifest)
//   "gutters need doing before winter" -> Validate Before Build, on `before`
//                                         (from that profile's own NAME)
//
// No score threshold can separate those from a real match: `smart-trader` on
// the word `trading` and `customer-success-org` on the word `keeps` are both
// EXACTLY one whole-word hit. The bag is the defect, not the cut through it.
//
// So the bag is replaced by a deliberately chosen list per profile. A curated
// term is a claim: "someone who types this word means this profile". Nothing
// statistical over skill manifests recovers that, because the manifests
// describe how a skill talks, not what the profile is for.
//
// HOW THIS WAS PRODUCED (re-runnable by hand, reviewed by eye):
//   1. First pass, derived per slug from the catalogue entry ONLY — name,
//      summary, category, outcome. Skill manifests were deliberately excluded:
//      `keeps` came from a manifest, and, more decisively, "team launcher"
//      profiles declare the UNION of their members' skills (cold-outbound
//      ships every skill research, copy and sales ship), so manifest-derived
//      terms make every launcher a superset of every specialist it contains.
//   2. Everything in INTAKE_GENERIC_WORDS below removed.
//   3. Read all 129 lists; per-slug junk pruned by hand (tokenizer debris like
//      "don" from "don't", and entry prose that is not a topic: Advisor's
//      "care", Helm's "avoiding", Mira's "betterness").
//   4. Terms ADDED by hand wherever the entry text never says the word a
//      person would type. This is the part no derivation could do:
//        - `coin` never says "invoice" anywhere in its entry; the word lives
//          only in finance-receivables' manifest prose. "chasing invoices" is
//          the example printed on the card, so `invoice` is written in.
//        - `smart-trader`'s entry says "charts", "markets", "trader" — never
//          "trading", "stocks", "futures" or "forex".
//        - `advisor` ships habit-architect and task-prioritization; its entry
//          says none of "productivity", "procrastination", "priorities".
//      Thirteen additions deliberately override INTAKE_GENERIC_WORDS, because
//      the word is generic everywhere EXCEPT there: "reviews" for
//      review-engine and local-seo-reviews, "review" for verdict,
//      review-article-factory and comparison-roundup-builder, "quality" for
//      verdict, "templates" for template-factory, "office" for
//      back-office-crew, "writing" and "style" for writer and voiceprint,
//      "choose" for advisor, "explain" for explainer. Each one is a claim that
//      a person typing that word alone probably means that profile.
//
// WHAT THIS FILE IS NOT: a synonym dictionary, and not a scoring table. Every
// term is equal, and the gate that reads them is still "one whole word".
//
// ADDING A PROFILE: add its slug here. A slug that is missing still works —
// see `intakeVocabulary` — but it falls back to entry text filtered through
// INTAKE_GENERIC_WORDS, which is a weaker answer than a reviewed list.

/** The words that mean each profile, space separated, lowercase, whole words.
 *
 *  Space separated rather than arrays because this file is READ by people —
 *  a diff that adds one word should be one word wide. `intakeMatchTerms`
 *  splits and caches. */
export const INTAKE_MATCH_TERMS: Readonly<Record<string, string>> = {
  beacon: "acquisition ads advertising audience avinash based budget business channel channels discovery growth intent kaushik marketing mix seo social traffic",
  coin: "accounting bookkeeping budget burn cash cashflow crabtree economics expenses finance financial forecast founder frame friendly greg invoice invoices invoicing margin math numbers payroll pricing profit receivables revenue runway tax taxes unit",
  copy: "audience awareness bio convert copy copywriter copywriting ctas customer email headline headlines hook hooks landing linkedin marketing newsletter pages personal posts sales subject voice website wording",
  forge: "based buyer discount madhavan monetise monetize offer outcome packaging price pricing product ramanujam research sell value",
  helm: "ben cadence coach coaching decision founder frames horowitz leadership management stuck thinking unstuck",
  humanizer: "detection human humanise humanize humanizer plagiarism prose rewrites scan tone",
  lens: "analyst analytics cohort conversion dashboard diagnose diagnosis experiment funnel kaushik kohavi kpi measurement metrics research retention",
  mend: "churn customer design lincoln murphy onboarding outcome prevention renewal retention success support ticket triage",
  mira: "brand branding design identity logo marty neumeier positioning systems visual",
  patch: "admin cadence crm design documentation harnish hygiene operating operations ops process processes scaling sop sops verne workflow",
  probe: "design discipline door eric experiment fake hypothesis mvp prototype quantitative research ries test testing tests validate validation validator",
  "quiet-money-career-strategist": "auditor career comp compensation cost equity income job jurisdiction market money negotiation offer position quiet raise salary strategist value",
  "quiet-money-generational-planner": "beneficiaries decision disability education equity estate generational guardian guardians guardianship income inheritance insurance jurisdiction money planner position probate quiet testament",
  "quiet-money-position-auditor": "auditor debt equity finances financial income insurance jurisdiction money networth position quiet savings spend",
  "quiet-money-spending-auditor": "audit auditor budget expenses lifestyle money position quiet spend spending subscriptions test",
  "quiet-money-time-coach": "audit balance coach freedom income lifestyle money overwork position quiet test wealth",
  "quiet-money-windfall-navigator": "divorce health income inheritance money navigator payout protocol protocols redundancy windfall windfalls",
  "quiet-money": "advice anti boring coach debt durable educational finance financial guru intake math money path personal quiet savings stand urgency wealth",
  research: "bob competitor competitors customer interview interviews jobs moesta persona product research segmentation survey",
  sales: "advancement call close closing continuation deal deals disciplined discovery mechanics objection objections pipeline prospect prospects quota sale sales sell selling sorting spin",
  sentry: "business compliance contract contracts corp counsel formation incorporation lawyer legal llc privacy service starting startup terms trademark",
  slate: "candidate claire contractor design employee employees evaluation hire hiring hughes interview job johnson onboarding outcome recruit recruiting scaling staff structured structuring talent",
  smith: "adrs api architect architecture backend code coding developer engineering frontend handoffs ryan singer software specs technical",
  spark: "architecture book course curriculum design education learner lesson mctighe students syllabus teaching training transformation wiggins",
  stage: "andy company deck decks demo framing fundraising inevitable investor narrative pitch presentation raskin sell sequoia storytelling strategic trend",
  vault: "conversion discovery dtc ecommerce listings marketplace optimization optimize page product sell shop shopping store storefront",
  verdict: "content critique edit editing flags proofreading quality review rewrite",
  voiceprint: "beat brand captures path profile report samples self style tone voice voiceprint writing",
  "academic-paper": "academic bibliography citation citations creator dissertation docx equations formatted formatting journal latex paper papers references reports research scholarly structured table technical thesis white word",
  advisor: "advisor choice choose criteria decide deciding decision dilemma focus goals habits priorities procrastination productivity thinking tradeoffs",
  "beautiful-mermaid": "ascii beautiful chart diagram diagrams flowchart generating mermaid rendered svg terminal themed visual",
  "book-copy-editor": "book change consistency copy copyedit correctness edited editor grammar manuscript proofread publishing traceable",
  "book-developmental-editor": "architect book chapter chapters developmental editing editor editorial manuscript publishing report structural",
  "book-nonfiction-architect": "architect argument book chapter chapters fiction nonfiction outline publishing",
  "book-production": "accept book clean copy formatted formatting front kdp manuscript matter production publishing store typesetting",
  "book-publisher": "author book clean edit fastest ground kdp publish publisher publishing shared stand workspace",
  "book-story-architect": "architect bible book chapters characters drafting fiction lead maintained novel outline plot publishing story",
  builder: "automation automations bot bots code design scripting workflow",
  "cli-setup": "authenticate authenticated backend backends broken claude cli clis code codex coding connect connections expert kimi murage opencode qwen setup",
  concierge: "concierge unsure",
  cowork: "artifact cowork description editable finished knowledge oriented outcome useful verifiable workspace",
  creator: "content creative creator image instagram model pictured posts prompt prompts scripts social tiktok video visual youtube",
  "dashboard-creator": "chart charts creator csv dashboard dashboards data datasets excel formula formulas reporting spreadsheet spreadsheets tabular xlsx",
  "excel-creator": "analyzes creator edits excel formulas officecli spreadsheet spreadsheets workbook xlsx",
  explainer: "concept concepts example explain explainer explanation learn learning teach teaching tutorial worked",
  "financial-model-creator": "assumptions business cashflow creator driven excel financial forecast formula model models projections prompts sheet spreadsheets text valuation",
  "game-3d": "adventure based contained containing file game games generating html immediately platformer requests runnable runs self single star",
  "human-3-coach": "based burnout coach coaching dan development discipline habits holistic human koe mindset motivation personal procrastination purpose system vocation wellbeing",
  ignition: "beginner business designed ignition income landing online page website",
  "moltbook-skills": "browses comments communities ember moltbook network posts published social upvotes",
  moltbook: "agents helping interact moltbook network registered social",
  "morph-ppt-3d": "built cinematic deck glb models morph ppt pptx presentations smooth transitions",
  "morph-ppt": "animated animation beautiful deck morph ppt pptx presentations slides",
  "pitch-deck-creator": "creator deck investor narrative officecli pitch powerpoint pptx presentation presentations scratch slides",
  "planning-with-files": "acquired context disk files manus markdown memory meta persistent productivity survives window",
  "ppt-creator": "analyzes creator deck edits officecli powerpoint ppt pptx presentations",
  researcher: "citations evidence facts research researcher search source sources",
  "smart-trader": "backtest charts crypto forex futures indicator investing markets picture portfolio smart stocks ticker trade trader trades trading tradingview tvcontrol",
  "star-office-helper": "companion dedicated helper integration locally murage setup star visualization",
  "story-roleplay": "character creative fiction game narrative roleplay sillytavern story",
  "ui-ux-pro-max": "chart chosen color comprehensive database design direction expertise font guidelines habit includes pairings palettes powered stacks styles tech",
  "word-creator": "analyzes creator docx edits officecli word",
  "word-form-creator": "checkbox content controls creator designated docx editable fields fillable forms mail merge placeholders protection stay word",
  writer: "article blog changes drafting edited editing prose rewrite text writer writing",
  "100x-marketing": "assets audience bet business campaign channel clean credible date decision explicit focused goal growth insight launch marketing measurable measurement ownership promise turning",
  "ad-account-mechanic": "account ads advertising analyst call campaign channels copy creative facebook google kill mechanic offer ops paid roas scale sell",
  "affiliate-site-engine": "affiliate analyst blog channels content copy driven engine niche research sell seo site",
  "back-office-crew": "admin analyst inbox inventory numbers office operations ops orders store support",
  "bootstrap-profit": "bootstrap bootstrapping cashflow channels impact levers numbers offer profit profitability ramen revenue sales sell",
  "caption-carousel-studio": "brand caption carousel copy cta discovery fitted instagram post posts research sales slides social static studio terms",
  "cohort-ops-control-tower": "analyst channels cohort comms community control copy course flags ops program reminders risk schedule students tower",
  "cold-outbound": "cold copy email intake leads outbound outreach prospecting research sales sell",
  "cold-pitch-bench": "buyer cold email outbound outreach pitch prospect prospecting researcher sell sequence voice",
  "comparison-roundup-builder": "affiliate article code comparison copy money page research review roundup schema versus",
  "competitor-watch": "announcements approved bot changed changes competitor cosmetic dated detect evidence explains ignores intelligence launch material matter moves noise pages positioning pricing product public records strategy watch watches",
  "content-refresh-crew": "analyst articles blog content copy prioritized queue refresh research rewritten sections seo",
  "content-studio": "blog brand channels content copy editorial lens pipeline publish publishing social variants voice",
  "creator-studio": "audience brand channels copy creator creators monetise monetize newsletter sponsorship studio",
  "customer-success-org": "accounts anchor audit churn churning company customer health keeper lens mend org patch renewal renewals retention save score scores success support",
  "daily-briefing": "brain briefing chief coach counsel digest dump loop matters morning numbers sales standup summary",
  "damage-control": "apology assess backlash brand comms control copy counsel crisis damage exposure legal protect reputation research statement",
  "dev-shop": "audit code company cto dev developer engineering features founders garry gstack health inspired patch releases repo sentry shipping shop smith software standups tan verdict workflow",
  "ecommerce-engine": "brand channels copy dtc ecommerce engine fulfillment fulfilment marketplace operation optimize orders sell shopify store storefront support",
  "editorial-newsroom": "articles audit beacon calendar chief company content editor editorial issues lens mira newsroom performance publishing quill scout series",
  "email-lifecycle-crew": "analyst automation broadcast calendar channels copy email flows lifecycle newsletter research sequences",
  engineering: "backend boundaries calling convert engineering implementation inspects interface owned ownership product protects result safely separates sequenced shipped software system verifies",
  "fine-print-guard": "adversarial agreement audit clause contract contracts counterparty fine guard legal lock payment print redline redlines risk terms threat writer",
  "first-customers": "acquisition channels copy customers launch research sales sell",
  "founder-setup": "admin brand counsel financial foundation founder incorporation legal numbers operational ops setup startup",
  fundraise: "assembling brand copy deck fundraise fundraising investor investors model narrative numbers pitch raise seed sell",
  "growth-loop": "acquisition analyst channels funnel growth impact loop loops research retention sell",
  "hook-lab": "brand copy hook hooks lab reels research script shorts video",
  "inbox-follow-up": "approve bot closed concise conversations crm duplicates emails exchange grounded identifies mailbox operations owes promised recover removes response sales threads unanswered",
  "info-product-launch": "assembles book brand channels copy course digital info launch product sell",
  "lead-gen-outbound": "copy gen icp lead leads multi outbound outreach personalized prospect prospecting research sales sell sequence squad support touch",
  "lead-magnet-forge": "brand branded channels copy delivery email forge freebie landing lead magnet opt optin research",
  "lesson-scripting-crew": "camera coach copy course humanizer length lesson script scripting teaching timed video",
  "link-disclosure-custodian": "affiliate analyst code compliance counsel custodian dead disclosure ftc link links site",
  "listing-forge": "amazon copy description etsy forge listing listings platform product research sell shopify storefront",
  "local-seo-reviews": "analyst business copy engine google local maps optimized pages profile research reviews sell seo support visibility",
  "marketing-agency": "agency audit beacon campaigns channels clients cmo company director fires heartbeat lens marketing mira quill scout sell",
  "marketing-strategy": "analyst brand campaign channels copy marketing numbers offer page pipeline positioning research scored sell strategy",
  "offer-vetting-desk": "affiliate commissions numbers offer offers programs research scored shortlist vetting",
  "paid-ads-war-room": "ads advertising analyst budget call campaign channels copy kill launch offer paid roas scale sell war",
  "pre-mortem-room": "adversarial audit buyer channel failure kill launch modes mortem pre risk risks writer",
  "pricing-tribunal": "adversarial anchor churn discount offer packaging price pricing rewritten sell tiers tribunal value",
  "product-launch": "assembles brand channels coordinated copy launch market product release research sales sell",
  "promo-calendar-war-room": "calendar channels copy dated deal discount ops promo promotion research sale sell swap war",
  "quiet-money-council": "auditor career coach council finance generational layers leader money navigator numbers orchestrates personal planner position quiet specialists spending strategist wealth windfall",
  "quiet-money-standing": "audit coach company defense finance money personal quiet rollup savings schedule spending state workspace",
  "reddit-lead-miner": "bot buying careful communities context conversations customer genuine icp lead leads noise opportunity outreach prepares pretending problem product qualified reddit reveal sales scores searches separates signals solves spamming",
  "reply-desk": "comments copy dms engagement flagged inbox leads queue replies reply research sales support warm",
  "repurpose-engine": "channels clips content copy engine humanizer platform posts recording recycling repurpose repurposing research shorts",
  "review-article-factory": "affiliate article copy counsel disclosure factory links placed product publish research review roundup",
  "review-engine": "analyst copy digest engine feedback ratings replies reviews sequence solicitation support testimonials",
  "saas-mvp-sprint": "app brand code copy direction landing launch mvp page pipeline prototype saas software sprint validation validator visual",
  "sales-org": "anchor audit company crm deals forge lens org outbound pace pipeline quota sales scout sell sequences stalled",
  "sales-pipeline": "bottleneck crm deals focused forecast offer pipeline research sales sell sharpens",
  "seo-content-engine": "analyst articles blog calendar cluster content engine keyword keywords optimized publish ranking research seo",
  "seo-growth": "briefs confidence consolidates constraints demand diagnoses effort evidence grounded growth impact maps marketing opportunities practical provide rank roadmap search seo strongest technical useful",
  "service-studio": "agencies agency b2b clients consultancies consulting offer ops productised productized research sales service services studio",
  "student-support-desk": "clustered coach docs education macros ops replies research student students support tickets tutoring",
  "support-stack": "churn consistent copy customer helpdesk macros onboarding ops prevention service stack support tickets triage voice",
  "template-factory": "brand copy digital etsy factory listing printables products sales sell templates",
  "trend-desk": "brand brief copy newsjacking research topical trend trending trends",
  "validate-before-build": "hypothesis idea offer prototype research runs startup test validate validation validator",
  "validation-cell": "analyst cell copy idea kill pivot research smoke test validate validation validator verdict",
  "war-room": "advisors board cfo critique customer decision growth skeptic strategy verdict voice war",
  "winning-product-war-room": "analyst dossier dropshipping numbers page product research sourcing validation war winning",
};

/** Ordinary English, plus the words that describe the SHAPE of a catalogue
 *  entry rather than its subject ("pick me to auto-assemble a crew that
 *  delivers a scored gate"), plus tokenizer debris ("don't" -> `don`,
 *  "how-tos" -> `tos`).
 *
 *  Not a general stopword list and not a frequency cut: it is the answer to
 *  "would a person typing ONLY this word mean anything in particular?". It is
 *  applied when building the lists above, and again to the fallback
 *  vocabulary of a profile that has no list yet — which is the one place it
 *  still runs at match time. `keeps` and `before`, the two shipped
 *  reproductions of this bug, are both in here. */
export const INTAKE_GENERIC_WORDS: ReadonlySet<string> = new Set(`
  able about above across actual actually add added adding after again against agent all almost
  along already also although always among amount and annual another answer answering answers
  any anyone anything applies apply are around aside ask asks assemble assistant auto away back
  because been before behind being below beside best better between beyond both box bring
  bringing broad build builder building builds but came can cannot chained check checklist
  choose claim claimed claims clear clearer come comes coming common complete convene could
  couple covering create creates creation crew current currently daily day days deep deliver
  delivered delivers desk detail details did different document documents does doesn doing
  domains don done double down draft drafts during each earlier early either else end enough
  especially even ever every everyday everyone everything exactly except exist existing exists
  explain far few find finds first five fix fixes follow following for form format formats four
  framework frameworks fresh friday from full further gate gates general generate generates
  generic get gets getting give given gives goes going gone good got great guidance guide guides
  had half hand handle handling handoff hands has have having head help helps her here high
  highest him his hour hourly how however ins inside install installed instead into its itself
  just keep keeps kept kit know known laid large last late later launcher layer least leave left
  less let level like likely line lines list lists little live long look looking lots loud made
  main make makes making many may maybe mean means method methodology methods might mode modern
  monday month monthly months more most move much must name names native near need needed needs
  never new next nine nobody non none nor not nothing now number off office often once one ones
  only onto option options orchestrator other others our out output outputs outside over own
  package packaged part particular passes past people per perhaps persists person pick place
  plan planning plans plus point practice practices prepare produce produced produces
  professional project proven push put quality quarterly question questions quick quickly
  quickstart quite rather read reads ready real really related relevant request required
  requires return returns review reviews right room router run running said same saturday saw
  say says scope second see seen send sends session sessions set sets seven several shall shape
  shaped she ship short shorter should show shown shows side silently simple since six skill
  skills small smaller some someone something soon sort spec specialised specialist specialized
  specific stage stages standard standing start starts stated step steps stiff still stops
  structure structures style such sunday sure swallowed take taken takes talk task tasks team
  teams technique techniques tell template templates ten than that the their them themselves
  then there these they thing things think thinker third this those three through throughout
  thus time times today together too took tool toolkit tools topic topics tos total toward
  towards turn turns two type types under unrelated until update updates upon use used user
  users uses using usually verified version very via view visible want wanted wants warmer was
  way ways week weekly weeks well went were what whatever when whenever where whether which
  while who whole whom whose why wide will with within without work working works worth would
  write writes writing written wrong wrote year years yet you your yours yourself
`.trim().split(/\s+/));

const parsed = new Map<string, ReadonlySet<string>>();

/** This profile's curated terms, or null when it has none.
 *
 *  NULL IS THE INTERESTING ANSWER: it is what routes `intakeVocabulary` to its
 *  fallback, and it is the only way a profile added to the catalogue after
 *  this file was written can still be matched at all. */
export function intakeMatchTerms(slug: string): ReadonlySet<string> | null {
  const cached = parsed.get(slug);
  if (cached) return cached;
  const raw = Object.hasOwn(INTAKE_MATCH_TERMS, slug) ? INTAKE_MATCH_TERMS[slug] : undefined;
  if (raw === undefined) return null;
  const set: ReadonlySet<string> = new Set(raw.split(" ").filter(Boolean));
  parsed.set(slug, set);
  return set;
}

/** A word set for text that has no curated list, with the generic words taken
 *  out. The fallback path only. */
export function intakeGenericFilteredWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word && !INTAKE_GENERIC_WORDS.has(word)) words.add(word);
  }
  return words;
}
