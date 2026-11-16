// SPDX-License-Identifier: AGPL-3.0-or-later
// Same Node signatures and results. Count returned write lengths immediately;
// errors with unobservable partial progress mark the reading unknown.
import nativeFs from "node:fs";
// Separate esbuild entry bundles share the pristine methods with the preload.
// Capturing a preloaded counted method here would charge routed writes twice.
const rawFsKey=Symbol.for("murage.io.raw-fs");
const rawFsGlobal=globalThis as typeof globalThis&{[rawFsKey]:typeof nativeFs|undefined};
const fs=rawFsGlobal[rawFsKey]??= {...nativeFs};
import * as countedPromises from "./counted-fs-promises.ts";
import {writeFile as promiseWriteFile,appendFile as promiseAppendFile,cp as promiseCp,validateWriteData} from "./counted-fs-promises.ts";
import { installCopyMeter, admitPlainWrite, ioMeterActive, markIoMeterUnknown, noteIoMeterBytes } from "./io-meter.ts";
export * from "node:fs";
const file=(fd:number)=>{try{return fs.fstatSync(fd).isFile();}catch{return false;}};
const note=(fd:number,n:number)=>{if(ioMeterActive()&&file(fd))noteIoMeterBytes("ordinary-files",n);};
export const writeSync:typeof fs.writeSync=((...args:unknown[])=>{
 if(file(args[0] as number)){
  const data=args[1];
  const length=typeof data==="string"?Buffer.byteLength(data,typeof args[3]==="string"?args[3] as BufferEncoding:undefined):typeof args[3]==="number"?args[3]:(data as Uint8Array).byteLength;
  admitPlainWrite(Number(length),typeof args[4]==="number"?args[4]:typeof data==="string"&&typeof args[2]==="number"?args[2]:0);
 }
 try{const n=Reflect.apply(fs.writeSync,fs,args) as number;note(args[0] as number,n);return n;}
 catch(error){if(file(args[0] as number))markIoMeterUnknown();throw error;}
}) as typeof fs.writeSync;
export const write:typeof fs.write=((...args:unknown[])=>{
 if(!ioMeterActive()||typeof args.at(-1)!=="function")return Reflect.apply(fs.write,fs,args);
 const callback=args.pop() as (...args:unknown[])=>void,fd=args[0] as number;
 return Reflect.apply(fs.write,fs,[...args,(error:unknown,n:number,...rest:unknown[])=>{
  if(n>0)note(fd,n);if(error&&file(fd))markIoMeterUnknown();callback(error,n,...rest);
 }]);
}) as typeof fs.write;
export const writevSync:typeof fs.writevSync=((...args:unknown[])=>{
 try{const n=Reflect.apply(fs.writevSync,fs,args) as number;note(args[0] as number,n);return n;}
 catch(error){if(file(args[0] as number))markIoMeterUnknown();throw error;}
}) as typeof fs.writevSync;
export const writev:typeof fs.writev=((...args:unknown[])=>{
 if(!ioMeterActive()||typeof args.at(-1)!=="function")return Reflect.apply(fs.writev,fs,args);
 const callback=args.pop() as (...args:unknown[])=>void,fd=args[0] as number;
 return Reflect.apply(fs.writev,fs,[...args,(error:unknown,n:number,...rest:unknown[])=>{
  if(n>0)note(fd,n);if(error&&file(fd))markIoMeterUnknown();callback(error,n,...rest);
 }]);
}) as typeof fs.writev;
// writeFile uses its own bounded write loop so every successful partial write
// is counted even if a later write fails. Node still validates path/flags/mode.
export const writeFileSync:typeof fs.writeFileSync=((path:nativeFs.PathOrFileDescriptor,data:string|NodeJS.ArrayBufferView,options?:nativeFs.WriteFileOptions)=>{
 if(!ioMeterActive())return fs.writeFileSync(path,data,options);
 validateWriteData(data,options);
 const opts=typeof options==="string"?{encoding:options}:options??{};
 const bytes=typeof data==="string"?Buffer.from(data,opts.encoding??"utf8"):Buffer.from(data.buffer,data.byteOffset,data.byteLength);
 // Keep the descriptor API's operation and failure semantics (durability
 // callers may instrument writeFileSync itself). A successful complete write
 // receipts exactly this buffer; an unobservable partial failure stays unknown.
 if(typeof path==="number"){
  if(file(path))admitPlainWrite(bytes.length);
  try{fs.writeFileSync(path,data,options);note(path,bytes.length);}
  catch(error){if(file(path))markIoMeterUnknown();throw error;}
  return;
 }
 const fd=fs.openSync(path,opts.flag??"w",opts.mode);
 try{
  let at=0;while(at<bytes.length){const n=writeSync(fd,bytes,at,bytes.length-at);if(n===0){markIoMeterUnknown();throw new Error("disk write made no progress");}at+=n;}
  if(opts.flush)fs.fsyncSync(fd);
 }finally{fs.closeSync(fd);}
}) as typeof fs.writeFileSync;
export const appendFileSync:typeof fs.appendFileSync=((path:nativeFs.PathOrFileDescriptor,data:string|Uint8Array,options?:nativeFs.WriteFileOptions)=>{
 if(!ioMeterActive())return fs.appendFileSync(path,data,options);
 const opts=typeof options==="string"?{encoding:options}:options??{};
 return writeFileSync(path,data,{...opts,flag:opts.flag??"a"});
}) as typeof fs.appendFileSync;
export const createWriteStream:typeof fs.createWriteStream=((path:nativeFs.PathLike,options?:Parameters<typeof fs.createWriteStream>[1])=>{
 if(!ioMeterActive())return fs.createWriteStream(path,options);
 const opts=typeof options==="string"?{encoding:options}:options??{};
 // Respect an explicitly supplied filesystem adapter; wrap its real results.
 const original=opts.fs;
 const countWrite=(method:Function)=>(...args:unknown[])=>{
  const cb=args.pop() as (...args:unknown[])=>void,fd=args[0] as number;
  return Reflect.apply(method,original??fs,[...args,(error:unknown,n:number,...rest:unknown[])=>{if(n>0)note(fd,n);if(error&&file(fd))markIoMeterUnknown();cb(error,n,...rest);}]);
 };
 return fs.createWriteStream(path,{...opts,fs:{open:original?.open??fs.open,close:original?.close??fs.close,write:countWrite(original?.write??fs.write),writev:countWrite(original?.writev??fs.writev)}});
}) as typeof fs.createWriteStream;
export const copyFileSync:typeof fs.copyFileSync=(...args)=>{installCopyMeter();return nativeFs.copyFileSync(...args);};
export const copyFile:typeof fs.copyFile=((...args:unknown[])=>{installCopyMeter();return Reflect.apply(nativeFs.copyFile,nativeFs,args);}) as typeof fs.copyFile;
// The promise implementation owns file handles and low-level write loops too.
export const writeFile:typeof fs.writeFile=((...args:unknown[])=>{
 if(!ioMeterActive())return Reflect.apply(fs.writeFile,fs,args);
 validateWriteData(args[1],args.length>3?args[2]:undefined);
 const cb=args.pop();if(typeof cb!=="function")throw new TypeError("callback must be a function");
 void Reflect.apply(promiseWriteFile,undefined,args).then(()=>cb(null),(error:unknown)=>cb(error));
}) as typeof fs.writeFile;
export const appendFile:typeof fs.appendFile=((...args:unknown[])=>{
 if(!ioMeterActive())return Reflect.apply(fs.appendFile,fs,args);
 validateWriteData(args[1],args.length>3?args[2]:undefined);
 const cb=args.pop();if(typeof cb!=="function")throw new TypeError("callback must be a function");
 void Reflect.apply(promiseAppendFile,undefined,args).then(()=>cb(null),(error:unknown)=>cb(error));
}) as typeof fs.appendFile;
export const cpSync:typeof fs.cpSync=(...args)=>{installCopyMeter();return nativeFs.cpSync(...args);};
export const cp:typeof fs.cp=((...args:unknown[])=>{
 const cb=args.pop();if(typeof cb!=="function")throw new TypeError("callback must be a function");
 void Reflect.apply(promiseCp,undefined,args).then(()=>cb(null),(error:unknown)=>cb(error));
}) as typeof fs.cp;
export * as promises from "./counted-fs-promises.ts";
export default {...fs,writeSync,write,writevSync,writev,writeFileSync,appendFileSync,writeFile,appendFile,createWriteStream,copyFileSync,copyFile,cpSync,cp,promises:countedPromises};
