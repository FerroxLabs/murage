import type { DaemonVerdict } from './browser-daemon-identity.ts';
/** A close acknowledgement is sufficient. A failed socket close is sufficient
 * only after identity-checked termination has actually been observed. */
export async function closeKnownDaemon(options: {
  close: () => Promise<void>;
  judge: () => Promise<DaemonVerdict>;
  signal: (signal: 'SIGTERM' | 'SIGKILL') => void;
  wait?: () => Promise<void>;
  rounds?: number;
}): Promise<void> {
  if (await options.judge() === 'gone') return;
  try { await options.close(); return; }
  catch (error) {
    const verdict = await options.judge();
    if (verdict === 'gone') return;
    if (verdict !== 'alive') throw error;
  }
  const wait = options.wait ?? (() => new Promise(resolve => setTimeout(resolve, 100)));
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    // Judge before each signal, including escalation, never only afterwards.
    const verdict = await options.judge();
    if (verdict === 'gone') return;
    if (verdict !== 'alive') throw new Error('Browser daemon identity could not be checked');
    try { options.signal(signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    for (let i = 0; i < (options.rounds ?? 20); i++) {
      const after = await options.judge();
      if (after === 'gone') return;
      if (after !== 'alive') throw new Error('Browser daemon identity could not be checked');
      await wait();
    }
  }
  throw new Error('Browser daemon is still running');
}
