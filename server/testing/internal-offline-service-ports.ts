// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: sc-safety-rd (isolated desktop service configuration).
// Owner: index.ts service owners (service implementation and admission policy).
import { DATA_DIR } from "../config.ts";
import { recoverSignalPark, type ParkVerdict } from "../channels/signal/park.ts";
import { bootSignalRuntime } from "../channels/signal/boot.ts";
import signalRuntimePin from "../channels/signal/runtime-pin.json" with { type: "json" };
import type { RuntimePin } from "../channels/signal/types.ts";
import { indexSourceData } from "./internal-source-data.ts";
import type { InternalPortContext } from "./internal-port-context.ts";
import type { StatePort } from "./source-extract.ts";

/** Defaults which production itself admits before an optional service starts.
 * These fixtures describe an isolated desktop without network credentials,
 * browser extensions, phone devices, a Cloud supervisor or calendar service.
 * A case exercising a service supplies the real service or its explicit I/O
 * edge. Required policy objects are deliberately absent from this registry.
 * No constructor or initializer is evaluated from index.ts source.
 */
export function offlineInternalServicePorts(context?: InternalPortContext): StatePort[] {
  const root=context?.dataDir??DATA_DIR;
  let park:ParkVerdict|undefined;
  const verdict=()=>park??=recoverSignalPark(root);

  const absent = [
    ["slack", "Production declares the optional Slack service without an initializer."],
    ["discord", "Production declares the optional Discord service without an initializer."],
    ["slackBinding", "No Slack account or service has been linked in this isolated installation."],
    ["discordBinding", "No Discord account or service has been linked in this isolated installation."],
    ["whatsapp", "Production declares the optional WhatsApp service without an initializer."],
    ["whatsappBinding", "No WhatsApp account or service has been linked in this isolated installation."],
    ["signal", "Production declares the optional Signal service before wiring an account; the real custody/runtime gates below remain active."],
    ["signalBinding", "No Signal account has been linked and no binding capability has been minted."],
    ["signalHost", "No Signal child process host has been started in this isolated installation."],
    ["signalReadyToken", "No Signal readiness capability exists before the real service has completed startup."],
    ["procedureReviews", "Production declares its optional procedure-review host before service wiring."],
    ["browserExtension", "The isolated desktop has no installed browser-extension integration."],
    ["browserSetup", "The browser setup workflow has not been opened; production initializes this lazily."],
    ["phoneRegistryOnce", "No phone device has been configured; production initializes the registry lazily."],
    ["utilityParentPort", "The fixture is an ordinary desktop Node process without an Electron or Cloud parent port."],
    ["cloudBrowserProfileUsage", "Production leaves Cloud profile usage absent in desktop mode."],
    ["cloudEmailSignin", "The optional Cloud email sign-in workflow has not been started."],
    ["homeExecutionGate", "Production has no Home execution gate in desktop mode because no Home session exists."],
  ] as const;
  const unopened = [
    ["routines", "Production declares the routine manager null before runtime wiring; positive cases supply the real manager."],
    ["phoneCallService", "Production starts with no phone call service and creates it lazily."],
    ["calendarCalls", "Production starts with no calendar call manager before service wiring."],
  ] as const;
  return [
    {name:"signalParkVerdict",fresh:verdict,reason:"Actual Signal custody recovery protocol against the case's private data directory."},
    {name:"signalCustodyHeld",fresh:()=>indexSourceData("signalCustodyHeld",verdict()),reason:"Derived only from the actual custody recovery verdict; no bypass boolean."},
    {name:"signalAuthorityReplayHeld",fresh:()=>indexSourceData("signalAuthorityReplayHeld",verdict()),reason:"Actual recovery verdict controls pending authority replacement replay."},
    {name:"signalBoot",fresh:()=>verdict().state==="ready"?bootSignalRuntime({
      pin:signalRuntimePin as RuntimePin,moduleUrl:new URL("../index.ts",import.meta.url).href,
      // An isolated installation has no packaged Signal runtime. The real
      // adapter loader validates evidence and returns its own closed adapters.
      resourcesPath:root,platform:process.platform,arch:process.arch,
    }):null,reason:"Real bootSignalRuntime and evidence verification; no child process or network starts."},
    ...absent.map(([name, reason]) => ({ name, fresh: () => undefined, reason })),
    ...unopened.map(([name, reason]) => ({ name, fresh: () => null, reason })),
  ];
}
