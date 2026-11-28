// SPDX-License-Identifier: AGPL-3.0-or-later
// Test-process-only preload for a spawned server child (node --import <this file>): server/bedrock-launch.ts gets
// ./bedrock-identity-offline.ts in place of ./bedrock-identity.ts, so IDENTITY answers offline (no STS call). Nothing else is redirected.
import { register } from "node:module";
const shim = new URL("./bedrock-identity-offline.ts", import.meta.url).href;
register("data:text/javascript," + encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier === "./bedrock-identity.ts" && context.parentURL && context.parentURL.endsWith("/server/bedrock-launch.ts")) return { url: ${JSON.stringify(shim)}, shortCircuit: true };
  return next(specifier, context);
}`));
