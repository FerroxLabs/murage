import { MemoryEligibility } from "./eligibility.ts";
import { captureWork } from "./chunks.ts";
import { workSchema,indexBatchSchema,searchInputSchema,type MemorySearchInput } from "./worker-protocol.ts";
import { MemoryIndex,type IndexedMemory } from "./index.ts";
import { MemoryEmbeddings,type ModelManifest } from "./embeddings.ts";

let index:MemoryIndex|null=null, embeddings:MemoryEmbeddings|null=null, eligibility:MemoryEligibility|null=null, busy=false;
const queries:Array<{requestId:string;input:MemorySearchInput;enqueuedAt:number}>=[];
const batches:Array<{requestId:string;records:IndexedMemory[]}>=[];
const cancelled=new Set<string>();
/** Index records embedded per model call: a waiting query is served between slices. */
const INDEX_SLICE=4;
/** A query whose deadline has passed has no one waiting: the parent already degraded the turn. */
const expired=(q:{input:MemorySearchInput})=>q.input.deadlineAt!==undefined&&Date.now()>=q.input.deadlineAt;
async function serveQueries(){
  const batch=queries.splice(0,16).filter(q=>!cancelled.delete(q.requestId)&&!expired(q));
  if(!batch.length)return;
  const batchStarted=performance.now();
  let vectors:number[][]|null=null,degradedReason:string|undefined;
  try {if(batch.some(q=>q.input.semantic))vectors=await embeddings!.embed(batch.map(q=>q.input.query));}
  catch{degradedReason="local-model-unavailable";}
  const embeddingMs=performance.now()-batchStarted;
  for(let i=0;i<batch.length;i++){
    const q=batch[i];if(cancelled.delete(q.requestId)||expired(q))continue;
    const eligibilityStarted=performance.now();
    const eligible=eligibility!.read(q.input);
    const eligibilityMs=performance.now()-eligibilityStarted;
    let result;
    try {result=index!.search(q.input.query,eligible.allowed,q.input.semantic&&!eligible.capacity?vectors?.[i]??null:null,embeddings!.identity,q.input.limit);}
    catch {result=index!.search(q.input.query,eligible.allowed,null,embeddings!.identity,q.input.limit);degradedReason="semantic-index-unavailable";}
    process.send?.({type:"query-result",requestId:q.requestId,result:{...result,workerPeakRssBytes:process.resourceUsage().maxRSS*1024,...q.input.profile?{profile:{queueMs:batchStarted-q.enqueuedAt,embeddingMs,batchSize:batch.length,eligibilityMs,...result.timings,workerTotalMs:performance.now()-q.enqueuedAt}}:{},coverageComplete:result.vectorRows===eligible.allowed.length,...degradedReason?{degradedReason}:{},...eligible.capacity?{degradedReason:"semantic-capacity-paged",nextCursor:eligible.nextCursor}:{}}});
  }
}
async function drain(){
  if(busy||!index||!embeddings||!eligibility)return;busy=true;
  let queryBatchServed=false;
  try {
    while(queries.length||batches.length){
      // Queries lead each drain. Sustained arrivals must still leave one slot
      // for a waiting index batch, then immediately return priority to queries.
      if(queries.length&&(!batches.length||!queryBatchServed)){
        await serveQueries();
        queryBatchServed=true;
      } else {
        const batch=batches.shift()!;index.upsert(batch.records);
        const alive=batch.records.filter(r=>!r.deleted&&!r.archived);let embeddingStatus="indexed";
        try {
          for(let at=0;at<alive.length;at+=INDEX_SLICE){
            const slice=alive.slice(at,at+INDEX_SLICE);
            const vectors=await embeddings.embed(slice.map(r=>r.text));slice.forEach((record,i)=>index!.vector(record,embeddings!.identity,0,vectors[i]));
            // a turn's search jumps ahead of the rest of this batch
            while(queries.length&&at+INDEX_SLICE<alive.length)await serveQueries();
          }
        }
        catch {embeddingStatus="unavailable";}
        eligibility.warm([...new Set(alive.map(record=>record.scopeId))]);
        process.send?.({type:"index-result",requestId:batch.requestId,embeddingStatus,records:batch.records.map(r=>({id:r.id,version:r.version,deleted:r.deleted}))});
        queryBatchServed=false;
      }
    }
  }catch{process.send?.({type:"index-error",reason:"MEMORY_INDEX_FAILED"});}
  finally{busy=false;}
}
process.on("message",input=>{
  try {
    const message=input as {type?:string;requestId?:string;input?:unknown;records?:unknown;indexPath?:string;modelDirectory?:string;manifest?:ModelManifest;authorityPath?:string};
    if(message.type==="init"){
      if(index||typeof message.indexPath!=="string"||typeof message.modelDirectory!=="string"||(!message.manifest||typeof message.authorityPath!=="string"))throw new Error("invalid initialization");
      eligibility=new MemoryEligibility(message.authorityPath!);index=new MemoryIndex(message.indexPath);
      // Owner-authored continuity is never part of the shared index: drop any an earlier build wrote.
      try{index.purgeRecords(eligibility.pipRecordIds());}catch{/* retried at the next open */}
      embeddings=new MemoryEmbeddings(message.modelDirectory,message.manifest);
      try{index.prepareModel(embeddings.identity);}catch{/* capacity remains an explicit lexical degradation */}
      process.send?.({type:"initialised",reset:index.rebuilt});return;
    }
    if(message.type==="cancel"&&message.requestId){cancelled.add(message.requestId);if(cancelled.size>128)cancelled.delete(cancelled.values().next().value!);return;}
    if(message.type==="query"&&message.requestId){if(queries.length>=64)throw new Error("queue full");queries.push({requestId:message.requestId,input:searchInputSchema.parse(message.input),enqueuedAt:performance.now()});void drain();return;}
    if(message.type==="index"&&message.requestId){if(batches.length>=2)throw new Error("index queue full");batches.push({requestId:message.requestId,records:indexBatchSchema.parse(message.records)});void drain();return;}
    process.send?.({type:"result",result:captureWork(workSchema.parse(input))});
  } catch {process.send?.({type:"error",reason:"INVALID_MEMORY_WORK"});}
});
process.on("disconnect",()=>{index?.close();eligibility?.close();process.exit(0);});
process.send?.({type:"ready"});
