import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { checkSourceShell, shellViolations } from '../scripts/check-os-shell.mjs';
import { createOsShell } from './os-shell.mjs';
const fixture = () => {
 const calls = [];
 const shell = createOsShell({openExternal: async v => {calls.push(v);}, openPath: async v => {calls.push(v);return '';},showItemInFolder: v => calls.push(v)}, {PATHEXT: '.EXE;.CIEXEC'});
 return {calls,shell};
};
test('OS shell refuses executable/script associations including .bat and PATHEXT',async()=>{
 for(const ext of ['exe','com','bat','cmd','ps1','psm1','vbs','vbe','js','jse','wsf','wsh','msi','msc','scr','lnk','url','hta','cpl','ciexec']) {
  for(const stem of ['sample','']) for(const suffix of [`.${ext}`,`.${ext.toUpperCase()} `,`.${ext}.`,`.${ext}:stream`]) {
   const {shell,calls}=fixture(); assert.match(await shell.openPath(`C:\\files\\${stem}${suffix}`),/cannot open.*(?:program|script)/i);assert.deepEqual(calls,[]);
  }
 }
 const {shell,calls}=fixture();assert.equal(await shell.openPath('C:\\files\\readme.pdf'),'');assert.equal(calls.length,1);
});
test('OS shell opens https, http, mailto and refuses javascript: and file:',async()=>{
 for(const url of ['https://example.test/path','http://example.test','mailto:help@example.test']) {
  const {shell,calls}=fixture(); await shell.openExternal(url);assert.deepEqual(calls,[new URL(url).href]);
 }
 for(const url of ['javascript:alert(1)','file:///C:/payload.bat','data:text/html,x','x-apple.systempreferences:test','invalid']) {
  const {shell,calls}=fixture();await assert.rejects(shell.openExternal(url),/Only http, https and mailto/);assert.deepEqual(calls,[]);
 }
});
test('only the OS shell wrapper owns shell launch routes in every shipped source',()=>{
 const result = checkSourceShell(fileURLToPath(new URL('../', import.meta.url)));
 assert.ok(result.files.includes('electron/vendor/electron-updater.cjs'));
 assert.ok(result.files.includes('electron/preload.cjs'));
 assert.deepEqual(result.failures, []);
 console.log(`OS shell source inventory: ${result.files.length} files`);
});
test('mutant RED: raw Electron shell access and aliases outside the wrapper',()=>{
 for (const source of [
  "shell.openPath('C:/payload.bat');",
  'require("electron").shell.openPath(installerPath)',
  'require("electron")["shell"]["openPath"](installerPath)',
  'const {shell:s}=require("electron"); s.openPath(installerPath)',
  'const e=require("electron"); e.shell.openPath(installerPath)',
  'import {shell as s} from "electron"; s.openPath(installerPath)',
  'export {shell} from "electron";',
 ]) assert.ok(shellViolations(source,'electron/vendor/mutant.cjs').length,source);
});
