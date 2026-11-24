// SPDX-License-Identifier: AGPL-3.0-or-later
/** One owned launch, constant state. A lower count is never a new process:
 * only the parent's next launch can establish a new generation. */
export class ChildIoReceipts {
  private sequence=0;
  private blocks=0;
  private bytes=0;
  final=false;
  negotiated=false;
  readonly generation:string;
  private readonly unknown:()=>void;
  constructor(generation:string,unknown:()=>void){this.generation=generation;this.unknown=unknown;}
  accept(message:Record<string,unknown>):{blocks:number;bytes:number;final:boolean}|null{
    if(message.generation!==this.generation)return null;
    this.negotiated=true;
    const integer=(n:unknown):n is number=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
    if(!integer(message.sequence)||message.sequence===0){this.unknown();return null;}
    if(message.sequence<=this.sequence)return null;
    if(this.final||!integer(message.fsWriteBlocks)||message.fsWriteBlocks>Math.floor(Number.MAX_SAFE_INTEGER/512)||!integer(message.ioBytes)
      ||message.fsWriteBlocks<this.blocks||message.ioBytes<this.bytes
      ||typeof message.known!=="boolean"||typeof message.final!=="boolean"){
      this.unknown();return null;
    }
    this.sequence=message.sequence;this.blocks=message.fsWriteBlocks;this.bytes=message.ioBytes;
    this.final=message.final;
    if(!message.known)this.unknown();
    return {blocks:this.blocks,bytes:this.bytes,final:this.final};
  }
  exit():void{if(!this.final)this.unknown();}
}


import type {ChildProcess} from "node:child_process";
// 1.0.20 winrelay2: the launch preload (io-child-bootstrap.js) and a packaged entry (job-launcher.js, index.js) each
// inline their own copy of this leaf. The hop's forward/seal check must consult the observer that actually launched
// the child, so the map is process-global; exact child identity and per-launch generation checks are unchanged.
const observedKey=Symbol.for("murage.io.observed-child-generations");
const observedGlobal=globalThis as typeof globalThis&{[observedKey]:WeakMap<ChildProcess,string>|undefined};
const observedGenerations=observedGlobal[observedKey]??=new WeakMap<ChildProcess,string>();
/** Only the launch observer can reserve this private metering message family. */
export function isObservedChildIoMessage(child:ChildProcess,raw:unknown):boolean {
 if(!raw||typeof raw!=="object")return false;
 const m=raw as Record<string,unknown>;
 return m.type==="io"&&m.ioProtocol===1&&m.generation===observedGenerations.get(child)&&observedGenerations.has(child);
}
export interface ChildIoReading {blocks:number;bytes:number;final:boolean}
// A packaged preload and its entry may each inline this leaf.
const childStateKey=Symbol.for("murage.io.child-receipts");
const childGlobal=globalThis as typeof globalThis&{[childStateKey]:{bytes:number;known:boolean;installed:boolean;pending:number;external:number}|undefined};
const childState=childGlobal[childStateKey]??= {bytes:0,known:true,installed:false,pending:0,external:0};
export const externalOwnedChildLaunches=()=>childState.external;
export const ownedChildIoBytes=()=>childState.bytes;
export const ownedChildIoKnown=()=>childState.known&&childState.pending===0;
export const childIoMeterInstalled=()=>childState.installed;
export function noteChildIoMeterInstalled():void{childState.installed=true;}
export function invalidateChildIo():void{childState.known=false;}
/** One independent process is charged as max(OS,native), then added to its
 * parent's counter. Retain its floor across exits and subsequent generations. */
export function observeChildIo(child:ChildProcess,generation:string,options:{onIo?:(reading:ChildIoReading)=>void;onIoUnknown?:()=>void;external?:boolean}={}):ChildIoReceipts {
 observedGenerations.set(child,generation);
 if(options.external)childState.external++;
 const unknown=()=>{invalidateChildIo();options.onIoUnknown?.();};
 const receipts=new ChildIoReceipts(generation,unknown);let charged=0,pending=true;
 childState.pending++;
 const negotiated=()=>{if(pending){pending=false;childState.pending--;}};
 child.on("message",raw=>{
  if(!raw||typeof raw!=="object")return;
  const message=raw as Record<string,unknown>;
  if(message.ioProtocol!==1||message.type!=="io")return;
  const receipt=receipts.accept(message);if(!receipt)return;
  negotiated();
  const total=Math.max(receipt.blocks*512,receipt.bytes);
  childState.bytes+=Math.max(0,total-charged);charged=total;
  if(!Number.isSafeInteger(childState.bytes))unknown();
  options.onIo?.(receipt);
  if(receipt.final)try{child.send({type:"io-final-ack",generation,sequence:message.sequence});}catch{unknown();}
 });
 child.once("exit",(code,signal)=>{negotiated();if(code!==0||signal!==null)unknown();receipts.exit();});
 child.once("error",()=>{negotiated();unknown();});
 return receipts;
}

