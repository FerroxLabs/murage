// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { auditReleaseMutations } from './release-mutation-audit.mjs';

// Feed executable JavaScript directly to the real parser. These are inert
// strings; none of the represented HTTP calls is executed.
it.each(['\n', '\r\n', '\r', '\u2028', '\u2029'])('audits a release URL continued over %j', newline => {
  const file = 'continued.mjs';
  const source = 'fetch("https://api.github.com/repos/o/r/rele' + '\\' + newline + 'ases", {method: "POST"});';
  const result = auditReleaseMutations(process.cwd(), new Map([[file, source]]), [file], {releaseGetOnly: true});
  expect(result.errors).toEqual([expect.objectContaining({file, form: 'REST mutation'})]);
});

it('keeps continued GET release reads valid', () => {
  const file = 'continued.mjs';
  const source = 'fetch("https://api.github.com/repos/o/r/rele' + '\\\n' + 'ases", {method: "GET"});';
  expect(auditReleaseMutations(process.cwd(), new Map([[file, source]]), [file], {releaseGetOnly: true}).errors).toEqual([]);
});
