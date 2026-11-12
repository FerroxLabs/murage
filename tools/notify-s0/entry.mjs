// Separate packaged qualification entry. No production main, server, profile,
// transport, approval token authority or network listener is loaded here.
import { safeWipe } from '../../server/testing/safe-wipe.mjs';
import { app, Notification, Menu, BrowserWindow, dialog, screen, desktopCapturer, nativeTheme } from 'electron';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, release, arch, hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { createWindowsBanners } from '../../electron/windows-banners.mjs';
import { createMacBanners } from '../../electron/mac-banners.mjs';
import { createLinuxBanners, loadSessionBus } from '../../electron/linux-notify.mjs';
import { createNotificationAuthorization } from '../../electron/notification-authorization.mjs';
import { trayMenu } from '../../electron/background-lifecycle.mjs';
import { sourceBinding, sha256, canonical, casesFor } from '../../electron/notify-s0.mjs';
import { fitsEnvelope } from '../../shared/outside-limits.mjs';
import { ROOT, rigHash, writeJSON, calibrationCases } from './kit.mjs';

const args = process.argv.slice(1);
const arg = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
let output, scratch, banner, popup, window;
const startedAt = new Date().toISOString();
const stop = reason => { throw Error(`S0_OPEN:${reason}`); };
const noAction = () => {};
const shell = (exe, argv) => execFileSync(exe, argv, { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
try {
  if (!arg('--out')) stop('--out required');
  output = resolve(arg('--out'));
  mkdirSync(output, { recursive: false }); // Never overwrite another run.
  scratch = mkdtempSync(join(tmpdir(), 'murage-s0-'));
  mkdirSync(join(scratch, 'session'));
  app.setPath('userData', scratch);
  app.setPath('sessionData', join(scratch, 'session'));
  app.setAppUserModelId('com.murage.app');
  if (!app.isPackaged) stop('packaged-build-required');
  if (process.platform === 'linux' && ((!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) || !process.env.DBUS_SESSION_BUS_ADDRESS)) stop('real-desktop-session-required');
  await app.whenReady();
  app.on('window-all-closed', noAction);
  const binding = sourceBinding(ROOT);
  const nativeFiles = [process.execPath];
  if (process.platform === 'darwin') nativeFiles.push(join(process.resourcesPath, 'notification-authorization.node'));
  if (process.platform === 'linux') nativeFiles.push(join(ROOT, 'electron/vendor/dbus-next.cjs'));
  const nativeHash = sha256(canonical(nativeFiles.map(p => sha256(readFileSync(p)))));
  // Electron's patched fs treats asar paths as virtual directories. Hash the
  // archive bytes with original-fs, while sourceBinding reads inside the asar.
  const packageHash = sha256(createRequire(import.meta.url)('original-fs').readFileSync(join(process.resourcesPath, 'app.asar')));
  const displays = () => screen.getAllDisplays().map(d => ({ id:d.id, scaleFactor:d.scaleFactor, bounds:d.bounds, workArea:d.workArea }));
  let daemon = process.platform === 'linux' ? null : 'os-native';
  if (process.platform === 'linux') {
    const bus = loadSessionBus();
    try {
      const proxy = await bus.getProxyObject('org.freedesktop.Notifications', '/org/freedesktop/Notifications');
      daemon = canonical(await proxy.getInterface('org.freedesktop.Notifications').GetServerInformation());
    } finally { bus.disconnect(); }
  }
  const observed = { platform:process.platform, osBuild:release(), arch:arch(), electron:process.versions.electron,
    nativeHash, daemon, session:process.platform === 'linux' ? process.env.XDG_SESSION_TYPE : process.platform === 'darwin' ? 'aqua' : 'gui',
    theme:nativeTheme.shouldUseDarkColors ? 'dark' : 'light' };
  if (process.platform === 'win32') {
    const version = JSON.parse(shell('powershell.exe', ['-NoProfile','-NonInteractive','-Command', "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion' | Select-Object CurrentBuildNumber,UBR,DisplayVersion | ConvertTo-Json -Compress"]));
    if (!/^\d+$/.test(version.CurrentBuildNumber) || !Number.isInteger(version.UBR)) stop('windows-build-unreadable');
    observed.osBuild = `10.0.${version.CurrentBuildNumber}.${version.UBR}`;
    observed.osVersion = `${Number(version.CurrentBuildNumber) >= 22000 ? 'Windows 11' : 'Windows 10'} ${version.DisplayVersion}`;
    observed.desktop = 'Windows';
  }
  if (process.platform === 'darwin') observed.osVersion = shell('/usr/bin/sw_vers', ['-productVersion']);
  if (process.platform === 'linux') {
    const os = Object.fromEntries(readFileSync('/etc/os-release','utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => { const n=l.indexOf('='); return [l.slice(0,n), l.slice(n+1).replace(/^"|"$/g,'')]; }));
    observed.osVersion = os.ID === 'fedora' ? `Fedora ${os.VERSION_ID}` : os.VERSION_ID;
    observed.desktop = process.env.XDG_CURRENT_DESKTOP?.includes('GNOME') ? shell('gnome-shell',['--version']).replace(/^GNOME Shell /,'GNOME ') : shell('plasmashell',['--version']).replace(/^plasmashell /,'KDE Plasma ');
  }
  writeJSON(join(output, 'admission.json'), { startedAt, machine:hostname(), observed, displays:displays(), packageHash, binding, rigHash:rigHash(), packaged:true });
  if (arg('--admit') !== null || args.includes('--admit')) {
    await dialog.showMessageBox({ message:'S0 admission recorded', detail:`${output}\nUse admission.json to fill the plan. Font, system text size and native layout still need measurement.`, buttons:['Close'] });
  } else {
    const input = arg('--plan');
    if (!input) stop('--plan required (or use --admit)');
    const planBytes = readFileSync(resolve(input)), plan = JSON.parse(planBytes);
    if (plan.binding !== binding || plan.rigHash !== rigHash()) stop('stale-plan');
    for (const [key, value] of Object.entries(observed)) if (canonical(plan.layout[key]) !== canonical(value)) stop(`layout-${key}`);
    if (!displays().some(d => d.scaleFactor === plan.layout.displayScale && d.workArea.width === plan.layout.workArea[0] && d.workArea.height === plan.layout.workArea[1])) stop('display-layout');
    if (canonical(plan.cases) !== canonical(plan.calibration === true ? calibrationCases() : casesFor(plan.envelope, plan.widest))) stop('case-plan');
    writeFileSync(join(output, 'plan.json'), planBytes, { flag:'wx' });
    mkdirSync(join(output, 'posts')); mkdirSync(join(output, 'captures'));
    const frozenDisplays = canonical(displays());
    let changed = false;
    for (const event of ['display-added','display-removed','display-metrics-changed']) screen.on(event, () => { changed = true; });
    nativeTheme.on('updated', () => { changed = true; });
    const options = { mint:()=>randomBytes(16).toString('hex'), act:async()=>({ok:false}), invalidate:noAction, open:noAction, mute:noAction, locked:()=>false, language:()=>plan.layout.locale };
    if (process.platform === 'win32') banner = createWindowsBanners({ ...options, Notification });
    if (process.platform === 'darwin' && plan.layout.surface !== 'menu') {
      const auth = createNotificationAuthorization();
      if (!(await auth.ensure()).authorized) stop('notification-permission');
      banner = createMacBanners({ ...options, loadAddon:()=>auth.addon() });
    }
    if (process.platform === 'linux') banner = createLinuxBanners({ ...options, loadBus:loadSessionBus });
    const observations = { schema:1, kind:'murage-s0-native-measurement', fixture:false, binding, rigHash:rigHash(), packageHash,
      planHash:sha256(planBytes), startedAt, finishedAt:null, operator:plan.operator, machine:plan.machine, layout:plan.layout, envelope:plan.envelope, measurements:plan.measurements, observations:[] };
    // Optional --case allows iterative calibration against the SAME templates.
    const selected = arg('--case') ? plan.cases.filter(c => c.id === arg('--case')) : plan.cases;
    if (!selected.length) stop('unknown-case');
    for (const c of selected) {
      const choice = await dialog.showMessageBox({ message:`S0 ${c.id}`, detail:`${plan.layout.surface} / ${plan.layout.layout}\nArrange the native layout. The next capture contains the whole desktop; use only the isolated gate session.\nAfter dismissal, the probe posts and waits 5 seconds. For menu: open the Needs you submenu.`, buttons:['Render', 'Stop'], cancelId:1 });
      if (choice.response !== 0) stop('operator-stopped');
      if (changed || frozenDisplays !== canonical(displays())) stop('layout-changed');
      let ids, nativePosted = false, transformed = false;
      if (plan.layout.surface === 'menu') {
        const summary = `${c.display.title}\n${c.display.willRun}`;
        const items = trayMenu({ summary:{needsYou:1,items:[{botId:'s0',botName:c.display.botName,summary,threadId:'s0',messageId:'s0',requestId:'s0',quick:true}],working:[],bots:[]}, automationsPaused:false, now:Date.now(), open:noAction,openInbox:noAction,openTarget:noAction,decide:()=>noAction,togglePause:noAction,quit:noAction });
        // This reveals the shipped menu's whitespace folding/clipping. It must
        // not be credited as a complete detail template when text was altered.
        transformed = items.find(i => i.submenu)?.submenu[0].label !== summary;
        // The real template cannot preserve the injected title/detail break.
        // Keep this as a recorded negative; no alternate menu is substituted.
        window ??= new BrowserWindow({width:480,height:240,show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
        window.show();
        popup = Menu.buildFromTemplate(items); popup.popup({window}); nativePosted = true;
      } else {
        ids = await banner.show({entry:{home:'s0-fixture',frame:{botId:'s0',threadId:'s0',messageId:'s0',requestId:'s0'}}, record:{open:true,requestId:'s0',digest:'s0-inert',outsideOk:{[plan.layout.surface]:true},display:c.display}, actionsOn:true,silent:true,plain:{title:'S0',body:'S0'},onFailed:()=>{nativePosted=false;} });
        nativePosted = Array.isArray(ids) && ids.length > 0;
      }
      await new Promise(r => setTimeout(r, 5000));
      if (!nativePosted || changed) stop(`native-post-or-layout-${c.id}`);
      // Native capture only: no DOM/canvas reconstruction or synthetic bounds.
      const ds = displays();
      const sources = await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.max(...ds.map(d=>Math.ceil(d.bounds.width*d.scaleFactor))),height:Math.max(...ds.map(d=>Math.ceil(d.bounds.height*d.scaleFactor)))}});
      if (!sources.length) stop('screen-capture-unavailable');
      for (let n=0;n<sources.length;n++) {
        if (sources[n].thumbnail.isEmpty()) stop('empty-screen-capture');
        writeFileSync(join(output,'captures',`${c.id}-${n}.png`),sources[n].thumbnail.toPNG(),{flag:'wx'});
      }
      const observedAt = new Date().toISOString();
      const receipt = {transformed,id:c.id,payloadHash:sha256(canonical(c.display)),nativePosted,observedAt,binding,rigHash:rigHash(),packageHash,layout:plan.layout,screens:sources.map((s,n)=>({file:`captures/${c.id}-${n}.png`,displayId:s.display_id,size:s.thumbnail.getSize(),sha256:sha256(s.thumbnail.toPNG())}))};
      writeJSON(join(output,'posts',`${c.id}.json`),receipt);
      banner?.close(ids); popup?.closePopup(); window?.hide();
      observations.observations.push({id:c.id,payloadHash:receipt.payloadHash,nativePosted,observedAt,capture:`captures/${c.id}-0.png`,captureHash:null,postReceiptHash:null,complete:null,transformed:transformed ? true : null,runtimeRefused:c.kind === 'reject' ? !fitsEnvelope(c.display.willRun,c.display.title,c.display.botName,plan.envelope) : null});
      writeFileSync(join(output,'observations.json'),`${JSON.stringify(observations,null,2)}\n`);
    }
    writeJSON(join(output,'run.json'),{status:'OPEN',reason:'operator-measurement-and-review-required',startedAt,finishedAt:new Date().toISOString(),elapsedMs:Date.now()-Date.parse(startedAt),cases:selected.length});
    await dialog.showMessageBox({message:'S0 captures recorded',detail:`${output}\nMeasure the PNGs and complete observations.json. Captures alone do not qualify an envelope.`,buttons:['Close']});
  }
} catch (error) {
  if (output) { try { writeJSON(join(output,'OPEN.json'),{status:'OPEN',reason:error.message,startedAt,finishedAt:new Date().toISOString()}); } catch {} }
  console.error(error.message);
  app.exitCode = 1;
} finally {
  banner?.dispose(); popup?.closePopup(); window?.destroy();
  // This directory was generated by this process; never a user profile.
  if (scratch) {
    try { await safeWipe(scratch,{maxRetries:3,retryDelay:100}); }
    catch {
      try { writeJSON(join(output,'cleanup.json'),{status:'OPEN',scratch,reason:'scratch-still-in-use'}); } catch {}
      app.exitCode = 1;
    }
  }
  app.exit(app.exitCode ?? 0);
}
