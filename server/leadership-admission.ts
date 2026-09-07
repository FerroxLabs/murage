/** Admission checks declared delegation support, not remote login or a future
 * MCP handshake. Existing leaders can still be demoted when an engine is down. */
export function leadershipAdmissionError(instance: {
  displayName?: string; enabled?: boolean;
  adapter: { capabilities: { agentsMcp?: boolean } };
} | null | undefined, instanceId: string): string | null {
  if (instance && instance.enabled !== false && instance.adapter.capabilities.agentsMcp === true) return null;
  return `Engine ${instance?.displayName || instanceId || "not configured"} cannot coordinate bots. Choose an enabled engine with Murage delegation support before assigning a leadership role.`;
}
