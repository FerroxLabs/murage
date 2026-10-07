// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP claim vocabulary v1: the published lists the owner-evidence grammar
// (I-3) and the authored-statement grammar (I-3b) read. The same lists are
// published for people in lanes/pip/CLAIM-VOCABULARY.md; a test keeps the two
// in step. Pure data, no imports.

/** Contractions folded before any matching (after lower-casing, straight apostrophes). */
export const CONTRACTIONS: ReadonlyArray<readonly [string,string]> = [
  ["you'd","you would"],["you'll","you will"],["you're","you are"],["you've","you have"],
  ["we're","we are"],["we'd","we would"],["we'll","we will"],["i'm","i am"],["i'll","i will"],["i'd","i would"],
  ["don't","do not"],["doesn't","does not"],["won't","will not"],["can't","cannot"],["isn't","is not"],
  ["aren't","are not"],["shouldn't","should not"],["mustn't","must not"],["wouldn't","would not"],["haven't","have not"],
];

/** Words that make a sentence uncertain; matched on token boundaries. */
export const REPORTED_SPEECH = ["you said","you wrote","you claimed","you told me","according to"] as const;
export const SUBORDINATORS = ["if","unless","when","whenever","because","although","so that","in case","whether","as long as","until","while"] as const;
export const HEDGES = ["maybe","perhaps","sometimes","probably","possibly","i think","i guess","i suppose","kind of","sort of","a bit","seem","seems","seemed","appear","appears","might","could"] as const;

/** Negation tokens: one leading `not`, `never` or `no longer` is the claim's polarity; any other remaining token refuses the sentence. `without` is not one. */
export const NEGATION_TOKENS = ["not","never","no","nor","neither","cannot","nothing","nobody","none","nowhere"] as const;

/** Accepted lexical forms: token -> [property, value]. Within one property every pair of distinct values is an exclusive pair. */
export const LEXICON: Readonly<Record<string,readonly [string,string]>> = {
  brief:["answer-detail","brief"],briefly:["answer-detail","brief"],concise:["answer-detail","brief"],concisely:["answer-detail","brief"],
  short:["answer-detail","brief"],terse:["answer-detail","brief"],succinct:["answer-detail","brief"],
  detailed:["answer-detail","detailed"],thorough:["answer-detail","detailed"],thoroughly:["answer-detail","detailed"],
  verbose:["answer-detail","detailed"],comprehensive:["answer-detail","detailed"],lengthy:["answer-detail","detailed"],
  formal:["formality","formal"],formally:["formality","formal"],professional:["formality","formal"],
  casual:["formality","casual"],casually:["formality","casual"],informal:["formality","casual"],relaxed:["formality","casual"],
  warm:["warmth","warm"],friendly:["warmth","warm"],kind:["warmth","warm"],gentle:["warmth","warm"],
  cold:["warmth","cold"],distant:["warmth","cold"],curt:["warmth","cold"],harsh:["warmth","cold"],
  direct:["directness","direct"],blunt:["directness","direct"],candid:["directness","direct"],frank:["directness","direct"],
  indirect:["directness","indirect"],vague:["directness","indirect"],evasive:["directness","indirect"],
  reliable:["reliability","reliable"],dependable:["reliability","reliable"],consistent:["reliability","reliable"],
  unreliable:["reliability","unreliable"],flaky:["reliability","unreliable"],inconsistent:["reliability","unreliable"],
  punctual:["punctuality","punctual"],prompt:["punctuality","punctual"],timely:["punctuality","punctual"],
  late:["punctuality","late"],tardy:["punctuality","late"],
  playful:["humor","playful"],funny:["humor","playful"],humorous:["humor","playful"],
  serious:["humor","serious"],solemn:["humor","serious"],
  confident:["confidence","confident"],decisive:["confidence","confident"],
  hesitant:["confidence","hesitant"],tentative:["confidence","hesitant"],
  polite:["politeness","polite"],courteous:["politeness","polite"],respectful:["politeness","polite"],
  rude:["politeness","rude"],impolite:["politeness","rude"],disrespectful:["politeness","rude"],
  patient:["patience","patient"],impatient:["patience","impatient"],
};

/** Base verbs: the first token of a VP must be one of these (`apologize` is admitted, `apologizing` is not). Gerund phrases after `stop` and `keep` are checked against this list through the gerund rule. */
export const BASE_VERBS: readonly string[] = [
  "accept","acknowledge","act","add","address","admit","adopt","advise","agree","allow","announce","answer","apologize","appear","apply","approve","argue","ask","assume","attach","avoid",
  "back","be","begin","believe","bring","build","bump","call","cancel","care","carry","change","charge","chase","check","choose","clarify","clean","close","comment","commit","compare","complain","complete","confirm","consider","contact","continue","copy","correct","count","create","cut",
  "decide","decline","default","define","delay","delete","deliver","describe","design","disagree","discuss","dismiss","display","do","double-check","draft","drop",
  "edit","email","encourage","end","enforce","ensure","escalate","estimate","examine","exaggerate","expand","explain","explore",
  "fail","fill","find","finish","fix","flag","focus","follow","forget","forward","frame","gather","get","give","go","greet","guess",
  "handle","hedge","help","hide","highlight","hold","hurry","ignore","include","indicate","inform","insist","interrupt","introduce","invent","invoice","involve",
  "join","jump","justify","keep","know","label","lead","leave","let","lie","limit","link","list","listen","log","look","lose",
  "make","mark","mention","merge","mirror","miss","mix","monitor","move","name","narrate","need","note","notice","notify",
  "offer","omit","open","order","organize","over-explain","overpromise","paraphrase","pause","pick","plan","point","post","praise","prefer","prepare","present","press","pretend","prioritize","proceed","promise","propose","protect","provide","push","put",
  "quote","raise","rank","reach","read","recap","recommend","record","refer","reflect","refuse","reject","remember","remind","remove","repeat","reply","report","request","require","research","reserve","respond","restate","retry","review","revise","rewrite","rush",
  "save","say","schedule","search","see","seek","select","send","serve","set","share","shorten","show","sign","simplify","skip","sleep","speak","spell","split","start","state","stay","stop","structure","submit","suggest","summarize","support","surface",
  "take","talk","teach","tell","test","thank","think","track","translate","trust","try","turn","type","understand","update","use","verify","wait","warn","watch","wonder","work","write",
];

/** The light verbs dropped from a key before its value token is removed. */
export const LIGHT_VERBS = ["be","being"] as const;
