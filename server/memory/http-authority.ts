import { installClaimVerifier } from '../decision/index.ts';
import type { InternalCapabilities, InternalCapability } from '../internal-capabilities.ts';
import { memoryAgentRoute } from './routes.ts';
import type { ServiceAuthority } from './service-approval.ts';

/** The HTTP capability proves the source generation, never its permission level
 * or owner status. The decision registry independently resolves those facts. */
export function memoryHttpAuthority(registry: InternalCapabilities, capability: InternalCapability): ServiceAuthority {
  if (capability.kind !== 'memory' || !registry.isActive(capability)) throw new Error('MEMORY_UNAUTHORIZED');
  const proof = Object.freeze({kind:'memory-http',botId:capability.botId,threadId:capability.threadId,generation:capability.generation});
  const issue = installClaimVerifier(reference => reference === proof && registry.isActive(capability) ? proof : undefined);
  const claim = issue(proof);
  if (!claim) throw new Error('MEMORY_UNAUTHORIZED');
  return {claim,proof,identity:{threadId:capability.threadId,generation:capability.generation}};
}

/** Keep the authenticated HTTP entry inseparable from claim registration; an
 * omitted options field must not silently send an owner save down BASE. */
export function authenticatedMemoryAgentRoute(registry: InternalCapabilities, capability: InternalCapability, ...args: Parameters<typeof memoryAgentRoute>) {
  const [path,body,access,bridge,handles,extractor,options] = args;
  if (access.botId !== capability.botId || access.threadId !== capability.threadId || access.generation !== capability.generation) throw new Error('MEMORY_UNAUTHORIZED');
  const authority = /\/(?:save|propose-correction)$/.test(path) ? memoryHttpAuthority(registry,capability) : options?.authority;
  return memoryAgentRoute(path,body,access,bridge,handles,extractor,{...options,authority});
}
