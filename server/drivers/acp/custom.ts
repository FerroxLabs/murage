// Bring-your-own engine: any agent CLI that speaks ACP over stdio plugs in
// as an instance of this driver — no code, one config entry:
//
//   { "instances": { "my-agent": {
//       "driver": "customAcp",
//       "displayName": "My Agent",
//       "config": { "cli": "my-agent acp" } } } }
//
// The `cli` string carries the whole command (wrapper strings resolve via
// splitCliString, so "npx -y some-agent acp" works too). There is no auth
// story on purpose: the user's CLI is expected to be signed in from a
// terminal already. Models and thinking choices come from an empty ACP session.
// Model selection uses ACP, never an assumed argv convention.
import { resolveCustomAcpModels } from "./custom-model-catalog.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const CONFIGURE_HINT =
  'a custom ACP engine needs its command: add "config": { "cli": "<your-agent> acp" } to this instance in config.json, or use Settings, Models & engines, Choose location…';

const support: AcpSupport = {
  driverKind: "customAcp",
  displayName: "Custom (ACP)",
  access: "custom",
  // One passthrough id: the agent runs whatever it is configured for.
  // Advertising a made-up catalog would promise switching we cannot do.
  models: { default: "agent-default", options: [{ id: "agent-default", label: "Agent default", custom: true }] },
  resolveModels: (env, config) => resolveCustomAcpModels(env, config),
  resolveModelsOnCreate: false,
  selectModel: { configId: "model", agentDefault: "agent-default", allowLegacy: true },
  modelVariants: true,
  defaultCli: "",
  nativeSource: "custom.acp",
  loginNote: CONFIGURE_HINT,
  // Mode-entering args ride the cli string itself ("fx acp"), so nothing
  // extra here.
  spawnArgs: () => [],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
};

const base = createAcpDriver(support);

export const CustomAcpDriver: typeof base = {
  ...base,
  // decodeAcpConfig never throws (a missing cli falls back to defaultCli,
  // which is empty here). Turn every blank-command path into the same
  // teaching shadow row instead of a bare spawn ENOENT at first send.
  decodeConfig(raw) {
    const decoded = base.decodeConfig(raw);
    if (!decoded.cli.trim()) throw new Error(CONFIGURE_HINT);
    return decoded;
  },
  async create(input) {
    if (!input.config.cli.trim()) throw new Error(CONFIGURE_HINT);
    return base.create(input);
  },
};
