// What the computer answers this WebView's cookie jar: the door's status for
// the app's own page, with the session cookie if the jar still holds one.
const reply = await fetch("/", { credentials: "same-origin", cache: "no-store", redirect: "manual" });
return { status: reply.status, path: location.pathname };
