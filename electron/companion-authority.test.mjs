import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { packagedGepaManifestEnvironment } from "./harness-resources.mjs";
import { launchSecretVia } from "./launch-secret.mjs";

it("the real main-process launch blocks share one fresh private token without mutating ambient env", async () => {
  const source = readFileSync(new URL("./main.mjs",import.meta.url),"utf8");
  const declaration = source.match(/^const companionToken = .*;$/m)?.[0];
  expect(declaration).toBeTruthy();
  const providerDeclaration = source.match(/^const modelProviderCommitToken = .*;$/m)?.[0];
  expect(providerDeclaration).toBeTruthy();
  // The link routes' own commit token is one more declaration the launch block reads.
  const mcpDeclaration = source.match(/^const mcpCommitToken = .*;$/m)?.[0];
  expect(mcpDeclaration).toBeTruthy();
  const optionsStart = source.indexOf("function companionLaunchOptions(");
  const optionsEnd = source.indexOf("function ensureManagedCompanionConnector",optionsStart);
  const serverStart = source.indexOf("async function startServerOn(port) {");
  const serverEnd = source.indexOf('  slog(`fork ${entry} port=${port}`)',serverStart);
  expect(Math.min(optionsStart,optionsEnd,serverStart,serverEnd)).toBeGreaterThan(0);
  // Execute the actual environment/option construction, replacing Electron
  // and credential storage. No GUI, utility process, or network is started.
  // startServerOn awaits the port check (electron/port-availability.mjs), so
  // the extracted body runs in an async function with the port reported free.
  const AsyncFunction = (async () => {}).constructor;
  const launch = new AsyncFunction("randomBytes","process","path","app","packagedGepaManifestEnvironment","launchSecretVia",`
    const portAvailable=async()=>true;
    const SERVER_PORT=8799;
    const remoteAccessLaunch=()=>null, slog=()=>{};
    const secureCredentials={}, credentialStoreUnavailable=false;
    const restoredConnections=null,restoredHarnessEnvironment=env=>env;
    const desktopDataDir="/fixture/canonical-installation";
    const desktopDataOwner={utilityServerLeaseEnvironment:()=>({MURAGE_INTERNAL_DATA_DIR_LEASE:"private-lease-fixture"})};
    const assertDesktopStartupActive=()=>{}, desktopMark=()=>{}, compileCacheEnvironment=()=>({});
    const composioBrokerUrl=()=>null;
    // The FluxRouter-hosted broker and the Worker cut-off are release
    // constants read through app.isPackaged; off here, like the Worker URL.
    const fluxComposioBrokerUrlValue=()=>"", composioLegacyUntilValue=()=>0;
    const managedComposioChildEnvironment=(_url,_credentials,env)=>env;
    const harnessResourceEnvironment=()=>({}), workspaceCredentialEnv=()=>({});
    ${declaration}
    ${providerDeclaration}
    ${mcpDeclaration}
    ${source.slice(optionsStart,optionsEnd)}
    const env=await (async (port)=>{${source.slice(source.indexOf("{",serverStart)+1,serverEnd)}return childEnv;})(8799);
    return {env,options:companionLaunchOptions()};
  `);
  const ambient = {MURAGE_COMPANION_TOKEN:"untrusted-ambient-value"};
  const process = {env:ambient,resourcesPath:"/fixture/resources"};
  // The real GEPA manifest pin helper: an unpackaged launch publishes an empty pin.
  const invoke = () => launch(randomBytes,process,{join:(...parts)=>parts.join("/")},{isPackaged:false,getPath:()=>"/fixture/user-data",getAppPath:()=>"/fixture/app",getVersion:()=>"1.0.0-fixture"},packagedGepaManifestEnvironment,launchSecretVia);
  const first = await invoke();
  const second = await invoke();
  // The token reaches the harness over the private parent port, never the
  // environment, an argument or a file (audit P1, S1b R8).
  expect(first.env.MURAGE_COMPANION_TOKEN).toBeUndefined();
  expect(first.env.MURAGE_COMPANION_TOKEN_FILE).toBeUndefined();
  expect(first.env.MURAGE_COMPANION_TOKEN_VIA).toBe("parent");
  const firstToken = first.options.companionToken;
  const secondToken = second.options.companionToken;
  expect(JSON.stringify(first.env)).not.toContain(firstToken);
  expect(firstToken).toMatch(/^[a-f0-9]{64}$/);
  expect(first.env.MURAGE_MODEL_PROVIDER_COMMIT_TOKEN).toMatch(/^[a-f0-9]{64}$/);
  expect(second.env.MURAGE_MODEL_PROVIDER_COMMIT_TOKEN).not.toBe(first.env.MURAGE_MODEL_PROVIDER_COMMIT_TOKEN);
  expect(first.env.MURAGE_INTERNAL_DATA_DIR_LEASE).toBe("private-lease-fixture");
  expect(first.env.MURAGE_DATA_DIR).toBe("/fixture/canonical-installation");
  expect(first.env.MURAGE_GEPA_MANIFEST_SHA256).toBe("");
  expect(first.options.MURAGE_INTERNAL_DATA_DIR_LEASE).toBeUndefined();
  expect(secondToken).not.toBe(firstToken);
  expect(ambient).toEqual({MURAGE_COMPANION_TOKEN:"untrusted-ambient-value"});
});

it("the real companion child environment overrides inherited device state for a restored profile", () => {
  const source = readFileSync(new URL("./companion.mjs", import.meta.url), "utf8");
  const start = source.indexOf("  const childEnvironment = { ...process.env };");
  const end = source.indexOf("  let child;", start);
  expect(start).toBeGreaterThan(0);
  const build = new Function("process", "connectionStorage", `
    const launchSecretVia=(name,transport)=>({[name+"_VIA"]:transport});
    const companionToken="fresh-private-token",hostedUrl=null,allocatedOrigin={socketPath:"/owned/private.sock"};
    ${source.slice(start,end)}; return childEnvironment;
  `);
  const ambient = { MURAGE_COMPANION_DIR: "/old/device-bindings", MURAGE_INTERNAL_DATA_DIR_LEASE: "private-parent" };
  expect(build({env:ambient}, {stateDirectory:"/restored/new-bindings"})).toMatchObject({MURAGE_COMPANION_DIR:"/restored/new-bindings"});
  expect(ambient.MURAGE_COMPANION_DIR).toBe("/old/device-bindings");
});
