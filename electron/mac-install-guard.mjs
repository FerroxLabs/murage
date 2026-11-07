// macOS: the update path for a Mac where Squirrel.Mac cannot replace the app by itself.
//
// Squirrel.Mac installs in place only when it can write the app bundle and its folder. When it
// cannot (a folder the person cannot write, an app copy owned by another user or by root, or a
// macOS App Management denial for the program that started Murage), it asks macOS for an
// administrator password and waits. Nothing tells the app, so before 1.0.18 the window stayed open
// with its server already stopped (rel1017 canary-mac, investigators #4 to #7).
//
// This module gives the coordinator two answers. Before the install: if this copy of Murage
// cannot be replaced by the person, skip the in-app install and offer the dmg at once (the server
// keeps running). After "Restart to update": if Squirrel has not reported in time, bring the app
// back and offer the same dmg. The offer survives the relaunch in one small file and is read once.
import { accessSync, constants, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

export const INSTALLER_STALL_MS = 3 * 60 * 1000;
export const RELEASES_URL = "https://github.com/FerroxLabs/murage-releases/releases";
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;
// An offer older than this is dropped: by then the feed has moved on and the person has another way in.
export const OFFER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The public dmg for that version and this Mac's architecture; the latest release page if the version is not a plain x.y.z. */
export function installerDownloadUrl(version, arch = process.arch) {
  if (typeof version !== "string" || !PLAIN_VERSION.test(version)) return `${RELEASES_URL}/latest`;
  return `${RELEASES_URL}/download/v${version}/Murage-${version}-${arch === "x64" ? "x64" : "arm64"}.dmg`;
}

/** True when `url` is one of the links installerDownloadUrl makes. The renderer opens nothing else for this action. */
export function isInstallerDownloadUrl(url) {
  return typeof url === "string" && (url === `${RELEASES_URL}/latest`
    || /^https:\/\/github\.com\/FerroxLabs\/murage-releases\/releases\/download\/v\d+\.\d+\.\d+\/Murage-\d+\.\d+\.\d+-(?:arm64|x64)\.dmg$/.test(url));
}

/** `/x/Murage.app` from `/x/Murage.app/Contents/MacOS/Murage`, or null when the executable is not inside an app bundle. */
export function macBundlePath(execPath) {
  if (typeof execPath !== "string" || !execPath) return null;
  const bundle = dirname(dirname(dirname(execPath)));
  return bundle.endsWith(".app") && dirname(execPath).endsWith("/Contents/MacOS") ? bundle : null;
}

/**
 * Why Squirrel.Mac would not be able to replace this copy in place, or null when it can.
 * Checked just before the install, while the server still runs, so a refusal costs nothing.
 */
export function installFolderProblem({ execPath, getuid, fs = { accessSync, statSync } }) {
  const bundle = macBundlePath(execPath);
  if (!bundle) return "not-in-app-bundle";
  const writable = (path) => {
    try { fs.accessSync(path, constants.W_OK); return true; } catch { return false; }
  };
  if (!writable(bundle)) return "app-not-writable";
  if (!writable(dirname(bundle))) return "folder-not-writable";
  let owner;
  try { owner = fs.statSync(bundle).uid; } catch { return "app-unreadable"; }
  let user;
  try { user = getuid(); } catch { return null; }
  if (typeof user === "number" && owner !== user) return "app-owner-differs";
  return null;
}

export function newer(version, running) {
  if (!PLAIN_VERSION.test(version)) return false;
  if (typeof running !== "string" || !PLAIN_VERSION.test(running)) return true;
  const a = version.split(".").map(Number);
  const b = running.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The updater state the card and Settings render for this offer. `message` is an English fallback for logs and old renderers. */
export function installerOfferState(version, arch = process.arch) {
  const named = typeof version === "string" && PLAIN_VERSION.test(version) ? version : undefined;
  return {
    status: "error",
    action: "download-installer",
    ...(named ? { version: named } : {}),
    downloadUrl: installerDownloadUrl(named, arch),
    message: `Download Murage${named ? ` ${named}` : ""}, then drag it into Applications. Your chats and settings stay.`,
  };
}

/**
 * The coordinator's `installerFallback` for macOS.
 * `recover()` brings the app back once the install has stopped the server (main.mjs relaunches); the
 * offer is written first so the relaunched app shows it.
 */
export function createMacInstallerFallback({
  execPath, getuid, arch = process.arch, offerFile, recover, log = () => {}, now = Date.now,
  stallMs = INSTALLER_STALL_MS, fs = { accessSync, statSync, mkdirSync, readFileSync, rmSync, writeFileSync },
}) {
  const note = (line) => { try { log(line); } catch { /* logging never blocks updating */ } };
  return Object.freeze({
    stallMs,
    blocked() {
      const problem = installFolderProblem({ execPath, getuid, fs });
      if (problem) note(`install pre-check: ${problem}; offering the dmg instead of the in-app install`);
      return problem;
    },
    offer: (version) => installerOfferState(version, arch),
    persist({ version, reason = "install-requested" }) {
      try {
        fs.mkdirSync(dirname(offerFile), { recursive: true, mode: 0o700 });
        fs.writeFileSync(offerFile, JSON.stringify({ version, reason, at: now() }), { mode: 0o600 });
      } catch (error) { note(`installer offer not saved: ${error?.code ?? "write failed"}`); }
    },
    async recover({ version, reason, staged = false, backedUp = false }) {
      if(!backedUp)this.persist({version,reason});
      return recover({ version, reason, staged });
    },
    takePendingOffer(runningVersion) { const offer=this.peekPendingOffer(runningVersion); this.acknowledgePendingOffer(); return offer; },
    acknowledgePendingOffer() { try { fs.rmSync(offerFile, {force:true}); } catch { /* retain on failure */ } },
    /** Read once on the next start: the offer, if it is recent and still newer than what runs. */
    peekPendingOffer(runningVersion) {
      let saved = null;
      try { saved = JSON.parse(fs.readFileSync(offerFile, "utf8")); } catch { return null; }

      if (!saved || typeof saved.version !== "string" || !Number.isFinite(saved.at)) return null;
      const age = now() - saved.at;
      if (age < 0 || age > OFFER_MAX_AGE_MS || !newer(saved.version, runningVersion)) return null;
      return { version: saved.version, reason: typeof saved.reason === "string" ? saved.reason.slice(0, 60) : "unknown" };
    },
  });
}

export const MAC_BUNDLE_ID = "com.murage.app";
export const LANDED_ARGUMENT_PREFIX = "--murage-landed=";
export const INSTALL_WAIT_MS = 60_000;
export const SHIPIT_ARGV = Object.freeze(["-ww", "-ax", "-o", "command="]);
const completeResults = new WeakSet();
/** Only the production command can issue a complete-result token. Release validation
 * must establish its output contract and native lifetime before absence is authority. */
export function shipItState({execPath, home, exec = execFileSync, supported = false}) {
  const bundle = macBundlePath(execPath);
  if (!bundle || !home) return "error";
  let output;
  try {
    const bytes = exec("/bin/ps", [...SHIPIT_ARGV], {timeout:3000, killSignal:"SIGKILL", maxBuffer:4*1024*1024, env:{PATH:"/usr/bin:/bin"}});
    output = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", {fatal:true}).decode(bytes);
  } catch { return "error"; }
  const result = Object.freeze({output, supported}); completeResults.add(result);
  return classifyShipIt(result, {bundle,home});
}
export function classifyShipIt(result, {bundle,home}) {
  if (!completeResults.has(result) || !bundle || !home) return "error";
  const text = result.output;
  if (!text || !text.endsWith("\n") || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) return "error";
  // Match complete known paths before tokenizing: Electron helper names and the
  // bundle's parent directory can contain spaces. Never allow a bundle prefix
  // alone to certify an incomplete or unfamiliar executable.
  const applicationExecutables = [bundle+"/Contents/MacOS/Murage"];
  for (const product of ["Murage", "Electron"]) for (const role of ["", " (GPU)", " (Renderer)", " (Plugin)"]) {
    const name = product+" Helper"+role;
    applicationExecutables.push(`${bundle}/Contents/Frameworks/${name}.app/Contents/MacOS/${name}`);
  }
  let unknown = false, foreign = false, ours = false;
  for (const raw of text.slice(0,-1).split("\n")) {
    const row = raw.trim();
    if (!row || /…|\.\.\.|(?:^|\/)ShipI(?:\s|$)/.test(row)) { unknown=true; continue; }
    if (applicationExecutables.some(path => row === path || (row.startsWith(path) && /\s/.test(row[path.length] ?? "")))) continue;
    // Unknown paths still have no escaping contract for spaces in ps output.
    if (!row.startsWith("/")) { unknown=true; continue; }
    const executable = row.split(/\s/)[0];
    const base=executable.slice(executable.lastIndexOf("/")+1);
    if ((base.length>0&&base!=="ShipIt"&&"ShipIt".startsWith(base)) || /com\.murage\.app\.(?:S|Sh|Shi|Ship|ShipI|ShipIt)\/?$/.test(executable)) {unknown=true;continue;}
    if (/ShipIt[^/]*$/.test(executable) && !/\/(ShipIt|ShipItHelper|ShipIt.old)$/.test(executable)) { unknown=true; continue; }
    if (!base || (!executable.endsWith("/ShipIt") && (executable.startsWith(bundle+"/") || executable.startsWith(home+"/Library/Caches/"+MAC_BUNDLE_ID+".ShipIt/")))) { unknown=true; continue; }
    if (!executable.endsWith("/ShipIt")) {
      if (/\/[^\n]*\s[^-\n]*\//.test(row.split(" --")[0])) unknown=true;
      continue;
    }
    if (executable.startsWith(bundle+"/") || executable.startsWith(home+"/Library/Caches/"+MAC_BUNDLE_ID+".ShipIt/")) ours=true;
    else foreign=true;
  }
  return ours ? "installing" : unknown ? "error" : foreign ? "foreign" : result.supported ? "absent" : "error";
}
export function bundleInfoOnDisk({execPath, read = readFileSync, exec = execFileSync}) {
  const bundle = macBundlePath(execPath); if (!bundle) return null;
  try {
    const bytes = read(bundle+"/Contents/Info.plist");
    const value = JSON.parse(exec("/usr/bin/plutil", ["-convert","json","-o","-","-"], {input:bytes,encoding:"utf8",timeout:3000,killSignal:"SIGKILL",maxBuffer:1024*1024,env:{PATH:"/usr/bin:/bin"}}));
    return value.CFBundleIdentifier === MAC_BUNDLE_ID && PLAIN_VERSION.test(value.CFBundleShortVersionString) ? Object.freeze({version:value.CFBundleShortVersionString}) : null;
  } catch { return null; }
}
export function observeRequestedInstall(options) {
  const shipIt = shipItState(options);
  const bundle = bundleInfoOnDisk(options);
  return Object.freeze({shipIt,bundle});
}
export function landedArgument(version) {
  if (!PLAIN_VERSION.test(version)) throw Error("BACKUP_UPGRADE_REVIEW_REQUIRED");
  return LANDED_ARGUMENT_PREFIX+version;
}
export function decideRequestedInstall({facts, runningVersion, candidate, hop, argv = []}) {
  if (facts.shipIt === "installing") return {kind:"installing"};
  if (facts.shipIt !== "absent") return {kind:"review",reason:facts.shipIt === "foreign" ? "foreign-installer" : "observation-unknown"};
  if (!facts.bundle) return {kind:"review",reason:"bundle-unknown"};
  if (facts.bundle.version === candidate.version) return hop?.automaticSpent || argv.includes(landedArgument(candidate.version)) ? {kind:"review",reason:"landed-not-running",candidateOnDisk:true} : {kind:"landed",candidateOnDisk:true};
  if (facts.bundle.version === runningVersion) return {kind:"cancel"};
  return {kind:"review",reason:"foreign-bundle"};
}

/** Absence needs a release-qualified native lifetime and ps output contract for
 * this exact runtime. The shipped registry starts empty until the Mac gates pass. */
export function nativeContractSupported({electronVersion,appVersion,arch=process.arch,platform=process.platform,read=readFileSync}) {
  if(platform!=="darwin")return false;
  try{
    const registry=JSON.parse(read(new URL("./mac-native-contract.json",import.meta.url),"utf8"));
    return registry.version===1&&Array.isArray(registry.qualified)&&registry.qualified.some(entry=>
      entry.electronVersion===electronVersion&&entry.appVersion===appVersion&&entry.arch===arch&&
      /^[a-f0-9]{64}$/.test(entry.evidenceSha256)&&
      ["P6a","P6c","P6d","P6e","P6f","completeOutput"].every(key=>entry[key]===true));
  }catch{return false;}
}
