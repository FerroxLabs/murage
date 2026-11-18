// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as inspector from 'node:inspector';
import v8 from 'node:v8';
import { syncBuiltinESMExports } from 'node:module';
const unavailable = () => { throw new Error('Password protection is unavailable.'); };
const UNSAFE = /(?:^|\s)--(?:inspect(?:-brk|-wait)?|report-(?:on-fatalerror|on-signal|uncaught-exception)|heapsnapshot-(?:near-heap-limit|signal)|heap-prof)(?:\s|=|$)/u;
/** Fail closed for password admission. OS success is required separately from
 * disabling Node's own memory-bearing diagnostics. Never serialize options. */
export function protectPasswordProcess(deps = {}) {
  const runtime = deps.runtime ?? process, heap = deps.v8 ?? v8;
  try {
    if ((deps.inspectorUrl ?? inspector.url)()) return false;
    const flags = [...runtime.execArgv, runtime.env.NODE_OPTIONS ?? ''].join(' ').replaceAll('_', '-');
    if (UNSAFE.test(flags)) return false;
    if (runtime.report) {
      for (const name of ['reportOnFatalError', 'reportOnSignal', 'reportOnUncaughtException']) {
        runtime.report[name] = false;
        Object.defineProperty(runtime.report, name, { get: () => false, set: unavailable, configurable: false });
      }
      for (const name of ['writeReport', 'getReport']) Object.defineProperty(runtime.report, name, { value: unavailable, writable: false, configurable: false });
    }
    for (const name of ['writeHeapSnapshot', 'getHeapSnapshot']) Object.defineProperty(heap, name, { value: unavailable, writable: false, configurable: false });
    (deps.syncExports ?? syncBuiltinESMExports)();
    return deps.native?.disableCoreDumps?.() === true;
  } catch { return false; }
}
