import { createHash } from "node:crypto";
import { createReadStream, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { chunksFor } from "./chunks.ts";

export interface ModelManifest {model:string;revision:string;dimensions:number;files:Array<{path:string;bytes:number;sha256:string}>}
/** The pinned native ONNX package has no Intel macOS binding. */
export function supportsNativeMemoryModel(platform:NodeJS.Platform=process.platform,arch:string=process.arch){return !(platform==="darwin"&&arch==="x64");}
export class MemoryEmbeddings {
  private extractor: any;
  readonly identity: string;
  private directory: string;
  readonly manifest: ModelManifest;
  constructor(directory: string, manifest: ModelManifest){this.directory=directory;this.manifest=manifest;this.identity=`${manifest.model}@${manifest.revision}`;}
  async load() {
    if(!supportsNativeMemoryModel())throw new Error("MEMORY_SEMANTIC_PLATFORM_UNAVAILABLE");
    if(this.extractor)return;
    for(const file of this.manifest.files){
      const path=join(this.directory,file.path), stat=lstatSync(path);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==file.bytes)throw new Error("MEMORY_MODEL_UNVERIFIED");
      const hash=createHash("sha256");for await(const chunk of createReadStream(path))hash.update(chunk);
      if(hash.digest("hex")!==file.sha256)throw new Error("MEMORY_MODEL_UNVERIFIED");
    }
    const {env,pipeline}=await import("@huggingface/transformers");
    env.allowRemoteModels=false;env.allowLocalModels=true;env.useFSCache=false;
    this.extractor=await pipeline("feature-extraction",this.directory,{dtype:"q8",device:"cpu",local_files_only:true});
  }
  async embed(texts: string[]): Promise<number[][]> {
    if(texts.length>16)throw new Error("MEMORY_EMBEDDING_BATCH_LIMIT");
    await this.load();
    // Conservative byte-bound subchunks fit the selected 128-token model window.
    // No truncation may silently discard the tail of a record or query.
    const parts=texts.map(text=>chunksFor(text,0,120).map(c=>c.text));
    const flat=parts.flat(),vectors:number[][]=[];
    for(let i=0;i<flat.length;i+=16){
      const output=await this.extractor(flat.slice(i,i+16),{pooling:"mean",normalize:true,truncation:false});
      vectors.push(...output.tolist());
    }
    let cursor=0;
    return parts.map(group=>{
      const average=new Array<number>(this.manifest.dimensions).fill(0);
      for(let n=0;n<group.length;n++){const v=vectors[cursor++];if(v.length!==average.length)throw new Error("MEMORY_VECTOR_DIMENSION_MISMATCH");for(let j=0;j<v.length;j++)average[j]+=v[j];}
      const norm=Math.sqrt(average.reduce((sum,n)=>sum+n*n,0));
      if(!norm||!Number.isFinite(norm))throw new Error("INVALID_MEMORY_EMBEDDING");
      return average.map(n=>n/norm);
    });
  }
  async close(){await this.extractor?.dispose();this.extractor=undefined;}
}
export function readModelManifest(path:string):ModelManifest{return JSON.parse(readFileSync(path,"utf8"));}
