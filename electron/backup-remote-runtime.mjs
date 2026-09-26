import {lstatSync,mkdirSync,realpathSync,rmSync,rmdirSync} from "node:fs";
import path from "node:path";
import {restrictToOwner,restrictToOwnerAsync} from "./backup-windows-acl.mjs";
import {samePath} from "../shared/path-identity.mjs";
// POSIX: owner uid and 0700 are checked in place on every use. Windows has
// neither, so the "remote" tree is created with an owner-only ACL
// (backup-windows-acl.mjs) that everything below it inherits: the per-run
// SSH key folders and the job journals.
const posix=()=>process.platform!=="win32";
const owned=stat=>!posix()||stat.uid===process.getuid?.();
const privateMode=stat=>!posix()||!(stat.mode&0o077);
// The desktop hands in its canonical data-folder path, which on Windows is
// case-folded (c:\users\sam lee\.murage). The native realpath answers in the
// filesystem's own casing (C:\Users\Sam Lee), so a raw string compare refused
// every Windows install and off-site copies could never be set up (W-D2).
// samePath compares one spelling: case-folded on Windows only.
const canonical=directory=>samePath(realpathSync.native(directory),directory);
function makeDirectory(directory,{restrict=false,platform}={}){
 let created=false;try{mkdirSync(directory,{mode:0o700});created=true;}catch(error){if(error.code!=="EEXIST")throw error;}
 if(created&&restrict&&!posix())(platform?.restrictToOwner??restrictToOwner)(directory,{directory:true});
}
/** The folder off-site work state lives in. POSIX: the private control folder
 * beside the data folder, as before. Windows: a short per-installation folder
 * under this computer's own local app data, owner-only like the rest:
 * `%LOCALAPPDATA%\murage\offsite\<16 of the installation digest>`.
 * - Short: Windows can't create a folder past 248 characters (or open a file
 *   past 260 with ssh), and beside a restored install's data folder the work
 *   tree was about 235, so every upload failed with ENAMETOOLONG (W-D2).
 * - Local: companies often redirect AppData\Roaming (Electron's userData) to
 *   a network share. icacls and ssh can't use a \\server\share path, so the
 *   earlier `<userData>\offsite` made off-site copies unavailable there (W-A4).
 *   Local AppData is never redirected or roamed, which also keeps per-machine
 *   SSH keys and job journals on the machine that made them.
 * userData is the fallback only when local app data is unusable and userData
 * itself is on a local drive. Off-site copies never worked on Windows before
 * 0.1.60, so nothing moves. */
