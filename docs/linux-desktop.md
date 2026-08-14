# Ubuntu Desktop

OpenMausBot has an Ubuntu 24.04 LTS x86_64 desktop beta. The Electron package embeds the harness server, so
installed builds do not require Node, pnpm, Swift, or a terminal at runtime. For giving a bot the same kind
of Linux desktop on your own server instead of this machine, see [byo-vps.md](byo-vps.md).

## What works

- The native Electron window and embedded OpenMausBot server on GNOME Xorg and GNOME Wayland.
- Local Claude, Codex, Grok, Gemini, and other configured agent CLIs.
- Chat, streaming turns, approvals, bot-to-bot communication, and local data storage.
- Composio connected apps and Box cloud computers.
- External documentation and OAuth links in the default browser.
- An explicit, view-only local screen preview on GNOME Xorg and GNOME Wayland. The Wayland path uses the
  native portal chooser and keeps the selected PipeWire stream open until the user stops sharing.
- An explicit local-computer control beta on GNOME/Xorg and guarded GNOME/Wayland with user-installed Cua
  Driver 0.19.3 and an approval-capable Claude or ACP provider.

The local preview does **not** give the bot control of this computer by itself. Local control is a separate,
off-by-default beta. Bundled CUA, Linux dictation, and ARM64 remain unavailable and fail closed; follow their
progress in [issue #29](https://github.com/milind-soni/OpenMausBot/issues/29). Xorg is tracked in
[issue #79](https://github.com/milind-soni/OpenMausBot/issues/79), and guarded GNOME/Wayland support in
[issue #109](https://github.com/milind-soni/OpenMausBot/issues/109).

## Build packages

Requirements for building from source:

- Ubuntu 24.04 LTS x86_64
- Node.js 24 or newer
- pnpm 10.33.0 (Corepack can install the version declared by the project)

```sh
git clone https://github.com/milind-soni/OpenMausBot.git
cd OpenMausBot
corepack enable
pnpm install --frozen-lockfile
pnpm package:linux
```

The build creates:

- `release/OpenMausBot-<version>-amd64.deb`
- `release/OpenMausBot-<version>-x86_64.AppImage`

The AppImage uses a static runtime and does not require the legacy `libfuse2` package.

## Install and run

Install the Debian package with APT so its desktop dependencies are resolved:

```sh
sudo apt install ./release/OpenMausBot-*-amd64.deb
```

Then open **OpenMausBot** from the GNOME application launcher. To remove it:

```sh
sudo apt remove openmausbot
```

The portable AppImage does not install system files:

```sh
chmod +x release/OpenMausBot-*-x86_64.AppImage
./release/OpenMausBot-*-x86_64.AppImage
```

Application data remains local in `~/.openmausbot`. Electron browser data and window state use the normal XDG
configuration directory (`~/.config/openmausbot` unless the environment overrides it).

## Develop the desktop shell

Development mode uses three processes. Keep each command running in its own terminal:

```sh
pnpm dev:server
pnpm dev
pnpm dev:desktop
```

For a package-shaped build without creating `.deb` or AppImage artifacts:

```sh
pnpm package:linux:dir
./release/linux-unpacked/openmausbot
```

## Agent CLI discovery

Applications launched from GNOME do not inherit the same interactive shell `PATH` as a terminal. OpenMausBot
keeps the inherited path and adds existing common locations such as:

- `~/.local/bin`
- `~/.claude/local`
- `~/.volta/bin`
- `~/.bun/bin`
- `~/.asdf/shims`
- `~/.deno/bin`
- `~/.nvm/versions/node/*/bin`
- `/usr/local/bin`

It also probes the login shell in the background. If a CLI still is not detected, set an explicit additional
path before launching the app from a terminal and verify it there:

```sh
OMB_EXTRA_PATH=/your/custom/bin ./release/OpenMausBot-*-x86_64.AppImage
```

Restart OpenMausBot after installing or signing in to a CLI.

## Xorg and Wayland

The shell, chat, cloud computers, connected apps, and preview-only capture work in both GNOME session types.
The Wayland chooser/select/persistent-stream/cancel/end/retry lifecycle has been validated in a real Ubuntu
24.04 GNOME Wayland session. OpenMausBot detects Wayland before XWayland when both `WAYLAND_DISPLAY` and
`DISPLAY` exist, so capture cannot accidentally bypass portal-mediated behavior.

Open the Computer panel and use the separate **Preview this computer** card. Capture never starts when the app
or panel opens.

- **Xorg:** **Start preview** captures the primary monitor directly.
- **Wayland:** **Choose a screen** opens the GNOME portal chooser once. The selected stream stays open until
  you press **Stop preview**, close the panel, end sharing from GNOME, or quit the app.

Cancelling or ending Wayland sharing returns to a calm **Try again** state and never reopens the chooser
automatically. OpenMausBot does not capture screen audio, remember the selected monitor after restart, or
offer an **Open Settings** action on Linux.

Local computer control is a separate opt-in. On Wayland, OpenMausBot recognizes only GNOME/Mutter and requires
the certified Cua health report to pass AT-SPI, portal capture, and the portal/libei input backend with verified
WinRects target activation. Other Wayland compositors remain unavailable. XWayland's `DISPLAY` never bypasses
these checks.

## Enable local control

This beta deliberately uses a user-installed driver. OpenMausBot does not bundle, download, update, or stop a
global Cua daemon. The certified contract is **Cua Driver 0.19.3**, manifest schema `1`, on Ubuntu 24.04 x64
GNOME/Xorg or GNOME/Wayland. OpenMausBot owns a separate private daemon only after the user enables the beta.

Install Cua Driver from its [official installation guide](https://cua.ai/docs/how-to-guides/driver/install):

```sh
CUA_DRIVER_RS_VERSION=0.19.3 /bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
cua-driver --version
cua-driver manifest --pretty
cua-driver doctor --json
```

Confirm the version is `0.19.3`. OpenMausBot also rejects an executable or containing directory that another
local user could replace. Ubuntu's normal user-private group layout is accepted after OpenMausBot verifies that
the group belongs only to your account. On a shared or centrally managed group, the app may ask you to remove
group write access from the exact user-owned install directories:

```sh
driver_path="$(readlink -f "$(command -v cua-driver)")"
case "$driver_path" in
  "$HOME"/.cua-driver/packages/releases/0.19.3-*/cua-driver) ;;
  *) echo "Unexpected Cua Driver path: $driver_path" >&2; exit 1 ;;
esac
chmod go-w "$HOME/.local/bin" "$HOME/.cua-driver" "$HOME/.cua-driver/packages" \
  "$HOME/.cua-driver/packages/releases" "$(dirname "$driver_path")"
```

For GNOME/Wayland, install the versioned helper shipped with that same verified Cua release:

```sh
~/.cua-driver/packages/current/wayland-helper/install.sh
```

Sign out and back in once, then verify that GNOME loaded exactly the expected helper:

```sh
gnome-extensions info winrects@cua
```

The output must include `Version: 8`, `Enabled: Yes`, and `State: ACTIVE`. OpenMausBot never installs or enables
this GNOME extension silently. The helper exposes window identity, geometry, capture, cursor, and verified target
activation to Cua; foreground pointer or keyboard delivery remains scoped by GNOME's Remote Desktop portal and
may ask for session consent.

Then:

1. Open a bot's **Computer** panel.
2. In **Local control**, choose **Enable local control (Beta)** and review the warning.
3. Wait until the card shows **Ready**, including the verified driver path and version.
4. Select **This computer** for that bot. Enabling the global capability never assigns a bot automatically.

Linux **Auto** never falls back to the user's desktop. **This computer** is available only when the current
provider advertises an interactive approval channel. Claude `bypassPermissions`, ACP full-auto, Codex's current
app-server adapter, non-GNOME/headless sessions, missing diagnostics, and stale/crashed runtimes fail closed.

OpenMausBot starts one private embedded daemon with a private socket for its own app generation. It never touches
Cua's default/global daemon. On GNOME/Wayland, the app also rechecks the prompt-free health contract while the
runtime is active and revokes readiness if the helper or backend disappears. Disabling local control or quitting
stops the owned daemon and active proxies.

The driver uses Cua's `standard` permission mode. Cua routine actions are promptless at the driver layer, while
OpenMausBot requires its own **Allow** or **Deny** decision before every local action. Bot Auto mode, persistent
**Always allow** grants, and cloud-computer approvals cannot authorize the local desktop in this beta.

Cua Driver has content-free telemetry and an update check enabled by default. OpenMausBot disables the update
check only for children it starts and does not change the user's persisted telemetry preference. Review or change
that preference with the [official telemetry documentation](https://cua.ai/docs/reference/cua-driver/telemetry).

## Validate a package change

```sh
pnpm typecheck
pnpm test
pnpm check:electron
pnpm package:linux
node scripts/verify-linux-package.mjs
pnpm smoke:linux-package
```

The verifier checks `.deb` metadata, desktop identity, resources, artifact permissions, and that no Cua executable
was bundled. The smoke test launches the unpacked production app without `--no-sandbox`, validates the
renderer/preload and embedded health endpoint, then uses a fake user-installed driver to prove diagnostics,
private-daemon readiness, crash invalidation, explicit retry, and clean shutdown in separate Xorg and simulated
GNOME/Wayland contract lanes. The Wayland lane also requires the opt-in environment and certified health report.
Its wrapper isolates the temporary D-Bus/AT-SPI runtime so it cannot replace the live desktop session's
accessibility socket. It is not a substitute for real GNOME Xorg or GNOME Wayland action evidence.

## Troubleshooting

### An agent CLI is missing

Run the CLI directly in a terminal, finish its sign-in flow, then restart OpenMausBot. If it lives outside the
common directories above, use `OMB_EXTRA_PATH` while testing and report the install location so it can be
considered for automatic discovery.

### A bot needs computer tools

Choose **Cloud box** and add a Box token in App Settings, or complete the local-control opt-in above on a supported
GNOME session. A missing driver/helper, unsupported compositor or provider keeps **This computer** disabled with
an explanation.

### Local control is not ready

Run the certified probes in a terminal launched inside the same GNOME session:

```sh
echo "$XDG_SESSION_TYPE"  # x11 or wayland
cua-driver --version      # must be 0.19.3 for this beta
cua-driver doctor --json
```

On Wayland, also run:

```sh
echo "$XDG_CURRENT_DESKTOP"  # must include GNOME
gnome-extensions info winrects@cua
CUA_DRIVER_RS_ENABLE_WAYLAND=1 cua-driver doctor --json
```

If the helper is installed but not `ACTIVE`, sign out and back in once. If the app reports a portal error, confirm
that `xdg-desktop-portal` and `xdg-desktop-portal-gnome` are running in the user session. OpenMausBot's readiness
probe never opens a consent prompt; GNOME may prompt when the first approved foreground input action starts.

Repair any display, session bus, or AT-SPI diagnostic before choosing **Try again**. If the path shown in the app
is unexpected, close OpenMausBot and launch it with an absolute `CUA_DRIVER_PATH`. An invalid explicit override
fails without silently selecting another executable. For `unsafe-driver-permissions`, use the bounded
permission-hardening commands in **Enable local control**; do not make the driver executable or its
directories world-writable.

### Screen preview does not start

On Xorg, confirm the session has an active display with `echo "$XDG_SESSION_TYPE"`; it should print `x11`.
On Wayland, confirm `xdg-desktop-portal` and the GNOME portal backend are running, then click **Try again** to
open a new chooser. Cancelling or stopping sharing never causes an automatic second prompt.

### The AppImage does not start

Confirm the executable bit and architecture:

```sh
chmod +x OpenMausBot-*-x86_64.AppImage
file OpenMausBot-*-x86_64.AppImage
```

Run it from a terminal once to collect the startup output. Do not install `libfuse2` just for this AppImage; the
package is built with the static runtime.
