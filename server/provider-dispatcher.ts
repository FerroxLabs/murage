// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The dispatcher for requests to model and image providers. Node's fetch
// otherwise ends a response whose headers or next bytes take longer than
// 300 seconds (undici's headersTimeout and bodyTimeout): a fixed silence cut
// under the owner's setting. A local model reading a long prompt, or a
// buffered image render, was stopped at five minutes and told the connection
// dropped. Silence is judged by the thread's watch, whose stop aborts the
// request; each caller keeps its own ceiling where it has one.
import { Agent, EnvHttpProxyAgent, type Dispatcher } from "undici";

const NO_TRANSPORT_CLOCK = { headersTimeout: 0, bodyTimeout: 0 } as const;
let direct: Agent | undefined;
let viaEnvProxy: EnvHttpProxyAgent | undefined;

/** Node's fetch honours HTTP(S)_PROXY and NO_PROXY only when told to
 * (NODE_USE_ENV_PROXY or --use-env-proxy); an explicit dispatcher replaces
 * that default, so it follows the same switch. */
const envProxyOn = (): boolean => {
  const flag = process.env.NODE_USE_ENV_PROXY?.trim().toLowerCase();
  return (flag !== undefined && flag !== "" && flag !== "0" && flag !== "false") || process.execArgv.includes("--use-env-proxy");
};

export function providerDispatcher(): Dispatcher {
  if (envProxyOn()) return (viaEnvProxy ??= new EnvHttpProxyAgent(NO_TRANSPORT_CLOCK));
  return (direct ??= new Agent(NO_TRANSPORT_CLOCK));
}
