// SAFE backend: no real disk commands, and no mutation beyond the validated fake tree.
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertTarget } from './safety.mjs';
const [tool, ...argv] = process.argv.slice(2);
try {
  const root = process.env.WIPE_PROOF_TREE;
  if (!root) throw Error('no-fixture');
  const operands = argv.filter(x => !x.startsWith('-') && !x.includes('='));
  // Disk commands are record-only, even when explicitly allowed.
  const paths = ['rm', 'rmdir', 'mv'].includes(tool) ? operands : [];
  for (const operand of paths) await assertTarget(root, path.resolve(operand));
  await fs.appendFile(process.env.WIPE_PROOF_BACKEND, JSON.stringify({ tool, argv }) + '\n');
  if (process.env.WIPE_PROOF_ECHO === '1') { process.stdout.write('fixture out\n'); process.stderr.write('fixture err\n'); }
  const exit = Number(process.env.WIPE_PROOF_EXIT || 0);
  if (exit) process.exit(exit);
  if (tool === 'rm' || tool === 'rmdir') {
    for (const operand of paths) await fs.rm(path.resolve(operand), { recursive: tool === 'rm' && argv.some(x => /^-.*[rR]/.test(x) || x === '--recursive'), force: argv.some(x => /^-.*f/.test(x)) });
  } else if (tool === 'mv') {
    const destination = path.resolve(paths.at(-1));
    for (const operand of paths.slice(0, -1)) {
      let to = destination;
      try { if ((await fs.stat(destination)).isDirectory()) to = path.join(destination, path.basename(operand)); } catch {}
      await assertTarget(root, to); await fs.rename(path.resolve(operand), to);
    }
  }
} catch { process.stderr.write('fixture backend refused unsafe or invalid call\n'); process.exitCode = 97; }
