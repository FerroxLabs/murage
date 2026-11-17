// SPDX-License-Identifier: AGPL-3.0-or-later
// Consumer fixture owner: tri3-g2-f. I/O launcher producer: scperf-p2. Native shim producer: tri3-g1.
import { expect } from 'vitest';

/** Recognize the exact reviewed metered wrapper, preserving the native shim and server arguments. */
export function fixtureNativeShim(stanza: { command: string; args: string[]; env?: Record<string, string> }, server: string): string {
  expect(stanza.command).toBe(process.execPath);
  let args = stanza.args;
  if (/io-proxy-launcher\.(?:ts|js)$/.test(args[0] ?? '')) {
    expect(stanza.env).toMatchObject({ MURAGE_IO_PROXY_PORT: expect.stringMatching(/^\d+$/), MURAGE_IO_PROXY_KEY: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    args = args.slice(1);
  }
  expect(args[0]).toMatch(/cli-mount-shim\.(?:ts|js)$/);
  expect(args.slice(1)).toEqual(['--server', server]);
  return args[0]!;
}
