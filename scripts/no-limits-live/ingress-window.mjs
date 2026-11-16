// Capture every existing task boundary before ingress can choose its thread.
// A new task starts empty; an existing task must retain its own durable cursor.
export async function captureIngressWindow(client, bot) {
  const before=(await client.api('GET',`/api/bots/${bot.id}`)).bot;
  if(!Array.isArray(before?.tasks))throw Error('ingress task inventory missing');
  const ids=[...new Set([bot.threadId,...before.tasks.map(task=>task.threadId)])];
  const windows=new Map(await Promise.all(ids.map(async id=>[id,await client.beginMessageWindow(id)])));
  const window={...windows.get(bot.threadId)};
  return {window, async select(threadId){
    const current=(await client.api('GET',`/api/bots/${bot.id}`)).bot;
    if(!current?.tasks?.some(task=>task.threadId===threadId))throw Error('ingress thread is not owned by the fixture bot');
    client.messageWindows.set(bot.threadId,{...(windows.get(bot.threadId)??{afterId:null})});
    window.afterId=windows.get(threadId)?.afterId??null;
    bot.threadId=threadId;client.messageWindows.set(threadId,window);
  }};
}
