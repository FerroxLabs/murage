// SPDX-License-Identifier: AGPL-3.0-or-later
import { renderPanel } from './view.mjs';
import { createController, POLL_MS } from './controller.mjs';
// Controls for actions beyond the base set appear only when the runtime lists them in `panelActions` (see PANEL-CONTRACT.md).
const root = document.getElementById('app');
const t = (key, subs) => chrome.i18n.getMessage(key, subs === undefined ? undefined : [].concat(subs).map(String)) || key;
const controller = createController({
  send: message => chrome.runtime.sendMessage(message),
  extensionId: chrome.runtime.id,
  onChange: view => renderPanel(document, root, view, { t, act: (a, x) => controller.act(a, x), select: id => controller.select(id), share }),
});
async function currentTab() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return tab; }
async function share() { const tab = await currentTab(); if (tab?.id) await controller.act('share', { tabId: tab.id }); }
const followTab = () => currentTab().then(tab => controller.setTab(tab?.id)).catch(() => {});
document.title = t('spHeader');
chrome.runtime.onMessage.addListener((message, sender) => { controller.push(message, sender); });
chrome.tabs.onActivated?.addListener(followTab);
chrome.windows?.onFocusChanged?.addListener(followTab);
chrome.commands?.getAll?.().then(cmds => controller.setShortcut(cmds.find(c => c.shortcut)?.shortcut)).catch(() => {});
followTab().then(() => controller.refresh());
setInterval(() => controller.tick(), POLL_MS);
