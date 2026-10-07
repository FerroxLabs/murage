# Windows browser transport source

This non-UAC Win32 helper has been compiled and exercised on Windows in isolated native and branded-browser fixtures. Missing `murage-browser-host.exe` fails closed. This is not a signed-installer or supported-release claim.

Build only on an authorized Windows x64 machine with existing Visual Studio C++ tools and Windows SDK:

```
pnpm build:browser-extension-windows
```

The output is `dist-native/browser-extension/win32-x64/murage-browser-host.exe`. The existing browser-extension resources rule ships this architecture directory. No compiler installation, Cargo invocation, service installation, or live registration is part of the build script.

## Boundary

`--broker PIPE PARENT_PID` verifies the actual parent and same user SID, creates the unpredictable pipe with a protected current-user/SYSTEM DACL, verifies that DACL by handle, rejects remote clients, and verifies connected client SID. The first instance uses `FILE_FLAG_FIRST_PIPE_INSTANCE`. At most 16 connected channels are accepted. The helper does not interpret browser commands or receive a master credential; JavaScript retains its existing challenge/HMAC and JSON frame validation.

`--mkdir PATH`, `--read PATH`, and `--write PATH` pin non-reparse directory handles, require protected exact current-user/SYSTEM ACLs for private storage, and avoid credentials in arguments. Writes read one length-prefixed payload from stdin (maximum 1 MiB), create a private temporary file, flush, and replace the owned destination. The read operation returns bytes from the verified open file handle. Existing broad-access directories are refused, not silently changed.

The browser launcher is a task/app-owned copy of this executable in a private directory. `createWindowsBrowserLauncher` writes its adjacent `.launch` file containing three UTF-8 lines: Electron executable, bundled host entry, and active config path. Browser launch executes Electron with `ELECTRON_RUN_AS_NODE=1` and an explicit stdio handle list. It does not invoke a shell. The `.launch` file contains paths, not token material. The app uses an owned stable config alias for clean restarts. Crash-stale alias recovery requires matching private instance and lease provenance plus definite dead-endpoint evidence. The Windows recovery check set passed six cases; an earlier zero-winner contention failure was not reproduced and remains unexplained. Installed automatic update repair remains unqualified.

`--register BROWSER HOST_NAME MANIFEST` and `--unregister BROWSER HOST_NAME MANIFEST` derive only the current user's exact approved browser/host registry key, and refuse an existing different default value. Their JS adapter validates the complete approved key against that browser, requires the manifest name to equal the host-name suffix, and passes that same validated host name to native code. Unique test hosts remain distinct from the production host. Windows fixtures exercise these operations under unique test host names. Brave uses the Chromium registry family; Chrome retains its Google Chrome family.

## Internal multiplex protocol

Every message is little-endian `uint32 bodyLength`, `uint32 channelId`, `uint8 kind`, then up to 65,536 payload bytes. Body length is 5–65,541. Native output kinds: 1 open, 2 bytes, 3 close, 4 ready (channel 0), 5 unavailable. JS input kinds: 1 bytes, 2 close. Payload bytes carry the unchanged native JSON framing and HMAC protocol. JS limits each incoming channel and shared outgoing buffering to 2 MiB and destroys an overflowing connection without replay. Channel identifiers are allocated by the helper, never supplied by the extension.

## Evidence and remaining gate

Mac-hosted tests exercise the JS adapter with a fake native child, binary chunk/framing limits, channel separation, private data in stdin, missing-helper refusal, and the build command recipe. Unix broker/service/client regressions are separate evidence. Static source assertions verify that the required Win32 calls are present; they do not establish native ACL behavior.

The full acceptance checklist distinguishes proved checks from remaining cases: protected file/pipe DACL readback, other-user and remote denial, reparse refusal, broad-ACL refusal, pipe precreation refusal, peer SID verification, fragmented/full-duplex framing, backpressure and parent/helper loss, owned-only HKCU install/removal, browser-launched executable, Electron-as-Node startup, and explicit Stop across reconnection. Use temporary user-owned directories/keys, fake credentials, and no real browser profiles. Native qualification must not be inferred from the source/mock checks.

Windows receipts in `artifacts/browser-extension/windows-native-20260926-102417`, `windows-electron-20260926-105733` and `windows-brave-20260926-110503` record native fixture and real Chrome/Edge/Brave startup through Electron 43.4.0, local navigation, snapshot, screenshot and Stop. Source SHA-256: `6813c37b1d3dd8996e76d077ed0a9c3b19ee1179f17c428283273b6be7d52cc8`. Helper SHA-256: `b910f70d0d0fbee451a9a924496df4e8b2a33edce16c4d42321a5aba50dd3668`. Independent other-user/remote-peer execution and signed installer lifecycle are not established by these receipts.
