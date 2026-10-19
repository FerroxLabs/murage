// SPDX-License-Identifier: AGPL-3.0-or-later
// A mirror or sync that deletes (Astra r5 Critical on 3eb5d30c4): its
// destination is a recursive delete and always asks on a home, root or
// system folder, an unknown value or an expansion, as `rm -rf` does. A
// delete-sync into a project or temp folder stays ordinary. Fixture strings
// are inert data, never executed.
import { describe, expect, it, vi } from "vitest";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const { alwaysAskCommand } = await import("./always-ask.ts");

type Row = [cmd: string, rule: string | null];

/** Each of these is ordinary on 3eb5d30c4. */
const CATASTROPHIC: Row[] = [
  // rsync, every delete spelling
  ["rsync -a --delete /tmp/empty/ ~/", "delete-home"],
  ["rsync -a --delete /tmp/empty/ /home/tester", "delete-home"],
  ["rsync -a --delete-after empty/ /", "delete-root"],
  ["rsync -a --del empty/ /usr", "delete-system-folder"],
  ["rsync -a --delete-excluded empty/ /etc/", "delete-system-folder"],
  ["rsync -a --delete-before --delete-excluded empty/ /Library", "delete-system-folder"],
  ["rsync -av --delete -e ssh empty/ ~", "delete-home"],
  ["rsync -a empty/ ~ --delete", "delete-home"],
  ["rsync -a --exclude .git --delete empty/ /", "delete-root"],
  ["sudo rsync -a --delete /tmp/empty/ /var/", "delete-system-folder"],
  ["cd ~ && rsync -a --delete /tmp/empty/ .", "delete-home"],
  ["rsync -a --remove-source-files ~/ /backup/", "delete-home"],
  ["bash -c 'rsync -a --delete empty/ ~'", "delete-home"],
  ["rsync -a --delete empty/ $HOME", "delete-home"],
  // rclone
  ["rclone sync /tmp/empty ~", "delete-home"],
  ["rclone sync --config r.conf empty /", "delete-root"],
  ["rclone --config r.conf sync empty /usr", "delete-system-folder"],
  ["rclone sync remote:empty /home/tester -P", "delete-home"],
  ["rclone purge ~", "delete-home"],
  ["rclone delete /etc", "delete-system-folder"],
  ["rclone bisync ~ remote:bak", "delete-home"],
  // robocopy, as cmd, PowerShell and Git Bash spell it
  ["robocopy C:\\empty C:\\Users\\sean /MIR", "delete-home"],
  ["robocopy C:\\empty C:\\ /MIR", "delete-root"],
  ["robocopy C:\\empty C:\\Windows /PURGE", "delete-system-folder"],
  ["robocopy.exe C:/empty C:/Users/alex //MIR", "delete-home"],
  ["cmd /c robocopy C:\\empty C:\\Users\\sean /MIR /R:1", "delete-home"],
  ["powershell -Command \"robocopy C:\\empty 'C:\\Program Files' /mir\"", "delete-system-folder"],
  // unison: a sync propagates deletes into both roots
  ["unison /tmp/empty ~ -batch", "delete-home"],
  ["unison ~ /tmp/empty -batch -auto", "delete-home"],
  ["unison -batch -root /tmp/empty -root /", "delete-root"],
  // the cloud CLIs' delete-sync onto a local folder
  ["aws s3 sync s3://empty ~ --delete", "delete-home"],
  ["aws --profile p s3 sync --delete s3://empty /etc", "delete-system-folder"],
  ["gsutil -m rsync -d -r gs://empty ~", "delete-home"],
  ["gsutil rsync -rd gs://empty /", "delete-root"],
  ["gcloud storage rsync --delete-unmatched-destination-objects --recursive gs://empty ~", "delete-home"],
  ["azcopy sync https://a.blob.core.windows.net/empty ~ --delete-destination=true", "delete-home"],
  ["azcopy sync https://a.blob.core.windows.net/empty /usr --delete-destination true", "delete-system-folder"],
  ["mc mirror --remove --overwrite play/empty ~", "delete-home"],
  ["mc rm --recursive --force ~", "delete-home"],
  // a tool's local backend names a local path (Astra r5b)
  ["rclone sync /tmp/empty :local:/home/tester", "delete-home"],
  ["rclone sync /tmp/empty :local,nounc=true:/", "delete-root"],
  ["rclone purge :local:/usr", "delete-system-folder"],
  ["gsutil rsync -d -r gs://empty file:///home/tester", "delete-home"],
  // rimraf and its runners: a recursive delete of every path (Astra r5b)
  ["rimraf /home/tester", "delete-home"],
  ["rimraf --no-preserve-root /", "delete-root"],
  ["npx rimraf ~", "delete-home"],
  ["npx -y rimraf@5 /etc", "delete-system-folder"],
  ["pnpm dlx rimraf ~/", "delete-home"],
  ["bunx rimraf /usr", "delete-system-folder"],
  ["npx.cmd rimraf C:/Users/alex", "delete-home"],
];

