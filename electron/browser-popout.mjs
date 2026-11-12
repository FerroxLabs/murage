import { cloudPartition, cloudHomeEntryUrl } from './cloud-home-protocol.mjs';
import { isOwnedMainSender, isCloudHomeSender } from './main-trust.mjs';
import { createMainNavigationGuard, rendererOriginArguments } from './main-ipc-trust.mjs';
import windowState from './window-state.cjs';

// Each platform is enabled only after POP-OPEN, POP-PERSON and POP-TRUST
// pass on real machines. Linux requires both Wayland and X11.
export const BROWSER_POPOUT_PROVEN_PLATFORMS = Object.freeze([]);
const validBot = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(id);

/** Window lifetime only. A view closing never calls the browser controller. */
export function createBrowserPopouts({ owner, origin, preload, createWindow, readState = () => null, writeState = () => {}, workAreas = () => [], openExternal = () => {} }) {
  const windows = new Map();
  const owners = new WeakSet();
  const notify = (parent, botId, open) => {
    if (!parent.isDestroyed()) parent.webContents.send('browser-popout:state', { botId, open });
  };
  const closeAll = () => { for (const window of [...windows.values()]) if (!window.isDestroyed()) window.close(); };
  return {
    async open(botId) {
      if (!validBot(botId)) throw Error('Invalid browser bot');
      const parent = owner();
      if (!parent || parent.isDestroyed()) throw Error('The Murage window is unavailable');
      const existing = windows.get(botId);
      if (existing && !existing.isDestroyed()) { existing.focus(); return true; }
      const trustedOrigin = new URL(origin()).origin;
      if (trustedOrigin === 'null') throw Error('The Murage window is unavailable');
      let saved;
      try { saved = readState(botId); } catch {}
      const state = windowState.resolveWindowState(saved, workAreas(), { width: 1100, height: 800 }, { width: 390, height: 400 });
      const window = createWindow({ ...state.bounds, minWidth: 390, minHeight: 400, parent, modal: false, show: false,
        title: `${botId} · Browser`, autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload, additionalArguments: rendererOriginArguments(trustedOrigin) } });
      windows.set(botId, window);
      if (!owners.has(parent)) { owners.add(parent); parent.on('close', closeAll); parent.once('closed', closeAll); }
      const guard = createMainNavigationGuard({ origin, openExternal });
      window.webContents.on('will-navigate', guard.willNavigate);
      window.webContents.on('will-redirect', guard.willRedirect);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.once('ready-to-show', () => {
        if (window.isDestroyed()) return;
        if (state.maximized) window.maximize();
        window.show(); window.focus(); window.webContents.focus();
      });
      window.on('close', () => {
        try { writeState(botId, { bounds: window.getNormalBounds(), maximized: window.isMaximized() }); } catch {}
      });
      window.once('closed', () => {
        if (windows.get(botId) !== window) return;
        windows.delete(botId); // revoke before notifying anyone
        notify(parent, botId, false);
      });
      try {
        await window.loadURL(`${trustedOrigin}/?surface=browser-popout&bot=${encodeURIComponent(botId)}`);
        if (window.isDestroyed() || windows.get(botId) !== window) return false;
        notify(parent, botId, true); return true;
      } catch (error) {
        // A failed initial load must not leave a trusted, registered view,
        // even if a page or close handler intercepts the normal close path.
        if (!window.isDestroyed()) window.destroy();
        throw error;
      }
    },
    close(botId, sender) {
      if (!validBot(botId)) throw Error('Invalid browser bot');
      const window = windows.get(botId);
      if (sender && window?.webContents !== sender) throw Error('This view can close only its own window');
      window?.close(); return true;
    },
    closeAll,
    states: sender => [...windows].filter(([, window]) => !window.isDestroyed() && (!sender || window.webContents === sender)).map(([botId]) => ({ botId, open: true })),
    windowFor: sender => [...windows.values()].find(window => window.webContents === sender && !window.isDestroyed()),
    isSender(event) { return [...windows.values()].some(window => isOwnedMainSender(event, { window, origin: origin() })); },
  };
}

