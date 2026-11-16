// SPDX-License-Identifier: AGPL-3.0-or-later
import nativeFs from "node:fs/promises";
const rawFsKey=Symbol.for("murage.io.raw-fs-promises");
const rawFsGlobal=globalThis as typeof globalThis&{[rawFsKey]:typeof nativeFs|undefined};
const fs=rawFsGlobal[rawFsKey]??= {...nativeFs};
import type { FileHandle } from "node:fs/promises";
import { installCopyMeter, ioMeterActive, markIoMeterUnknown, noteIoMeterBytes } from "./io-meter.ts";
export * from "node:fs/promises";
export function validateWriteData(data:unknown,options:unknown):void {
 const iterable=data!==null&&typeof data==="object"&&(typeof (data as Iterable<unknown>)[Symbol.iterator]==="function"||typeof (data as AsyncIterable<unknown>)[Symbol.asyncIterator]==="function");
 if(typeof data!=="string"&&!ArrayBuffer.isView(data)&&!iterable)throw Object.assign(new TypeError("data must be a string, typed array or iterable"),{code:"ERR_INVALID_ARG_TYPE"});
 if(options!==undefined&&options!==null&&typeof options!=="string"&&typeof options!=="object")throw Object.assign(new TypeError("options must be an object or encoding"),{code:"ERR_INVALID_ARG_TYPE"});
 const encoding=typeof options==="string"?options:(options as {encoding?:unknown}|null)?.encoding;
 if(encoding!==undefined&&encoding!==null&&(typeof encoding!=="string"||!Buffer.isEncoding(encoding)))throw Object.assign(new TypeError("unknown encoding"),{code:"ERR_INVALID_ARG_VALUE"});
 const flush=(options as {flush?:unknown}|null)?.flush;
 if(flush!==undefined&&typeof flush!=="boolean")throw Object.assign(new TypeError("flush must be a boolean"),{code:"ERR_INVALID_ARG_TYPE"});
 const signal=(options as {signal?:unknown}|null)?.signal;
 if(signal!==undefined&&signal!==null&&!(signal instanceof AbortSignal))throw Object.assign(new TypeError("signal must be an AbortSignal"),{code:"ERR_INVALID_ARG_TYPE"});
}
const wrapped=new WeakMap<FileHandle,FileHandle>();
const bytes=(data:string|{buffer:ArrayBufferLike;byteOffset:number;byteLength:number},encoding:BufferEncoding="utf8")=>typeof data==="string"?Buffer.from(data,encoding):Buffer.from(data.buffer,data.byteOffset,data.byteLength);
function wrap(handle:FileHandle):FileHandle {
 const prior=wrapped.get(handle);if(prior)return prior;
 const record=async(n:number)=>{try{if((await handle.stat()).isFile())noteIoMeterBytes("ordinary-files",n);}catch{markIoMeterUnknown();}};
 const write=async(...args:unknown[])=>{
  try{const result=await Reflect.apply(handle.write,handle,args) as {bytesWritten:number};await record(result.bytesWritten);return result;}
  catch(error){markIoMeterUnknown();throw error;}
 };
 const writev=async(...args:unknown[])=>{
  try{const result=await Reflect.apply(handle.writev,handle,args) as {bytesWritten:number};await record(result.bytesWritten);return result;}
  catch(error){markIoMeterUnknown();throw error;}
 };
 const writeFile=async(data:unknown,options?:{encoding?:BufferEncoding|null;signal?:AbortSignal}|BufferEncoding|null)=>{
  validateWriteData(data,options);
  const opts=typeof options==="string"?{encoding:options}:options??{};
  const chunks=typeof data==="string"||ArrayBuffer.isView(data)?[data]:data as AsyncIterable<string|NodeJS.ArrayBufferView>|Iterable<string|NodeJS.ArrayBufferView>;
  for await(const chunk of chunks){
   const b=bytes(chunk,opts.encoding??"utf8");let at=0;
   while(at<b.length){
    if(opts.signal?.aborted)throw Object.assign(new Error("The operation was aborted"),{name:"AbortError",code:"ABORT_ERR"});
    const result=await write(b,at,b.length-at,null);if(result.bytesWritten===0){markIoMeterUnknown();throw new Error("disk write made no progress");}at+=result.bytesWritten;
   }
  }
 };
 const proxy=new Proxy(handle,{get(target,key){
  if(key==="write")return write;if(key==="writev")return writev;
  if(key==="writeFile"||key==="appendFile")return writeFile;
  if(key==="createWriteStream")return (...args:unknown[])=>{
   const stream=Reflect.apply(target.createWriteStream,target,args) as import("node:fs").WriteStream;
   const original=stream._write.bind(stream),originalV=stream._writev?.bind(stream);
   stream._write=(chunk,encoding,cb)=>original(chunk,encoding,async error=>{if(error)markIoMeterUnknown();else await record(Buffer.byteLength(chunk,encoding));cb(error);});
   if(originalV)stream._writev=(chunks,cb)=>originalV(chunks,async error=>{if(error)markIoMeterUnknown();else await record(chunks.reduce((n,c)=>n+Buffer.byteLength(c.chunk,c.encoding),0));cb(error);});
   return stream;
  };
  const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
 }});
 wrapped.set(handle,proxy);wrapped.set(proxy,proxy);return proxy;
}
export const open:typeof fs.open=(async(...args:Parameters<typeof fs.open>)=>ioMeterActive()?wrap(await fs.open(...args)):await fs.open(...args)) as typeof fs.open;
export const writeFile:typeof fs.writeFile=(async(path:Parameters<typeof fs.writeFile>[0],data:Parameters<typeof fs.writeFile>[1],options?:Parameters<typeof fs.writeFile>[2])=>{
 if(!ioMeterActive())return fs.writeFile(path,data,options);
 validateWriteData(data,options);
 const opts=typeof options==="string"?{encoding:options}:options??{};
 if(opts.signal?.aborted)throw Object.assign(new Error("The operation was aborted"),{name:"AbortError",code:"ABORT_ERR"});
 const owned=!(path&&typeof path==="object"&&"fd" in path),handle=owned?await open(path as string,opts.flag??"w",opts.mode):wrap(path as FileHandle);
 try{await handle.writeFile(data,opts);if(opts.flush)await handle.sync();}finally{if(owned)await handle.close();}
}) as typeof fs.writeFile;
export const appendFile:typeof fs.appendFile=(async(path:Parameters<typeof fs.appendFile>[0],data:Parameters<typeof fs.appendFile>[1],options?:Parameters<typeof fs.appendFile>[2])=>{
 if(!ioMeterActive())return fs.appendFile(path,data,options);
 validateWriteData(data,options);
 const opts=typeof options==="string"?{encoding:options}:options??{};
 await writeFile(path,data,{...opts,flag:opts.flag??"a"});
}) as typeof fs.appendFile;
export const copyFile:typeof fs.copyFile=(...args)=>{installCopyMeter();return nativeFs.copyFile(...args);};
export const cp:typeof fs.cp=(...args)=>{installCopyMeter();return nativeFs.cp(...args);};
export default {...fs,open,writeFile,appendFile,copyFile,cp};
