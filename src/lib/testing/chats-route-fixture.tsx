import { createRoot } from "react-dom/client";
import { AllChatsView } from "@/components/AllChatsPage";
import { useChatResource, type HitsPage } from "@/lib/chat-previews";
import { NO_CHATS, foldChatHits } from "@/lib/all-chats";
import { chatsGenHello } from "@/lib/chats-gen";
import { api } from "@/state/store";
const noop=()=>{};
function App() {
  const held=useChatResource<HitsPage>("/api/search?view=chats&group_by=thread&q=routepreview&limit=1");
  return <AllChatsView bots={[]} groups={[]} filters={{}} onFilters={noop} query="routepreview" onQuery={noop}
    held={NO_CHATS} listGen={held.listGen} loading={null} failed={null}
    hitRows={held.data ? foldChatHits(held.data.hits,{},()=>({})) : null} searchingMessages={held.loading} hitsPartial={held.data?.partial === true} hitsFailed={null}
    onOpenRow={noop} onOpenHit={()=>{(window as any).opened=((window as any).opened??0)+1;}} onLoadMore={noop} onClose={noop} />;
}
void api("/api/chats").then(page=>{chatsGenHello(page.gen);createRoot(document.getElementById("root")!).render(<App />);});
