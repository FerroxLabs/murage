# Signal park/restore English inventory

New English copy introduced by SIGPARK-DESIGN-AGREED-r3.1. This inventory
collects the existing implementation copy without changing it.

Shared preservation copy is rendered in Signal Settings. The downgrade CLI
prints `SIGNAL_DOWNGRADE_KEPT` from the shared module and composes a refusal
from one stage prefix plus one reason sentence in `park-downgrade.ts`.
The startup disk limitation is a warning. Internal hold diagnostics are
included at the end so every new English diagnostic can be reviewed here.
Repeated sentences are listed at each source that owns a literal. Existing
`Show folder`, `Connect Signal`, and phone-removal controls are reused.

| Source | Exact English string |
| --- | --- |
| `shared/signal-kept-copy.ts` | Signal may still be running on this computer. Quit Murage, wait a minute, and open it again. If this stays, restart your computer. |
| `shared/signal-kept-copy.ts` | Murage cannot check whether an earlier Signal process has stopped on this computer. Your Signal files are kept. Keep Signal paused until Murage can check. |
| `shared/signal-kept-copy.ts` | Murage kept your Signal files and is finishing disconnecting the earlier link here. Open Murage again to finish before linking Signal again. |
| `shared/signal-kept-copy.ts` | Murage cannot confirm this choice is saved on this disk. Your Signal files are kept. Open Murage again before linking Signal. |
| `shared/signal-kept-copy.ts` | Murage kept the earlier Signal files. You can link Signal again. Also remove the older Murage entry under Linked devices in Signal on your phone. |
| `shared/signal-kept-copy.ts` | Murage paused Signal to keep your connection safe. It found Signal files in two places and kept both. Nothing was removed. |
| `shared/signal-kept-copy.ts` | Murage paused Signal to keep your connection safe. It could not account for all the Signal files in your data folder. The files it found are still there. |
| `shared/signal-kept-copy.ts` | Your Signal connection is kept inside your Murage data folder while you use the older version. When you update Murage, it checks these files before using Signal again. If you remove Murage from Linked devices on your phone, Murage asks you to link again. |
| `server/channels/signal/park-downgrade.ts` | Murage stopped after moving some Signal files. The files are kept in your data folder. |
| `server/channels/signal/park-downgrade.ts` | Murage saved the recovery details. No Signal files were moved. |
| `server/channels/signal/park-downgrade.ts` | No Signal files were moved. |
| `server/channels/signal/park-downgrade.ts` | Signal may still be running on this computer. Quit Murage, wait a minute, and open it again. If this stays, restart your computer. |
| `server/channels/signal/park-downgrade.ts` | Murage cannot check whether an earlier Signal process has stopped on this computer. Your Signal files are kept. Keep Signal paused until Murage can check. |
| `server/channels/signal/park-downgrade.ts` | The Signal files span two disks. Keep this data folder on one disk before trying again. |
| `server/channels/signal/park-downgrade.ts` | Murage could not confirm the last step was saved to disk. Run this step again. |
| `server/channels/signal/park-downgrade.ts` | The Signal files changed during this step. Open this version of Murage and check Signal in Settings. |
| `server/channels/signal/park-downgrade.ts` | Murage could not account for all the Signal files. Open this version of Murage and check Signal in Settings. |
| `server/channels/signal/park-downgrade.ts` | Murage could not check the Signal files safely. Open this version of Murage and check Signal in Settings. |
| `src/components/SignalSettings.tsx` | Keep both and link again |
| `src/components/SignalSettings.tsx` | Murage paused Signal to keep your connection safe. |
| `src/components/SignalSettings.tsx` | Murage also kept an earlier Signal link in your data folder. In Signal on your phone, open Settings, Linked devices and remove the older Murage entry. |
| `src/components/SignalSettings.tsx` | Murage kept the earlier Signal files in your data folder. To use Signal here, link it again. Then remove the older Murage entry under Linked devices in Signal on your phone. |
| `src/components/SignalSettings.tsx` | Murage also kept earlier Signal files in your data folder. |
| `server/index.ts` | Signal files are kept. This disk cannot confirm directory updates after power loss. |
| `server/index.ts` | Signal hold is unavailable |
| `server/index.ts` | Signal authority is held |
| `server/channels/signal/park-authority.ts` | Signal authority save is held |
| `server/channels/signal/service.ts; server/channels/signal/kept-hold.ts` | Signal files are kept |
