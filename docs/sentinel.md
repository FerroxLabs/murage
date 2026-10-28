# Health checks (Sentinel)

Murage 1.0.9 adds a small background helper that keeps an eye on how Murage is doing: backups, engine turns, routines,
storage and the app's own health records. When something needs your attention, Murage tells you once, in plain words,
and keeps a short list in Settings. This page explains what runs, what it reads, and how to remove it.

## What it does

- Every 2 minutes (plus a few seconds of spread) it reads a fixed set of health records that Murage writes for it.
- It keeps its own short notes about what it has already told you, so the same thing is never reported twice.
- When something new needs a look, Murage shows one notification titled "Murage": "A health check needs your attention.
  Open Health to see it." The details are in Murage itself, never in the notification.
- It works while Murage is closed. When Murage starts again, it picks up the list where the helper left it.

## What it reads, and what it never reads

It reads only the `health` folder inside your Murage data folder. That folder holds counts and state names (for example
"backup finished" or "3 engine turns stopped early"). It holds no messages, no memory, no file names, no keys and no
sign-in details.

The helper has no network access and makes no requests. It sends nothing anywhere. It never opens your conversations or
the live database, and it never changes anything in your data folder.

The `health` folder is left out of backups on purpose. Your own data is backed up exactly as before.

## Where it lives

The helper is part of the Murage app. Each Murage installation gets its own id (derived from the data folder location),
so two installations on one computer never share notes.

| System | How it starts | Its own notes |
|---|---|---|
| macOS | LaunchAgent `com.ferroxlabs.murage.sentinel.<id>` in `~/Library/LaunchAgents` | `~/Library/Application Support/MurageSentinel/<id>` |
| Windows | Task Scheduler task `\FerroxLabs\Murage\Sentinel\<id>` (runs at sign-in, repeats every 2 minutes, current user only) | `%LOCALAPPDATA%\MurageSentinel\<id>` |
| Linux | systemd user timer `murage-sentinel-<id>.timer`; without a user session manager, a sign-in autostart entry `murage-sentinel-<id>.desktop` | `$XDG_STATE_HOME/MurageSentinel/<id>` (or `~/.local/state/...`) |
| Murage Cloud | `murage-sentinel.timer` on the Cloud computer | `/var/lib/murage-sentinel` |

The notes folder sits outside your data folder and is readable by your user account only.

On a self-hosted box, `murage start` runs the helper next to Murage. It keeps running if Murage itself stops
unexpectedly, and stops when you stop `murage start`. Each start hands over to a fresh helper; the previous one steps
down by itself within a few minutes.

Murage registers the helper itself, a minute after it starts, and checks that it really ran before calling it ready. If
the system refuses the registration, Murage keeps working normally, runs the checks itself while it is open, and tries
the registration again later. Closing Murage leaves the helper in place; it is light and runs at background
priority.

On Windows the scheduled task starts `Murage.exe` with a fixed set of arguments. The app checks that the helper file it
is asked to run is the exact one it installed (by its fingerprint) before running it, and runs it with no window.

## Limits it keeps

- At most 16 files and 2 MiB read per check, at most 250 ms of processor time and 128 MiB of memory.
- At most 16 MiB for its own notes, and at most 32 MiB written in any 24 hours.
- One check at a time. After sleep it runs one check, never a backlog of missed ones.

## Updating

When Murage updates, the new app copies its helper next to the old one, points the registration at it, and checks that
it ran. If the new one does not report in within about half an hour of awake time, Murage switches back to the previous
helper and tries again on the next update.

## Removing it

To remove it by hand, use only the names for your installation id:

- macOS: `launchctl bootout gui/$(id -u)/com.ferroxlabs.murage.sentinel.<id>`, then delete the plist and the notes
  folder listed above.
- Windows: `schtasks /Delete /TN "\FerroxLabs\Murage\Sentinel\<id>" /F`, then delete the notes folder.
- Linux: `systemctl --user disable --now murage-sentinel-<id>.timer`, delete the two unit files from
  `~/.config/systemd/user`, any `murage-sentinel-<id>.desktop` in `~/.config/autostart`, and the notes folder.

Removing the helper does not touch your Murage data. If Murage is still installed, it registers the helper again on its
next start.

## For Murage Cloud operators

The Cloud image installs `murage-sentinel.service` and `murage-sentinel.timer`. The service:

- runs as the `murage` account, never as root, with no added privileges;
- has no network (`PrivateNetwork=yes`, `RestrictAddressFamilies=AF_UNIX`, `IPAddressDeny=any`) and no container
  socket;
- sees only `/data/home/health`, read-only, through a private view of `/data`;
- writes only its own state folder `/var/lib/murage-sentinel` (`MURAGE_SENTINEL_STATE_DIR`, which the home server reads
  too, so Health on the home shows what the helper found);
- runs once per timer tick at the lowest processor and disk priority, with a 60 second limit and a 256 MiB memory
  ceiling.

The public health endpoint is unchanged: it still reports only that the home is up. Backups of the home leave out the
health files, their token key and the notification ledger (`backup-excludes.txt`); they are made again on the home.

## Diagnostics

The diagnostics report has a "Health checks" section with state names and counts only: whether the helper is
registered and proven, when it last reported in, and how many items are open. It never includes paths, names or text
from your data.
