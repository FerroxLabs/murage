// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { Worker } from 'node:worker_threads';
import { windowsHidePrelude } from '../../../shared/win-hide-child-process.mjs';
import type { SecurityRunOptions } from './windows-security-runner.ts';

// The worker owns one exact child. The caller remains synchronous so existing
// no-follow snapshots and publication checks keep their ordering. Only the
// interpreter is reused: every request executes the full security projection.
const WORKER=String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const board = new Int32Array(workerData.shared, 0, 4);
const bytes = new Uint8Array(workerData.shared, 16);
let child, pending, output = '', stderr = '', spawns = 0, unusable = false, closing = false;
function retire() { unusable = true; Atomics.store(board, 3, 1); }
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
function finish(request, status, value) {
  if (!request || pending !== request) return;
  clearTimeout(request.timer); pending = undefined;
  const data = Buffer.from(value);
  if (data.length > bytes.length) { status = 2; value = JSON.stringify({code:'ENOBUFS'}); }
  const encoded = Buffer.from(value); bytes.set(encoded);
  Atomics.store(board, 1, encoded.length); Atomics.store(board, 2, spawns);
  Atomics.store(board, 0, status); Atomics.notify(board, 0);
}
function fail(request, code) {
  if (pending !== request) return;
  const owned = child;
  if (!request) {
    retire();
    if (owned) { owned.once('exit', () => { if (child === owned) child = undefined; }); try { owned.kill(); } catch {} }
    return;
  }
  if (request.stopping) return;
  request.stopping = true;
  clearTimeout(request.timer);
  if (owned && owned.pid && owned.exitCode === null && owned.signalCode === null) {
    // Keep custody until this exact child exits. If termination is unconfirmed,
    // this session is permanently unusable, even if the child exits later.
    const stuck = setTimeout(() => { retire(); finish(request, 2, JSON.stringify({code:'EIO'})); }, 1000);
    owned.once('exit', () => {
      clearTimeout(stuck); if (child === owned) child = undefined;
      finish(request, 2, JSON.stringify({code}));
    });
    owned.stdin.destroy();
    try { owned.kill(); } catch { /* The custody timer permanently refuses reuse. */ }
  } else {
    child = undefined;
    finish(request, 2, JSON.stringify({code}));
  }
}
parentPort.on('message', request => {
  if (request.close) {
    closing = true;
    if (pending) { clearTimeout(pending.timer); pending = undefined; }
    const owned = child;
    const done = () => { if (child === owned) child = undefined; Atomics.store(board,0,3); Atomics.notify(board,0); parentPort.close(); };
    if (owned && owned.pid && owned.exitCode === null && owned.signalCode === null) {
      owned.once('exit',done); owned.stdin.destroy();
      try { owned.kill(); } catch { /* No acknowledgement without an exact exit. */ }
    } else done();
    return;
  }
  const token = 'MURAGE_SECURITY_' + randomBytes(16).toString('hex') + ':';
  const remaining = request.deadline - Date.now();
  const operation = { token, timer:undefined };
  pending = operation;
  operation.timer = setTimeout(() => fail(operation, 'ETIMEDOUT'), Math.max(1,remaining));
  if (unusable || closing) { finish(operation, 2, JSON.stringify({code:'EIO'})); return; }
  if (remaining <= 0) { fail(operation, 'ETIMEDOUT'); return; }
  if (!child) {
    output = ''; stderr = '';
    try {
      child = spawn(workerData.command, workerData.args, withHideInherit({env:request.env,windowsHide:true,stdio:['pipe','pipe','pipe']})); spawns++;
    } catch { fail(operation, 'EIO'); return; }
    const owned = child;
    owned.on('error', () => { if (child === owned) fail(pending, 'EIO'); });
    owned.on('exit', () => {
      if (child !== owned || closing || pending?.stopping) return;
      child = undefined;
      // A confirmed idle exit is safe to replace. A request in flight fails;
      // only an unconfirmed termination permanently poisons this session.
      if (pending) fail(pending, 'EPIPE');
    });
    owned.stdin.on('error', () => { if (child === owned) fail(pending, 'EPIPE'); });
    owned.stdout.setEncoding('utf8');
    owned.stdout.on('data', chunk => {
      if (child !== owned || closing || pending?.stopping) return;
      output += chunk;
      if (output.length > 64 * 1024 * 1024) { fail(pending, 'ENOBUFS'); return; }
      for (;;) {
        const end = output.indexOf('\n'); if (end < 0) break;
        const line = output.slice(0,end).replace(/\r$/, ''); output = output.slice(end+1);
        const active = pending;
        if (!active || !line.startsWith(active.token)) { if (line.trim()) { fail(pending, 'EPROTO'); return; } continue; }
        try {
          const frame = JSON.parse(line.slice(active.token.length));
          if (frame.ok !== true || typeof frame.output !== 'string') { fail(active, 'EACCES'); return; }
          finish(active, 1, frame.output);
        } catch { fail(active, 'EPROTO'); return; }
      }
    });
    owned.stderr.on('data', chunk => { if (child !== owned || closing) return; stderr += chunk; if (stderr.length > 1024 * 1024) fail(pending, 'ENOBUFS'); });
  }
  if (workerData.jsonProtocol) {
    child.stdin.write(JSON.stringify({...request,token}) + '\n'); return;
  }
  // Environment values are quoted data. The script is one of the application's
  // fixed ACL programs, never a file's contents, path, or user-supplied command.
  const names = ['MURAGE_SIGNAL_ROOTS','MURAGE_SIGNAL_PATHS','MURAGE_SIGNAL_POINT','MURAGE_SIGNAL_TREE','MURAGE_SIGNAL_TREES','MURAGE_SIGNAL_NEW','MURAGE_SIGNAL_SID','MURAGE_SIGNAL_DIRS'];
  // PowerShell 5.1 reads piped commands in its system code page. Keep the
  // command ASCII, then decode each JSON string to restore the UTF-16 value.
  const data = value => quote(JSON.stringify(String(value)).replace(/[^\x00-\x7f]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4,'0')));
  const assignments = names.map(name => '$env:' + name + ' = ' + (request.env[name] === undefined ? '$null' : '(' + data(request.env[name]) + ' | ConvertFrom-Json)')).join('\n');
  const script = "& {\ntry {\n$ErrorActionPreference = 'Stop'\n" + assignments + "\n$lines = @( & {\n" + request.input + "\n} )\n$frame = @{ ok = $true; output = ($lines -join \"\n\") }\n} catch { $frame = @{ ok = $false; output = '' } }\n" + quote(token) + " + ($frame | ConvertTo-Json -Compress -Depth 4)\n}\n\n";
  child.stdin.write(script);
});
`;

export interface WindowsSecuritySessionOptions {
  command:string; args:readonly string[];
  /** A disposable helper can implement the same framed protocol in OS stubs. */
  jsonProtocol?:boolean;
  /** Injectable child lifecycle adapter for disposable helper regressions. */
  workerPrelude?:string;
}
export class WindowsSecuritySession {
  private readonly shared=new SharedArrayBuffer(16+32*1024*1024);
  private readonly board=new Int32Array(this.shared,0,4);
  private readonly bytes=new Uint8Array(this.shared,16);
  private worker:Worker|undefined;
  private unusable=false;
  private readonly options:WindowsSecuritySessionOptions;
  readonly debug={spawns:0,requests:0};
  constructor(options:WindowsSecuritySessionOptions){this.options=options;}
  /** A retired worker may be closed after late exit, but is never reused. */
  get retired():boolean {return this.unusable||Atomics.load(this.board,3)===1;}
  run(options:SecurityRunOptions):string {
    if(this.unusable)throw Object.assign(new Error('Windows security session is closed'),{code:'EIO'});
    if(!Number.isFinite(options.timeout)||options.timeout<=0)throw Object.assign(new Error('Security deadline expired'),{code:'ETIMEDOUT'});
    if(!this.worker){
      this.worker=new Worker(windowsHidePrelude+(this.options.workerPrelude??'')+WORKER,{eval:true,workerData:{...this.options,shared:this.shared}});
      this.worker.on('error',()=>{this.unusable=true;});this.worker.unref();
    }
    this.debug.requests++;Atomics.store(this.board,0,0);
    this.worker.postMessage({input:options.input??'',env:options.env,timeout:options.timeout,deadline:Date.now()+options.timeout});
    // Include worker startup in the existing request budget. The worker also
    // kills its child on expiry; never retry while that request can still write.
    const result=Atomics.wait(this.board,0,0,options.timeout+2000);
    if(result==='timed-out'){
      this.unusable=true;this.close();throw Object.assign(new Error('Security worker unresponsive'),{code:'EIO'});
    }
    this.debug.spawns=Atomics.load(this.board,2);
    const output=Buffer.from(this.bytes.subarray(0,Atomics.load(this.board,1))).toString('utf8');
    if(Atomics.load(this.board,0)!==1){const error=JSON.parse(output) as {code:string};throw Object.assign(new Error('Windows security request failed'),error);}
    return output;
  }
  close():boolean {
    this.unusable=true;
    if(!this.worker)return true;
    Atomics.store(this.board,0,0);this.worker.postMessage({close:true});
    Atomics.wait(this.board,0,0,2000);
    if(Atomics.load(this.board,0)!==3)return false;
    this.worker=undefined;return true;
  }
}

let native:WindowsSecuritySession|undefined,nativeCommand:string|undefined;
const nativeTotals={spawns:0,requests:0};
const reusableScripts=new Set<string>();
const sessionRunners=new WeakSet<object>();
const sessionSpawnCounters=new WeakMap<object,()=>number>();
export function markWindowsSecuritySessionRunner(run:object,spawns?:()=>number):void {sessionRunners.add(run);if(spawns)sessionSpawnCounters.set(run,spawns);}
export function windowsSecurityRunnerSpawns(run:object):number|undefined {return sessionSpawnCounters.get(run)?.();}
export function isWindowsSecuritySessionRunner(run:object):boolean {return sessionRunners.has(run);}
export function registerWindowsSecurityScript(script:string):void {reusableScripts.add(script);}
export function isReusableWindowsSecurityScript(script:string|undefined):boolean {return script!==undefined&&reusableScripts.has(script);}
/** Cache the process, never ACL/identity evidence or a failed verdict. */
export function runWindowsSecuritySession(command:string,args:readonly string[],options:SecurityRunOptions):string {
  const key=JSON.stringify([command,args]);
  if(nativeCommand!==key||native?.retired){if(native&&!native.close())throw Object.assign(new Error('Windows security shutdown is unconfirmed'),{code:'EIO'});native=new WindowsSecuritySession({command,args});nativeCommand=key;}
  const before=native!.debug.spawns;nativeTotals.requests++;
  try{return native!.run(options);}finally{nativeTotals.spawns+=native!.debug.spawns-before;}
}
export function closeWindowsSecuritySession():boolean {
  if(native&&!native.close())return false;
  native=undefined;nativeCommand=undefined;return true;
}
export function windowsSecuritySessionDebug(){return {...nativeTotals};}
process.once('exit',()=>closeWindowsSecuritySession());
