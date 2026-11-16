import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { CopilotAgentDriver } from './copilot.ts';
import { removeTempDir } from '../../testing/cleanup.ts';

it('discovers Copilot premium labels and native thinking without prompting an isolated CLI', async () => {
  const home = mkdtempSync(join(tmpdir(), 'copilot-models-integration-'));
  const instance = await CopilotAgentDriver.create({ instanceId: 'copilot-models-fixture', displayName: 'Fixture', enabled: true,
    environment: { HOME: home, USERPROFILE: home, COPILOT_HOME: home, FAKE_CUSTOM_ACP_DIRECTORY: home },
    config: { cli: `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(resolve('server/testing/fake-custom-acp-models.ts'))}`, fullAuto: false } });
  try {
    await instance.refreshModels?.();
    expect(instance.models.options.find(model => model.id === 'glm-5.3')?.label).toBe('GLM-5.3 · 2x');
    expect(instance.models.options.find(model => model.id === 'glm-5.3-flash')?.variants?.map(choice => choice.id)).toEqual(['medium', 'high']);
    const requests = readFileSync(join(home, 'receipts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(requests.some(request => request.method === 'session/new')).toBe(true);
    expect(requests.filter(request => request.method === 'session/prompt')).toEqual([]);
  } finally { await instance.dispose(); await removeTempDir(home); }
});
