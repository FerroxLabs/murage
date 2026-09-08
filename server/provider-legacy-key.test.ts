import { afterEach,expect,it,vi } from "vitest";
import { OpenAICompatDriver } from "./drivers/openai-compat.ts";
afterEach(()=>vi.unstubAllGlobals());
it("blocks the actual legacy OpenAI-key to default OpenRouter catalog and generation path",async()=>{
 const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
 const instance=await OpenAICompatDriver.create({instanceId:"fixture",displayName:"Legacy",enabled:true,config:{url:"https://openrouter.ai/api/v1",apiKeyEnv:"FIXTURE_KEY"},environment:{FIXTURE_KEY:"sk-proj-FAKE_KEY_NOT_SENT"}});
 try{expect(await instance.snapshot()).toMatchObject({state:"unavailable",reason:expect.stringContaining("does not match")});await instance.refreshModels?.();expect(fetcher).not.toHaveBeenCalled();await expect(instance.adapter.sendTurn({threadId:"fixture-thread",text:"not executed",model:"gpt-5-test"})).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();}finally{await instance.dispose();}
});