export function remoteControlDirectory({control,userData,localAppData,platform=process.platform}){
 if(platform!=="win32")return control;
 const digest=path.win32.basename(control);
 const local=value=>typeof value==="string"&&/^[A-Za-z]:\\/.test(value)&&!/["\x00-\x1f]/.test(value);
 if(!/^[0-9a-f]{64}$/.test(digest))throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");
 if(local(localAppData))return path.win32.join(localAppData,"murage","offsite",digest.slice(0,16));
 if(local(userData))return path.win32.join(userData,"offsite",digest.slice(0,16));
 throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");
}
/** %LOCALAPPDATA% in its real spelling, or null. Never a network path. */
export function localAppDataDirectory(env=process.env,{realpath=realpathSync.native}={}){
 const value=env.LOCALAPPDATA;
 if(typeof value!=="string"||!/^[A-Za-z]:\\/.test(value)||/["\x00-\x1f]/.test(value))return null;
 try{const real=realpath(value);return /^[A-Za-z]:\\/.test(real)?real:null;}catch{return null;}
}
/** Every ancestor below a main-owned private control root is checked in place. */
export function ensureRemoteControlDirectory(control){
 const parent=path.dirname(control),anchor=path.dirname(parent);
 // Windows: the anchor is Murage's own folder in local app data (see
 // remoteControlDirectory), made on first use. POSIX anchors are never made.
 if(!posix())makeDirectory(anchor);
 const base=lstatSync(anchor);if(!base.isDirectory()||base.isSymbolicLink()||!owned(base)||(posix()&&(base.mode&0o022))||!canonical(anchor))throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");
 for(const directory of [parent,control]){makeDirectory(directory);const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||!owned(stat)||!privateMode(stat)||!canonical(directory))throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");}
 return control;
}
export function remoteWorkDirectory(control,remoteRef,revision,platform){
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(remoteRef)||!Number.isSafeInteger(revision)||revision<0)throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");
 const inspect=directory=>{const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||!owned(stat)||!privateMode(stat)||!canonical(directory))throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");};
 ensureRemoteControlDirectory(control);inspect(control);let directory=control;
 for(const segment of ["remote",remoteRef,String(revision)]){directory=path.join(directory,segment);makeDirectory(directory,{restrict:segment==="remote",platform});inspect(directory);}
 return directory;
}
/** The owner-only "remote" folder itself, for SSH material on Windows: one
 * level above every destination's work tree, so its paths stay well inside
 * the 260 characters OpenSSH for Windows can open (see BackupResticOptions.sshDirectory). */
export function remoteSshDirectory(control,platform){
 ensureRemoteControlDirectory(control);
 const directory=path.join(control,"remote");makeDirectory(directory,{restrict:true,platform});
 const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||!owned(stat)||!privateMode(stat)||!canonical(directory))throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");
 return directory;
}
/** Windows: makes the owner-only "remote" folder ahead of time with the
 * asynchronous ACL tools, from main's async startup. Every work tree and the
 * SSH folder live under it and inherit its ACL, so once it exists the
 * synchronous remoteWorkDirectory/remoteSshDirectory only check folders and
 * never start icacls or PowerShell in Electron's main process, which froze the
 * window (see backup-windows-acl.mjs runAsync). A folder whose lock-down fails
 * is removed again while still empty. POSIX: nothing to do. */
export async function prepareRemoteFolder(control,{platform=process.platform,restrict=restrictToOwnerAsync}={}){
 if(platform!=="win32")return null;
 ensureRemoteControlDirectory(control);
 const directory=path.join(control,"remote");
 let created=false;try{mkdirSync(directory,{mode:0o700});created=true;}catch(error){if(error.code!=="EEXIST")throw error;}
 if(created){try{await restrict(directory,{directory:true});}catch(error){try{rmdirSync(directory);}catch{/* reported below */}throw error;}}
 const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||!canonical(directory))throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");
 return directory;
}
/** Removes one destination's whole private work tree after its settings are
 * gone. The path is built from the checked reference, never from a caller path. */
export function forgetRemoteWorkDirectory(control,remoteRef){
 if(typeof remoteRef!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(remoteRef))throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");
 ensureRemoteControlDirectory(control);
 const parent=path.join(control,"remote"),directory=path.join(parent,remoteRef);
 if(path.dirname(directory)!==parent||!directory.startsWith(control+path.sep))throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");
 let stat;try{stat=lstatSync(directory);}catch(error){if(error.code==="ENOENT")return false;throw error;}
 if(!stat.isDirectory()||stat.isSymbolicLink()||!owned(stat))throw Error("BACKUP_REMOTE_REVIEW_REQUIRED");
 rmSync(directory,{recursive:true,force:true});return true;
}
/** The folder that holds Murage's data folder, when other accounts can change
 * it: off-site keys and journals would sit beside it, so they are refused.
 * Null when it is private (or on Windows, where the tree is ACL-protected). */
export function remoteControlSharedFolder(control){
 if(!posix())return null;
 const anchor=path.dirname(path.dirname(control));
 try{const stat=lstatSync(anchor);return !stat.isDirectory()||stat.isSymbolicLink()||!owned(stat)||(stat.mode&0o022)?anchor:null;}catch{return anchor;}
}
