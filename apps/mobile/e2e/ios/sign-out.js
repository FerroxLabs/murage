// Only the native sign-out, not the web UI's DELETE /session/device first: the
// computer still counts this device, so a 401 afterwards means the app's own
// cookie is gone, not that the computer revoked it.
window.murageNative.signOut().catch(() => {});
return "signing out";
