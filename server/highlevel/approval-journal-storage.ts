/** Internal platform plumbing; the frozen ApprovalJournal API stays unchanged. */
import { execFileSync } from "node:child_process";
import { closeSync, fsyncSync, openSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import { platform } from "node:os";
import { requireWindowsAddon } from "../engine-exclusion.ts";

const guidance = "Use the app data folder on a local NTFS (Windows), APFS (macOS), or durable Linux filesystem; FAT/exFAT and network storage cannot hold approval records.";
export function journalStorageError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith("HighLevel approval journal")) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  const unsupported = ["ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(code ?? "");
  return new Error(`HighLevel approval journal ${unsupported ? "storage is unsupported" : "could not commit or verify storage"}. ${guidance} If this is already local storage, check free space, permissions and disk health before retrying.`, { cause: error });
}
function unsupported(): never { throw new Error(`HighLevel approval journal storage is unsupported. ${guidance}`); }

export function assertJournalStorage(directory: string): void {
  try {
    const host = platform();
    if (host === "win32") {
      // libuv's Windows statfs type is zero. The native helper resolves the
      // containing volume, including mounted volumes and mapped drives.
      const volume = requireWindowsAddon().driveInfo?.(realpathSync(directory));
      // Fixed or removable local NTFS only. Unknown/missing evidence refuses.
      if (!volume || volume.format !== "NTFS" || !["Fixed", "Removable"].includes(volume.type)) unsupported();
    } else if (host === "darwin") {
      // Darwin's numeric filesystem types are dynamically assigned. mount(8)
      // exposes both the name and MNT_LOCAL; longest resolved mount wins.
      const path = realpathSync(directory);
      const mounts = execFileSync("/sbin/mount", [], { encoding: "utf8", timeout: 15000 }).split("\n")
        .map(line => /^.* on (.*) \(([^)]*)\)$/.exec(line))
        .filter((m): m is RegExpExecArray => !!m && (path === m[1] || path.startsWith(m[1] === "/" ? "/" : `${m[1]}/`)))
        .sort((a, b) => b[1].length - a[1].length);
      const attributes = mounts[0]?.[2].split(",").map(value => value.trim()) ?? [];
      if (!attributes.includes("local") || /^(msdos|exfat|smbfs|nfs|webdav)$/i.test(attributes[0] ?? "")) unsupported();
    } else {
      const type = Number(statfsSync(directory).type) >>> 0;
      // FAT, exFAT, NFS, SMB/CIFS/SMB2, 9P, Ceph, AFS, Coda, NCP and tmpfs.
      // Other local filesystems must still supply hard links and fsync; failure
      // of either primitive is surfaced, never downgraded to a weaker write.
      if ([0x4d44, 0x2011bab0, 0x6969, 0x517b, 0xff534d42, 0xfe534d42,
        0x01021997, 0x00c36400, 0x5346414f, 0x73757245, 0x564c, 0x9fa0, 0x01021994].includes(type)) unsupported();
      // FUSE can serve local disks or remote data. Resolve its actual subtype
      // from mountinfo rather than treating every FUSE disk as unsupported.
      if (host === "linux" && type === 0x65735546) {
        const path = realpathSync(directory);
        const mounts = readFileSync("/proc/self/mountinfo", "utf8").split("\n").map(line => {
          const [fields, filesystem] = line.split(" - ");
          const mount = fields.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
          return { mount, type: filesystem?.split(" ")[0] };
        }).filter(m => m.mount && (path === m.mount || path.startsWith(m.mount === "/" ? "/" : `${m.mount}/`)))
          .sort((a, b) => b.mount.length - a.mount.length);
        if (/^fuse\.(sshfs|rclone|s3fs|gcsfuse|glusterfs|ceph|davfs|curlftpfs|smbnetfs)$/.test(mounts[0]?.type ?? "")) unsupported();
      }
    }
  } catch (error) { throw journalStorageError(error); }
}

/** Node 24's libuv uses F_FULLFSYNC -> F_BARRIERFSYNC -> fsync on Darwin,
 * FlushFileBuffers on Windows, and fsync on Linux. No native addon is needed. */
export function syncJournalFile(fd: number): void { fsyncSync(fd); }
export function syncJournalDirectory(directory: string): void {
  if (platform() === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Also barriers a visible entry on replay: a prior publisher may have died
 * after the link but before its final barrier. Windows needs write access for
 * FlushFileBuffers; r+ never truncates the immutable entry. */
export function syncJournalEntry(path: string, directory: string): void {
  const fd = openSync(path, "r+");
  try { syncJournalFile(fd); } finally { closeSync(fd); }
  syncJournalDirectory(directory);
}
