// A same-origin link that answers Content-Disposition: attachment (a
// transcript export). A task named args.name is made on the throwaway host
// first, so the saved file has a name no one else's file has; the script
// reports that name.
const bots = await (await fetch("/api/bots")).json();
const bot = (Array.isArray(bots) ? bots : bots.bots)[0];
const made = await fetch(`/api/bots/${bot.id}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: args.name }) });
const { task } = await made.json();
const href = `/api/threads/${task.threadId ?? task.id}/export`;
const reply = await fetch(href);
await reply.arrayBuffer();
const disposition = reply.headers.get("content-disposition") || "";
return { created: made.status, status: reply.status, href, filename: (/filename="([^"]+)"/.exec(disposition) || [])[1] || null };
