import { createHash } from "node:crypto";
import { createReadStream, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { chunksFor } from "./chunks.ts";
import { linkedInternalComponent, linkedPathComponent, modelSignature } from "../../shared/memory-model-verify.mjs";
import { loadNativeTransformers, loadWasmTransformers, nativeBindingShipped, pipelineOptions, wasmRuntimeAvailable, type MemoryBackend } from "./embedding-runtime.ts";

export interface ModelManifest {model:string;revision:string;dimensions:number;files:Array<{path:string;bytes:number;sha256:string}>}
/** The local model can run here: on the native ONNX binding, or on ONNX Runtime WebAssembly where the pinned binding
 * does not exist (Intel macOS) or fails to load. False only where neither is available, and then memory is keyword-only. */
export function supportsNativeMemoryModel(platform:NodeJS.Platform=process.platform,arch:string=process.arch,wasmAvailable:()=>boolean=wasmRuntimeAvailable){return nativeBindingShipped(platform,arch)||wasmAvailable();}
export type { MemoryBackend } from "./embedding-runtime.ts";
/** Qualification only (scripts/smoke-memory-packaged.mjs --backend wasm): run a real package's WebAssembly path on a
 * machine that also has the native binding. Not a setting: nothing in the app sets it, and any other value is ignored. */
const forcedBackend=()=>process.env.MURAGE_MEMORY_BACKEND==="wasm"?"wasm":undefined;
export class MemoryEmbeddings {
  private extractor: any;
  readonly identity: string;
  private directory: string;
  readonly manifest: ModelManifest;
  private fallbackDirectory?: string;
  private strictRoot: boolean;
  private requested: "auto"|MemoryBackend;
  private loaded?: MemoryBackend;
  private windowBatch: number;
  /** `backend` pins one executor (qualification and tests); `windowBatch` is how many model windows share one model call
   * (1 makes every window's vector independent of its batch neighbours, which the dynamically quantized model is not). */
  constructor(directory: string, manifest: ModelManifest, options: {fallbackDirectory?: string; strictRoot?: boolean; backend?: "auto"|MemoryBackend; windowBatch?: number} = {}){this.directory=directory;this.manifest=manifest;this.fallbackDirectory=options.fallbackDirectory;this.strictRoot=options.strictRoot===true;this.requested=options.backend??"auto";this.windowBatch=Math.min(16,Math.max(1,Math.floor(options.windowBatch??16)));this.identity=`${manifest.model}@${manifest.revision}`;}
  /** The executor the model runs on: the loaded one, or (before the first load) the one this platform will try first. */
  get backend():MemoryBackend{return this.loaded??(this.requested!=="auto"?this.requested:forcedBackend()==="wasm"||!nativeBindingShipped()?"wasm":"native");}
  /** True while a WebAssembly model is held in memory (its linear memory is only returned when the process ends). */
  get wasmResident():boolean{return this.extractor!==undefined&&this.loaded==="wasm";}
  /** Loads the first candidate that verifies and loads: the primary directory, then the fallback (the user's downloaded copy). */
  async load() {
    if(this.extractor)return;
    // One load at a time: a warm-up and a search that arrive together share it instead of building two models.
    this.loading??=this.loadOnce().finally(()=>{this.loading=undefined;});
    return this.loading;
  }
  private loading?: Promise<void>;
  /** Loads the model and runs one inference on a tiny input, so the first real query pays neither the load nor the first-run cost. */
  async warm(){await this.load();await this.embed(["warm"]);}
  private async loadOnce() {
    if(this.extractor)return;
    if(!supportsNativeMemoryModel())throw new Error("MEMORY_SEMANTIC_PLATFORM_UNAVAILABLE");
    let first: unknown;
    for(const [directory,strict] of [[this.directory,this.strictRoot],...(this.fallbackDirectory?[[this.fallbackDirectory,false]]:[])] as Array<[string,boolean]>){
      try{this.extractor=await this.loadFrom(directory,strict);return;}catch(error){first??=error;}
    }
    throw first;
  }
  /** Verify, load, then confirm the verified files were not replaced while loading (their identity, including ctime, is unchanged). */
  private async loadFrom(directory: string, strict: boolean) {
    if(strict&&await linkedPathComponent(directory))throw new Error("MEMORY_MODEL_UNVERIFIED");
    if(await linkedInternalComponent(directory,this.manifest))throw new Error("MEMORY_MODEL_UNVERIFIED");
    const before=modelSignature(directory,this.manifest);
    for(const file of this.manifest.files){
      const path=join(directory,file.path), stat=lstatSync(path);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==file.bytes)throw new Error("MEMORY_MODEL_UNVERIFIED");
      const hash=createHash("sha256");for await(const chunk of createReadStream(path))hash.update(chunk);
      if(hash.digest("hex")!==file.sha256)throw new Error("MEMORY_MODEL_UNVERIFIED");
    }
    if(!before||before!==modelSignature(directory,this.manifest))throw new Error("MEMORY_MODEL_UNVERIFIED");
    const extractor=await this.createExtractor(directory);
    if(before!==modelSignature(directory,this.manifest)){await extractor.dispose?.();throw new Error("MEMORY_MODEL_UNVERIFIED");}
    return extractor;
  }
  /** The verified files, through the native binding where it ships, and ONNX Runtime WebAssembly where it does not or
   * where it fails to load. The same pipeline, files, pooling and normalisation either way (embedding-runtime.ts). */
  private async createExtractor(directory: string) {
    const order:MemoryBackend[]=this.requested!=="auto"?[this.requested]:forcedBackend()==="wasm"||!nativeBindingShipped()?["wasm"]:["native","wasm"];
    let first: unknown;
    for(const backend of order){
      try{
        const {env,pipeline}=await (backend==="native"?loadNativeTransformers():loadWasmTransformers());
        env.allowRemoteModels=false;env.allowLocalModels=true;env.useFSCache=false;
        const extractor=await pipeline("feature-extraction",directory,pipelineOptions(backend));
        this.loaded=backend;return extractor;
      }catch(error){first??=error;if(backend==="native"&&order.length>1)console.error(`native memory runtime unavailable, using WebAssembly: ${error instanceof Error?error.message.slice(0,160):"unknown"}`);}
    }
    throw first;
  }
  async embed(texts: string[]): Promise<number[][]> {
    if(texts.length>16)throw new Error("MEMORY_EMBEDDING_BATCH_LIMIT");
    await this.load();
    // Conservative byte-bound subchunks fit the selected 128-token model window.
    // No truncation may silently discard the tail of a record or query.
    const parts=texts.map(text=>chunksFor(text,0,120).map(c=>c.text));
    const flat=parts.flat(),vectors:number[][]=[];
    for(let i=0;i<flat.length;i+=this.windowBatch){
      const output=await this.extractor(flat.slice(i,i+this.windowBatch),{pooling:"mean",normalize:true,truncation:false});
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
