// Sean 2026-11-12 02:05Z: protected findings are evidence; admitted No limits permits these non-wipe writes.
import { describe, expect, it } from 'vitest';
import { autoVerdict } from './auto-approve.ts';
import { noLimitsProtectedWrite } from './no-limits-protected.ts';
import { inspectNoLimits } from './no-limits-taint.ts';
import type { NoLimitsDisk } from './no-limits-fs.ts';
const bot = { id: 'bc', autoApprove: true, fullAccess: true, noLimits: true };
const owner = { fullAccessOrigin: 'owner' as const, ownerStarted: true, commandCwd: '/w', outsideRead: null };

describe('No limits operation-aware protected paths', () => {
  it.each([
    'ln -s /usr/bin ./x && cp ./tool ./x/evil',
    'ln -s /etc/cron.d ./x && cp ./blob ./x/pwn',
    `ruby -i -e 'puts "x"' /etc/cron.d/pwn`,
    `gawk -i inplace '1' /etc/cron.d/pwn`,
    'touch ~/"$X"',
    `python3 -c 'open("/et"+"c/cron.d/pwn","w").write("x")'`,
  ])('D non-wipe protected operation runs: %s', command => {
    expect(noLimitsProtectedWrite(command, owner)).not.toBeNull();
    expect(autoVerdict(bot, 'Bash', command, { ...owner, commandText: command })).toMatchObject({ approve: expect.any(String), source: 'no-limits' });
  });
  it.each([`ruby -e 'puts "x"' /etc/cron.d/pwn`, `gawk -i extension '1' /etc/cron.d/pwn`])('D read operands stay reads: %s', command => {
    expect(noLimitsProtectedWrite(command, owner)).toBeNull();
  });
  it.each(['cat ~/"$X"', `python3 -c 'open("/et"+"c/cron.d/pwn").read()'`])('D unread or concatenated read stays a read: %s', command => {
    expect(noLimitsProtectedWrite(command, owner)).toBeNull();
  });
  it('D protected suffix survives a literal Bash launcher', () => {
    const command = `bash -c 'echo ok'; Add-Content ~/.kube/"config" x`;
    expect(noLimitsProtectedWrite(command, owner, 'pwsh', true)).not.toBeNull();
    expect(autoVerdict(bot, 'PowerShell', command, { ...owner, commandText: command }).approve).toBeTruthy();
  });
  it('D printed suffix remains data after a literal Bash launcher', () => {
    expect(noLimitsProtectedWrite(`bash -c 'echo ok'; Write-Output 'Add-Content ~/.kube/config x'`, owner, 'pwsh', true)).toBeNull();
  });
  it.each(['git -C ~ status', 'bash /etc/tool.sh', 'ls ~ > /tmp/list', 'awk -F/ "{print}" list.txt', 'docker run -v /etc:/host:ro img'])( 'B read or execution runs: %s', command => {
    expect(autoVerdict(bot, 'Bash', command, { ...owner, commandText: command }).approve).toBeTruthy();
  });
  // r3: protected/unknown producer operands taint the operation's own name.
  it.each(['ln -s /etc ./etc-link', 'rsync -a /etc/hosts /w/out'])('B non-wipe producer runs: %s',command=>{
    expect(autoVerdict(bot,'Bash',command,{...owner,commandText:command})).toMatchObject({approve:expect.any(String),source:'no-limits'});
  });
  it.each(['ln -s ./data ./etc-link','rsync -a ./src/ ./out'])('B ordinary producer twin runs: %s',command=>{
    expect(autoVerdict(bot,'Bash',command,{...owner,commandText:command}).approve).toBeTruthy();
  });
  it.each(['touch /etc/x', 'printf x > /etc/x', 'cp blob /etc/x', 'ln -s blob /etc/x', 'sort -o/etc/x list.txt', 'docker run -v /etc:/host img'])( 'B non-wipe protected write runs: %s', command => {
    expect(autoVerdict(bot, 'Bash', command, { ...owner, commandText: command })).toMatchObject({ approve: expect.any(String), source: 'no-limits' });
  });
  it('a printed write expression is data', () => {
    expect(noLimitsProtectedWrite(`echo 'open("/etc/x","w").write("x")'`, owner, undefined, true)).toBeNull();
  });
  it('does not enumerate prior session files', () => {
    let reads = 0;
    const edits = new Set(['/w/current.py']);
    Object.defineProperty(edits, Symbol.iterator, { value: () => { throw Error('history enumerated'); } });
    expect(noLimitsProtectedWrite('python /w/current.py', { ...owner, readOnlyHooks: { sessionEdits: edits }, sessionFile: () => { reads++; return { text: 'print(1)' }; } })).toBeNull();
    expect(reads).toBeLessThanOrEqual(2);
  });
});

it('recursive root producer uses an injected fake tree instead of the container root',()=>{
 const directories=new Set(['/','/etc','/w']);
 const stat=(path:string)=>{
  if(!directories.has(path)&&path!=='/etc/hosts')throw Object.assign(new Error('fixture absent'),{code:'ENOENT'});
  return {dev:1n,ino:path==='/'?1n:path==='/etc'?2n:path==='/w'?3n:4n,nlink:1n,isDirectory:()=>directories.has(path),isFile:()=>path==='/etc/hosts',isSymbolicLink:()=>false};
 };
 const disk:NoLimitsDisk={lstat:stat,stat,readlink:()=>{throw new Error('fixture has no links');},readdir:path=>path==='/'?['etc']:path==='/etc'?['hosts']:[]};
 const result=inspectNoLimits({kind:'exec',dialect:'sh',text:'rsync -a / /w/out',cwd:'/w',cwdInvalid:false},{disk});
 expect(result.verdict).toBe('hold');
 expect(result.hazards.some(h=>h.cause==='protected')).toBe(true);
});
