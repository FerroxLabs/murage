# Sable silent-failure handoff check

Date: 2026-09-07. Source: `e9320c2b` in `/Volumes/Mando/WaylandBots/murage-astra`.
Input read in full: `/Users/seandonahoe/.sable/HANDOFF-murage-silent-failures.md`.
Contract: compare exactly the three claims with current source and existing evidence;
no implementation changes, fresh test runs, live browser interaction, or user-data mutations.
Relevant inspected implementation files were clean against HEAD.

| Claim | Verdict | Current evidence and remaining limit |
|---|---|---|
| `browser_click` reports success without activating its target | **Known cause fixed in source; installed-app outcome unverified here.** | `electron/browser-surface.cjs:2301` restores device emulation in `finally` after screenshot success or failure; `:1365` maps page coordinates to the native presentation scale. The exact file's latest change is `f5c004e1`, `fix(browser): restore viewport after screenshots`. Click resolves and checks the hit target before sending down/up events (`:2001`), then returns an observation, not a business-operation completion guarantee. Existing `.planning/STATE.md:810` records 85 focused/native passes, including trusted link/button activation after repeated screenshots at 287x115, 400x250 and 1280x800. The actual-host fixture checks activation counts, target IDs and trusted events (`electron/fixtures/browser-click-after-screenshot.cjs:36`, `:50`, `:60`); its Darwin test wrapper is `electron/browser-click-after-screenshot.electron.test.mjs:7`. These are stronger than a mocked success response. They do not prove Zoom deletion, explain every historical Zoom navigation, or establish which binary Sable used. |
| Viewport collapses to roughly 287x115 and no resize recovery exists | **The reported collapse has the same implemented fix; no resize tool remains, by design of the current fixed viewport.** | The surface declares a 1280x800 page viewport (`electron/browser-surface.cjs:60`) and fits it to compact/expanded bounds with `enableDeviceEmulation` (`:1507`, `:1524`). The screenshot reset above prevents page metrics collapsing to panel bounds while pointer mapping retains an old scale. The native regression checks actual `innerWidth=1280` / `innerHeight=800` after normal, repeated and deliberately failed captures (`electron/fixtures/browser-click-after-screenshot.cjs:37`, `:47`). Its screenshot output remains 1024x640, which is distinct from the page viewport. `server/drivers/browser-proxy.ts:223` onward exposes click/fill/press but no resize operation. Lack of a resize tool is accurate; the stronger claim that there is no implemented prevention/recovery is stale against this source. Installed-app adoption and a fresh reproduction are not established by this read-only check. |
| Team-lead assignment never checks `agentsMcp` and never warns | **Overstated for current UI; incomplete enforcement remains in source.** | `src/components/SettingsPanel.tsx:372` resolves the bot's current instance and reads `agentsMcp === true`; it passes the result into `BotRoleControl` at `:504`. `src/components/BotRoleControl.tsx:116` / `:123` disable new Chief/team-lead choices when incapable; `:170` explains the block and `:176` warns for existing incapable leaders. Sidebar also reads the capability (`src/components/Sidebar.tsx:816`), but its promotion guard only covers `role === "member"` (`:904`), leaving the `individual` promotion branch ungated (`:891`). Server PATCH validates role shape/tier/exclusivity (`server/index.ts:9417`, `:9435`, `:9448`) and Chief conflicts (`:9537`), then persists/elects (`:9557`, `:9560`) without checking the selected instance's `agentsMcp`. Turn-time integration is still capability-gated (`:3457`, `:4304`). Thus a server-authoritative role admission check is absent, although the handoff's blanket claim of no UI gate or warning is false. This is source evidence, not a new runtime reproduction. A declared capability also cannot prove a healthy MCP handshake; Finch's transient incident is not explained by the assignment gap alone. |

## Evidence boundaries and disposition

- The browser pass count above is explicitly an existing execution-record result,
  not a test rerun in this check. `.planning/STATE.md:813` also records that the
  installed 0.1.46 was unchanged at that point. No current installed-process identity
  was inspected, so this report does not label Sable's runtime as definitely stale.
- Existing browser unit coverage includes coordinate scaling and click sequencing
  (`electron/browser-surface.test.mjs:776`, `:793`, `:838`) and press behavior
  (`:1287`). The screenshot-specific actual-host regression exercises clicks and
  metrics, not fill/press on those same refs. Preserve previous passes; do not claim
  that exact additional combined scenario was executed from source presence alone.
- No current runtime observation supplied with a source/binary identity supersedes
  the recorded browser passes. A continuing live failure needs a bounded, isolated
  reproduction against the running build before declaring a regression.
- Role enforcement is a concrete follow-up candidate: cover every promotion entry
  and validate the effective live instance on the server. No fix is authorized by
  this read-only comparison, and no new general audit was started.
