import { fixtureBotFolder } from "./bot-folder-fixture.ts";
import { memoryExtractionMessages } from "../memory/extract.ts";

/** Supply the same bot context to learning calls made through connection fixtures. */
export function fixtureLearningBot<T extends import("../contracts.ts").ProviderInstance>(instance: T): T {
  const extract = instance.extractMemory?.bind(instance);
  const ground = instance.groundMemory?.bind(instance);
  const check = instance.checkReply?.bind(instance);
  if (extract) instance.extractMemory = (text, maximum, signal, dispatch) => extract(text, maximum, signal,
    { policyRevision: "fixture", messages: memoryExtractionMessages(text), ...dispatch, cwd: dispatch?.cwd ?? fixtureBotFolder() });
  if (ground) instance.groundMemory = (input, maximum, signal, fence, cwd) => ground(input, maximum, signal, fence, cwd ?? fixtureBotFolder());
  if (check) instance.checkReply = (signal, cwd) => check(signal, cwd ?? fixtureBotFolder());
  return instance;
}
