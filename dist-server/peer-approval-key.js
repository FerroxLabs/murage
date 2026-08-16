/** Stable persisted grant for one peer action and one target bot. */
export function peerAllowKey(action, targetId) {
    return `${action}:${targetId}`;
}
