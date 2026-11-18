#!/usr/bin/env node
// Reuse the repository's native hook protocol, but never execute its scripted
// tool commands. Hook handlers still run and deliver the real relay verdict.
import { registerHooks } from 'node:module';
const target = new URL('../../testing/fake-agy-cli.ts', import.meta.url).href;
registerHooks({ load(url, context, next) {
 const loaded = next(url, context);
 if (url !== target) return loaded;
 const source = String(loaded.source);
 const original = 'try { execSync(call.args.CommandLine, { cwd: process.cwd(), stdio: "ignore", shell }); } catch { /* the step still ran */ }';
 if (!source.includes(original)) throw Error('inert fake execution anchor changed');
 return { ...loaded, source: source.replace(original, 'if (process.env.INERT_AGY_WITNESS) writeFileSync(process.env.INERT_AGY_WITNESS, "unexpected execution");') };
} });
await import(target);
