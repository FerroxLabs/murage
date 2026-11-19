// SPDX-License-Identifier: AGPL-3.0-or-later
// Native grant producer: scperf-p1. Isolated launcher consumer: c4-misc-d.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage } from '../scripts/control-murage.ts';

it('the isolated fake-engine workflow retains native enforcement for a physical background write', async () => {
  const instrumentationSource = `
    globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
    {
      const {writeFileSync}=await import('node:fs');
      const {join}=await import('node:path');
      const {pathToFileURL}=await import('node:url');
      const directory=process.env.MURAGE_DATA_DIR;
      let receipt;
      try {
        const meter=await import(pathToFileURL(join(process.cwd(),'server/io-meter.ts')).href);
        const counted=await import(pathToFileURL(join(process.cwd(),'server/counted-fs.ts')).href);
        meter.withBgGrant({bytes:65536,expiresAt:meter.ioMeterWallTime()+10000},()=>{
          counted.writeFileSync(join(directory,'.meter-behavior-write'),Buffer.alloc(4096,7));
          receipt={chargedBytes:meter.ioGrantSnapshot().chargedBytes};
        });
      } catch (error) { receipt={error:String(error.message)}; }
      writeFileSync(join(directory,'.meter-behavior-receipt.json'),JSON.stringify(receipt));
    }
  `;
  const fixture = await launchVerificationServer(process.env, undefined, {
    instrumentationSource, turnLog: { replies: ['Fixture reply.'] },
  });
  const call = (args: string[]) => runControlMurage([...args, '--url', fixture.info.url]);
  try {
    expect(await call(['doctor'])).toMatchObject({ ok: true });
    const created = await call(['new-bot', '--name', 'Fixture']) as { bot: { id: string } };
    expect(await call(['send', '--bot', created.bot.id, '--text', 'Fixture hello'])).toMatchObject({ success: true, botId: created.bot.id });
    expect(await call(['wait', '--bot', created.bot.id, '--timeout', '20'])).toMatchObject({ status: 'settled' });
    const transcript = await call(['messages', '--bot', created.bot.id, '--limit', '10']) as { messages: Array<{ role: string; text?: string }> };
    expect(transcript.messages.some(row => row.role === 'bot' && row.text?.includes('Fixture reply.'))).toBe(true);
    const receipt = JSON.parse(readFileSync(join(fixture.info.dataDir, '.meter-behavior-receipt.json'), 'utf8'));
    expect(receipt.error).toBeUndefined();
    expect(receipt.chargedBytes).toBeGreaterThanOrEqual(4096);
    expect(readFileSync(join(fixture.info.dataDir, '.meter-behavior-write'))).toEqual(Buffer.alloc(4096, 7));
  } finally { await fixture.close(); }
});
