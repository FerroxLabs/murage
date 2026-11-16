// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The fifteen-task gate is reachability, not execution of billable actions.
// Each row opens its actual shipped destination through one Settings search.
export const G9_TASKS = [
  ['add OpenAI key', 'api key', 'models.paste-keys', 'paste-any-keys'],
  ['change bot engine', 'model', 'bot.model.model', 'bot-setting-model'],
  ['stop permission asking', 'permission', 'bot.permissions.level', 'bot-setting-level'],
  ['connect Gmail', 'connected apps', 'connections.apps', 'connections-heading'],
  ['quiet notifications at night', 'quiet hours', 'general.notifications', 'notifications-heading'],
  ['pair phone', 'phone pairing', 'companion.pairing', 'companion-heading'],
  ['house rules', 'house rules', 'botDefaults.house-rules', 'house-rules-heading'],
  ['morning brief', 'routines', 'bot.routines.routines', 'bot-setting-routines'],
  ['add MCP server', 'mcp', 'connections.mcp', 'mcp-servers-heading'],
  ['bot Chrome access', 'browser', 'bot.access.browser', 'bot-setting-browser'],
  ['voice', 'voice', 'bot.voice.voice', 'bot-setting-voice'],
  ['backup', 'backup', 'backups.backups', 'backups-heading'],
  ['spending', 'spending', 'usage.spend-limit', 'spend-limit-heading'],
  ['Grok Bot migration', 'bring what', 'general.bring-your-ai', 'bring-your-ai-heading'],
  ['folder access', 'working folder', 'bot.access.folder', 'bot-setting-folder'],
];
export async function verifyPackageG9(page, bot, evidence, screenshot) {
  const { expect } = await import('@playwright/test');
  const rows = [];
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const [task, query, id, anchor] of G9_TASKS) {
    // Return to General inside the already open Settings window. The search
    // counts start there; navigation between independent cases is setup.
    await page.locator('[data-settings-section="general"]').click();
    const actualQuery = id.startsWith('bot.') ? `${bot.name} ${query}` : query;
    await page.locator('#settings-search').fill(actualQuery);
    const result = page.locator(`[data-settings-result="${id}"]${id.startsWith('bot.') ? `[data-settings-result-bot="${bot.id}"]` : ''}`);
    await expect(result).toBeVisible();
    await result.click();
    const destination = page.locator(`[id="${anchor}"], [data-setting-control="${anchor}"]`).first();
    await expect(destination).toBeVisible();
    if (id === 'general.bring-your-ai') await expect(destination.getByRole('button', { name: 'Bring a Grok Bot', exact: true })).toBeVisible();
    if (id === 'usage.spend-limit') await expect(page.locator('input[data-setting-control="spend-limit-heading"]')).toHaveValue('1000');
    await screenshot(`${evidence}/g9-${rows.length + 1}.png`);
    rows.push({ task, query: actualQuery, id, anchor, searches: 1, resultClicks: 1 });
  }
  return rows;
}
