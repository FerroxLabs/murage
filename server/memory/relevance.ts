/** Optional evidence selection, not assertion confidence. Cosine bands are a
 * relative relevance heuristic: they cannot prove a fact or universal abstention.
 * Exact references and explicit event questions impose additional support checks.
 */
interface Candidate {text:string;similarity?:number;lexical?:boolean}
const stop=new Set("a an and are as at be been being by do does did for from had has have how i in into is it its many me must of on or our that the their them there these they this those to us was we were what when where which who why with you your".split(" "));
function words(text:string){return new Set((text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]).filter(word=>!stop.has(word)).map(word=>word.length>4&&word.endsWith("s")?word.slice(0,-1):word));}
function exactReferences(text:string){
  const matches=[...text.matchAll(/`([^`\n]+)`|\bhttps?:\/\/[^\s<>]+|\b[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)+\b|\b[A-Z][A-Z\d]*-\d+\b|(?:\/[\w.-]+){2,}/gu)];
  return [...new Set(matches.map(match=>(match[1]??match[0]).replace(/[.,;!?]+$/,"").normalize("NFKC").toLowerCase()))];
}
function containsReference(text:string,reference:string){
  const escaped=reference.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,"u").test(text.normalize("NFKC").toLowerCase());
}
const change=/\b(?:replac(?:e|ed|ement|ements|ing)|supersed(?:e|ed|es|ing)|chang(?:e|ed|es)|updat(?:e|ed|es)|amend(?:ed|ment|ments)|revis(?:ed|ion|ions)|switch(?:ed|es)|migrat(?:ed|ion)|overrid(?:e|den)|abolish(?:ed)?|repeal(?:ed)?)\b/i;
/** A scope overview is a bounded listing request, not a topical similarity
 * query. Recognize only topic-free forms; adding a subject keeps normal search.
 */
export function isMemoryOverviewQuery(query:string):boolean {
  const text=query.normalize("NFKC").trim().replace(/[?？.!。]+$/u, "").trim();
  return /^(?:(?:what (?:is|are)|show(?: me)?|list|recall|summarize) (?:the |our )?(?:current |active |workspace |project )*(?:polic(?:y|ies)|rules|constraints))$/i.test(text)
    || /^(?:นโยบาย|กฎ)(?:ปัจจุบัน)?(?:คืออะไร|มีอะไรบ้าง)$/u.test(text)
    || /^(?:目前|当前|现在)?的?(?:政策|规则)(?:是什么|有哪些)$/u.test(text);
}

function seeksDescribedChange(query:string){
  // Inspect the question, not a negated premise in an earlier sentence. A request
  // to make a change or explain how to make it is not a claim that it happened.
  const focus=query.split(/[.!?\n]+/).map(part=>part.trim()).filter(Boolean).at(-1)??query;
  if(!/^(?:what|which|when|who|where|how|has|have|was|were|did|does|is|are|show|find|list|recall|describe|tell me)\b/i.test(focus))return false;
  if(/\b(?:should|could|would|will|how to|how (?:do|can) (?:i|we))\b/i.test(focus))return false;
  // The subject of a rule can itself be a change operation (e.g. migration).
  if(/\b(?:current|existing) (?:rule|policy|requirement|procedure|constraint)s?\b/i.test(focus))return false;
  return change.test(focus);
}
function describesChange(text:string,query:string){
  const asksApprovedReplacement=/\b(?:approved|adopted) replacement\b/i.test(query);

  return text.split(/[.!?\n]+/).some(clause=>{
    if(!change.test(clause))return false;
    // A standing conditional rule about something changing is not evidence
    // that a replacement rule was adopted. Source denials still qualify.
    if(asksApprovedReplacement&&(!/\b(?:replac\w*|supersed\w*|new (?:rule|policy))\b/i.test(clause)||!/\b(?:approved|adopted|implemented|effective|rejected|denied)\b/i.test(clause)))return false;
    const prospective=/\b(?:will|would|might|could|should|plan|planned|proposal|proposed|intend|consider)\b/i.test(clause);
    // A source denying approval is still relevant evidence of absence. A real
    // approved replacement remains eligible despite a user's contrary premise.
    return !prospective||/\b(?:approved|adopted|implemented|effective|rejected|cancelled|denied)\b/i.test(clause);
  });
}

function absenceOnlySupport(query:string,text:string):boolean {
  // Audit annotations about missing policy/decision evidence do not answer a
  // procedural question. Preserve actual negative rules and explicit questions
  // asking whether a decision exists. Do not turn this into a truth score.
  const clauses=text.split(/[.!?\n]+/).map(clause=>clause.trim()).filter(Boolean);
  const absence=/^(?:no|neither)\b.*\b(?:policy|rule|decision|approval|agreement)\b.*\b(?:recorded|documented|made|defined|provided|available)\b/i;
  if(!clauses.some(clause=>absence.test(clause)))return false;
  if(/^(?:was|were|is|are|has|have|did)\b|\b(?:whether|any decision|any approval)\b/i.test(query.trim()))return false;
  const substantive=words(clauses.filter(clause=>!absence.test(clause)).join(" "));
  return ![...words(query)].some(word=>substantive.has(word));
}

export function selectMemoryEvidence<T extends Candidate>(query:string,candidates:T[]):T[]{
  const references=exactReferences(query),needsChange=seeksDescribedChange(query);
  const eligible=candidates.filter(candidate=>references.every(reference=>containsReference(candidate.text,reference))&&(!needsChange||describesChange(candidate.text,query))&&!absenceOnlySupport(query,candidate.text));
  if(!eligible.length)return [];
  if(isMemoryOverviewQuery(query))return eligible;
  const queryWords=words(query),documents=eligible.map(candidate=>words(candidate.text));
  const frequency=new Map<string,number>();
  for(const document of documents)for(const word of queryWords)if(document.has(word))frequency.set(word,(frequency.get(word)??0)+1);
  const similarities=eligible.map(candidate=>candidate.similarity).filter((value):value is number=>typeof value==="number"&&Number.isFinite(value)&&value>0);
  const best=similarities.length?Math.max(...similarities):0;
  return eligible.filter((candidate,index)=>{
    if(references.length)return true; // literal matches still respect scope and event support
    const matches=[...queryWords].filter(word=>documents[index].has(word));
    if(!best)return matches.length>0; // honest lexical fallback, no invented semantic score
    if(typeof candidate.similarity==="number"&&Number.isFinite(candidate.similarity)&&candidate.similarity>=best*0.8)return true;
    // Independent query facets can support several records even when their cosine
    // values differ. Common words shared by most candidates cannot rescue a weak
    // semantic match; there is no top-one cap or conversion from RRF to confidence.
    return matches.some(word=>(frequency.get(word)??0)<=Math.max(1,Math.floor(eligible.length/4)));
  });
}