/** Cloud views share their owner's already configured session, but never its IPC authority. */
export function createCloudBrowserPopouts({ cloud, preload, createWindow, navigationGuard, readState = () => null, writeState = () => {}, workAreas = () => [] }) {
  const windows = new Map();
  const owners = new WeakSet();
  const keyFor = (homeId, botId) => `cloud:${homeId}:${botId}`;
  const windowFor = sender => [...windows.values()].find(entry => entry.window.webContents === sender && !entry.window.isDestroyed());
  const ownEntry = event => {
    const entry = windowFor(event?.sender);
    return entry && isCloudHomeSender(event, entry) ? entry : undefined;
  };
  const notify = (parent, botId, open) => {
    if (!parent.isDestroyed()) parent.webContents.send('cloud-home:browser-popout:state', { botId, open });
  };
  const closeAll = homeId => {
    for (const entry of [...windows.values()]) {
      if ((!homeId || entry.homeId === homeId) && !entry.window.isDestroyed()) entry.window.close();
    }
  };
  return {
    async open(event, botId) {
      const homeId = cloud.senderHomeId(event);
      if (!homeId || !cloud.active()) throw Error('The Cloud window is unavailable');
      const parent = cloud.windows().get(homeId);
      if (!parent || parent.isDestroyed()) throw Error('The Cloud window is unavailable');
      if (!validBot(botId)) throw Error('Invalid browser bot');
      const key = keyFor(homeId, botId);
      const existing = windows.get(key)?.window;
      if (existing && !existing.isDestroyed()) { existing.focus(); return true; }
      let saved;
      try { saved = readState(key); } catch {}
      const state = windowState.resolveWindowState(saved, workAreas(), { width: 1100, height: 800 }, { width: 390, height: 400 });
      const window = createWindow({ ...state.bounds, minWidth: 390, minHeight: 400, parent, modal: false, show: false,
        title: `${botId} · Browser`, autoHideMenuBar: true,
        webPreferences: { partition: cloudPartition(homeId), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
          preload, additionalArguments: [`--murage-cloud-home=${homeId}`, '--murage-cloud-surface=browser-popout'] } });
      windows.set(key, { window, homeId, botId });
      if (!owners.has(parent)) {
        owners.add(parent);
        parent.on('close', () => closeAll(homeId));
        parent.once('closed', () => closeAll(homeId));
      }
      const guard = navigationGuard(homeId);
      window.webContents.on('will-navigate', guard.willNavigate);
      window.webContents.on('will-redirect', guard.willRedirect);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.once('ready-to-show', () => {
        if (window.isDestroyed()) return;
        if (state.maximized) window.maximize();
        window.show(); window.focus(); window.webContents.focus();
      });
      window.on('close', () => {
        try { writeState(key, { bounds: window.getNormalBounds(), maximized: window.isMaximized() }); } catch {}
      });
      window.once('closed', () => {
        if (windows.get(key)?.window !== window) return;
        windows.delete(key);
        notify(parent, botId, false);
      });
      try {
        await window.loadURL(cloudHomeEntryUrl(homeId, '/?surface=browser-popout&bot=' + encodeURIComponent(botId)));
        if (window.isDestroyed() || windows.get(key)?.window !== window) return false;
        notify(parent, botId, true); return true;
      } catch (error) {
        if (!window.isDestroyed()) window.destroy();
        throw error;
      }
    },
    close(event, botId) {
      if (!validBot(botId)) throw Error('Invalid browser bot');
      const own = ownEntry(event);
      if (own) {
        if (own.botId !== botId) throw Error('This view can close only its own window');
        own.window.close(); return true;
      }
      const homeId = cloud.senderHomeId(event);
      if (!homeId) throw Error('The Cloud window is unavailable');
      windows.get(keyFor(homeId, botId))?.window.close(); return true;
    },
    states(event) {
      const own = ownEntry(event);
      if (own) return [{ botId: own.botId, open: true }];
      const homeId = cloud.senderHomeId(event);
      if (!homeId) return [];
      return [...windows.values()].filter(entry => entry.homeId === homeId && !entry.window.isDestroyed()).map(({ botId }) => ({ botId, open: true }));
    },
    closeAll,
    windowFor,
  };
}
