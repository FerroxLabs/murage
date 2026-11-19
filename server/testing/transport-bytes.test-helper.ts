// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: MAIN owns adapter transports; tafix-r4a owns this inert CLI receiver.
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

/** Record every received byte before the fake CLI parses it, including launches after a restart. */
export function recordingCli(original:string,root:string):string{
 const wrapper=join(root,'transport-receiver.mjs'),output=join(root,'wire-bytes');
 writeFileSync(wrapper,`#!/usr/bin/env node
 import {appendFileSync} from 'node:fs';
 appendFileSync(${JSON.stringify(output)},JSON.stringify(process.argv)+'\\n');
 process.stdin.pause();
 process.stdin.on('data',bytes=>appendFileSync(${JSON.stringify(output)},bytes));
 process.stdin.pause();
 await import(${JSON.stringify(pathToFileURL(original).href)});
 process.stdin.resume();
 `,{mode:0o755});
 return wrapper;
}
