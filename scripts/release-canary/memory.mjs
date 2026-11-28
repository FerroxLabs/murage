const DISPATCH = /(?:^|\s)turn dispatch recall=(\S+) thread=(\S+)\s*$/;
const FENCE = /\[memory\] fence recovery tier=\d+ thread=(\S+) refused=\S+ parts=\S+ omitted=\d+ cause=checking\s*$/;
const CONTINUATION = /(?:^|\s)memory continuation kept thread=(\S+) engine=\S+ reason=checking:/;

// Use the slice for this turn so later dispatches on the same thread cannot satisfy its check.
export function checkTurnMemory(log, { thread, reply, recallCode, checking, outcome }) {
  if (typeof log !== "string" || typeof thread !== "string" || !thread) {
    return { thread: thread ?? null, dispatch: null, fence_checking: false, reason: "MEMORY_STUCK" };
  }
  const dispatches = [];
  let fence_checking = false;
  let continuationChecking = false;
  for (const line of log.split(/\r?\n/)) {
    const dispatch = DISPATCH.exec(line);
    if (dispatch?.[2] === thread) dispatches.push(dispatch[1]);
    if (FENCE.exec(line)?.[1] === thread) fence_checking = true;
    if (CONTINUATION.exec(line)?.[1] === thread) continuationChecking = true;
  }
  const dispatch = dispatches.length === 1 ? dispatches[0] : null;
  const stuck = fence_checking || continuationChecking ||
    ((dispatches.length > 0 || reply != null) && dispatch !== "full") ||
    (checking && (outcome === "refused" || outcome === "stopped"));
  let reason = null;
  if (stuck) reason = "MEMORY_STUCK";
  else if (recallCode !== undefined && reply !== recallCode) reason = "TOKEN_MISSING";
  return { thread, dispatch, fence_checking, reason };
}