/** A value or expansion as the destination: the reader cannot see it, so it asks. */
const EXPANDED: Row[] = [
  ["rclone sync remote:x \"$DIR\"", "unreadable"],
  ["rclone purge $X", "unreadable"],
  ["rclone sync remote:x $(pwd)", "unreadable"],
  ["unison /tmp/a \"$TARGET\" -batch", "unreadable"],
  ["aws s3 sync s3://b \"$OUT\" --delete", "unreadable"],
  ["gsutil rsync -d -r gs://b $DEST", "unreadable"],
  ["azcopy sync https://a/b \"$D\" --delete-destination=true", "unreadable"],
  ["mc mirror --remove play/b \"$D\"", "unreadable"],
  ["rclone sync remote:x /*", "delete-root"],
  ["rclone sync remote:x /Users/*", "delete-system-folder"],
  ["rclone sync $SRC ./site", "unreadable"],
  ["npx rimraf \"$OUT\"", "unreadable"],
  ["rimraf $DIR/", "unknown-target"],
];

/** The same tools, where nothing catastrophic is deleted: ordinary. */
const ORDINARY: Row[] = [
  ["rsync -a --delete dist/ ./public/", null],
  ["rsync -a --delete build/ ~/project/site/", null],
  ["rsync -a --delete src/ /tmp/mirror/", null],
  // A+: a home or drive literal under a program off the read-only list asks
  ["rsync -av --delete -e ssh ~/ host:backup/", "protected-path"],
  // A+: a home or drive literal under a program off the read-only list asks
  ["rsync -a --delete --exclude node_modules ~/ /Volumes/Backup/home/", "protected-path"],
  // A+: a home or drive literal under a program off the read-only list asks
  ["rsync -a ~/ /tmp/x/", "protected-path"],
  ["rsync -a --delete-after ./out/ deploy@host:/var/www/", null],
  // A+: a home or drive literal under a program off the read-only list asks
  ["rsync -a --remove-source-files ./inbox/ ~/", "protected-path"],
  ["rclone sync remote:site ./site", null],
  // A+: a home or drive literal under a program off the read-only list asks
  ["rclone sync ~/ remote:backup", "protected-path"],
  ["rclone sync remote:x /tmp/x", null],
  // A+: a home or drive literal under a program off the read-only list asks
  ["rclone copy remote:x ~", "protected-path"],
  ["rclone purge remote:old-bucket", null],
  ["robocopy C:\\src C:\\Users\\sean\\project /MIR", null],
  // A+: a home or drive literal under a program off the read-only list asks
  ["robocopy C:\\Users\\sean D:\\backup /MIR", "protected-path"],
  // A+: a home or drive literal under a program off the read-only list asks
  ["robocopy C:\\src C:\\Users\\sean /E", "protected-path"],
  ["unison ./a /tmp/b -batch", null],
  ["unison ~/project /tmp/mirror -batch", null],
  ["aws s3 sync s3://site ./public --delete", null],
  // A+: a home or drive literal under a program off the read-only list asks
  ["aws s3 sync ~ s3://backup --delete", "protected-path"],
  // A+: a home or drive literal under a program off the read-only list asks
  ["aws s3 sync s3://b ~", "protected-path"],
  // A+: a home or drive literal under a program off the read-only list asks
  ["gsutil rsync -r gs://b ~", "protected-path"],
  ["gsutil -m rsync -d -r ./site gs://b", null],
  ["gcloud storage rsync --delete-unmatched-destination-objects ./site gs://b", null],
  // A+: a home or drive literal under a program off the read-only list asks
  ["azcopy sync https://a/b ~ --delete-destination=false", "protected-path"],
  ["azcopy sync ./site https://a/b --delete-destination=true", null],
  ["mc mirror --remove ./site play/b", null],
  // A+: a home or drive literal under a program off the read-only list asks
  ["mc mirror play/b ~", "protected-path"],
  ["mc rm --recursive --force play/b/old", null],
  ["rclone sync remote:x :local:/tmp/x", null],
  ["rimraf dist node_modules/.cache", null],
  ["npx rimraf ./build", null],
  ["pnpm exec rimraf coverage", null],
];

describe("always-ask: a mirror that deletes is a recursive delete of its destination", () => {
  for (const [cmd, rule] of [...CATASTROPHIC, ...EXPANDED, ...ORDINARY]) {
    it(cmd, () => {
      expect(alwaysAskCommand(cmd)?.rule ?? null).toBe(rule);
    });
  }
});