export interface ChildIoSample {blocks:number;bytes:number;known:boolean}
export interface IoMessage extends ChildIoSample {type:"io";ioProtocol:1;generation:string;sequence:number;fsWriteBlocks:number;ioBytes:number;final:boolean}
/** The memory-helper wire protocol, shared by isolated scanners and other owned
 * Node children. The caller seals its writers BEFORE finish(), then waits at
 * most 500 ms for the acknowledgement matching this launch and final sequence. */
export class ChildIoReporter {
 private sequence=0;
 private finishing:Promise<void>|undefined;
 private ack:(()=>void)|undefined;
 private finalSequence=0;
 private finalSample:ChildIoSample|undefined;
 readonly generation:string;
 private readonly read:()=>ChildIoSample;
 private readonly send:(message:IoMessage)=>void;
 constructor(generation:string,read:()=>ChildIoSample,send:(message:IoMessage)=>void){this.generation=generation;this.read=read;this.send=send;}
 report(final=false):void {
  if(this.finalSequence)return;
  const sample=this.read(),sequence=++this.sequence;
  if(final){this.finalSequence=sequence;this.finalSample={...sample};}
  this.send({...sample,type:"io",ioProtocol:1,generation:this.generation,sequence,fsWriteBlocks:sample.blocks,ioBytes:sample.bytes,final});
 }
 accept(raw:unknown):void {
  if(!raw||typeof raw!=="object")return;
  const m=raw as Record<string,unknown>;
  if(m.type==="io-final-ack"&&m.generation===this.generation&&m.sequence===this.finalSequence)this.ack?.();
 }
 finish(seal:()=>void|Promise<void>=()=>{}):Promise<void> {
  return this.finishing??=this.sealedFinal(seal);
 }
 private async sealedFinal(seal:()=>void|Promise<void>):Promise<void>{
  await seal();
  await new Promise<void>(resolve=>{
   const timer=setTimeout(done,500);
   const self=this;
   function done(){clearTimeout(timer);self.ack=undefined;resolve();}
   this.ack=done;
   try{this.report(true);}catch{done();}
  });
  const sealed=this.finalSample;
  if(sealed){
   const after=this.read();
   if(after.blocks!==sealed.blocks||after.bytes!==sealed.bytes||(sealed.known&&!after.known))throw new Error("CHILD_IO_NOT_SEALED");
  }
 }
}

/** Entry shutdown paths call this after closing their writers. Keep the native
 * process.exit API intact: deferring it globally would let code after a fatal
 * exit keep running (notably a launcher's closed-stdin path). */
export const childFinishKey=Symbol.for("murage.io.finish-child");
type ChildFinishGlobal=typeof globalThis&{[childFinishKey]:(()=>Promise<void>)|undefined};
export function setChildIoFinisher(finish?:(()=>Promise<void>)):void{(globalThis as ChildFinishGlobal)[childFinishKey]=finish;}
export function exitWithChildIoReceipt(code?:number):Promise<never>;
export function exitWithChildIoReceipt(code:number,exit:(code:number)=>unknown):Promise<unknown>;
export async function exitWithChildIoReceipt(code=0,exit:(code:number)=>unknown=value=>process.exit(value)):Promise<unknown>{
 const finish=(globalThis as ChildFinishGlobal)[childFinishKey];
 if(code===0&&finish)try{await finish();}catch{return exit(1);}
 return exit(code);
}

/** Reserved acknowledgement family only in an instrumented owned process.
 * Application IPC listeners keep rejecting every unrelated frame. */
export function isOwnChildIoAcknowledgement(raw:unknown):boolean {
 if(!raw||typeof raw!=="object"||process.env.MURAGE_IO_CHILD!=="1"||!(globalThis as ChildFinishGlobal)[childFinishKey])return false;
 const m=raw as Record<string,unknown>;
 return m.type==="io-final-ack"&&m.generation===process.env.MURAGE_IO_GENERATION&&typeof m.sequence==="number"&&Number.isSafeInteger(m.sequence)&&m.sequence>0;
}
