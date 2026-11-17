import { withHideInherit } from "../../shared/win-hide-child-process.mjs";
// Deliberately simple contract stub. Never presented as proof of guard behavior.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { posixStatus } from './adapter.mjs';
const tool = process.argv[2], argv = process.argv.slice(3);
let guard;
try { guard = JSON.parse(await fs.readFile(process.env.MURAGE_WIPE_GUARD, 'utf8')); } catch {}
const backend = process.env.WIPE_PROOF_REAL_DIR + '/' + tool;
let match = false, targets = [];
if (guard && !guard.off && process.env.MURAGE_WIPE_GUARD_OFF !== '1') {
  const operands = (tool === 'dd' ? argv.filter(x => x.startsWith('of=')).map(x => x.slice(3)) : argv).filter(x => !x.startsWith('-') && !x.includes('='));
  if (tool === 'mv') operands.pop();
  targets = operands.map(x => path.resolve(x));
  const recursive = tool !== 'rm' || argv.some(x => /^-.*[rR]/.test(x) || x === '--recursive');
  if (recursive) for (const root of guard.roots) {
    const children = (await fs.readdir(root)).map(x => path.join(root, x));
    const selected = new Set(targets.filter(x => children.includes(x)));
    match ||= targets.includes(root) || children.length > 0 && selected.size >= Math.ceil(children.length * 0.9);
  }
  match ||= tool === 'mkfs' || tool.startsWith('mkfs.') || tool === 'diskutil' && argv[0]?.startsWith('erase');
}
if (match && process.env.WIPE_PROOF_MUTANT !== 'bypass') {
  const request = { v: 1, kind: 'wipe-exec', id: randomUUID(), threadId: guard.threadId, tool, argv, cwd: process.cwd(), targets };
  const result = spawnSync(guard.client[0], [...guard.client.slice(1), 'wipe-exec', JSON.stringify(request)], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.stderr.write((result.status === 10 ? 'wipe guard: refused ' : 'wipe guard: app unreachable; refused ') + (targets[0] ?? guard.roots[0]) + '\n');
    process.exit(result.status === 10 ? posixStatus.deny : posixStatus.unreachable);
  }
}
const executable = guard?.realTools?.[tool] || backend;
const result = process.platform === 'win32' ? spawnSync('sh.exe', [executable, ...argv], withHideInherit({ stdio: 'inherit' }))
  : spawnSync(executable, [...argv], { stdio: 'inherit' });
process.exit(result.status ?? 127);
