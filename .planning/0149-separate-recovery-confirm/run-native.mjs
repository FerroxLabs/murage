import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
const require=createRequire(import.meta.url),scratch=mkdtempSync(path.join(tmpdir(),'murage-recovery-native-'));
const env={PATH:process.env.PATH,HOME:scratch,USERPROFILE:scratch,TMPDIR:scratch,MURAGE_RECOVERY_FIXTURE_DATA:scratch};
const child=spawn(require('electron'),[fileURLToPath(new URL('./native.mjs',import.meta.url))],{env,stdio:'inherit'});
const timer=setTimeout(()=>child.kill('SIGTERM'),135000);
try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0);const state=JSON.parse(readFileSync(new URL('./native-state.json',import.meta.url),'utf8'));assert.equal(state.stage,'PASS');console.log('Native recovery confirmation PASS (Cancel then explicit approval; fake archive/restore host)');}finally{clearTimeout(timer);safeWipeSync(scratch);}
