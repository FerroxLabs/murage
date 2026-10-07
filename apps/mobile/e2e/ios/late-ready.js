// P19's guard: a ready() that arrives after signOut() must not sign this
// computer in (put it back on the list). Run on the door's /enter page, where
// the shell has not yet had a ready() for this load.
const calls = [window.murageNative.signOut(), window.murageNative.ready()];
const settled = await Promise.allSettled(calls);
return settled.map((result) => (result.status === "fulfilled" ? "ok" : "rejected " + result.reason.message));
