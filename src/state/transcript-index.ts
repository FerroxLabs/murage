// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Message } from "./store";
import { onArrayChange, appendArrayItem, arrayChange, prepareArray, putPosition, TranscriptMap, type PositionTree } from "../lib/persistent-array";
import { isOpenIntakeCard } from "../lib/onboarding-intake";
type IndexedMessage = { message: Message; position: number };
interface Index {
  byId: TranscriptMap<IndexedMessage>;
  versions: TranscriptMap<Message[]>;
  screens: IndexedMessage[];
  intake: PositionTree<Message>;
}
const cache = new WeakMap<Message[], Index>();
function add(index: Index, message: Message, position: number): Index {
  let versions = index.versions;
  if (message.role === "user" && message.kind === "text") {
    const key = message.parentId ?? "";
    const prior = versions.get(key) ?? [];
    const updated = appendArrayItem(prior, message);
    const last = prior.at(-1);
    const outOfOrder = last && (last.at > message.at || (last.at === message.at && (index.byId.get(last.id)?.position ?? -1) > position));
    versions = versions.set(key, outOfOrder ? [...updated].sort((a, b) => {
      const positionOf = (row: Message) => row === message ? position : index.byId.get(row.id)!.position;
      return a.at - b.at || positionOf(a) - positionOf(b);
    }) : updated);
  }
  const row = { message, position };
  let screens = index.screens;
  if (message.kind === "screen" && message.png) {
    screens = [...screens, row];
    if ((index.screens.at(-1)?.position ?? -1) > position) screens.sort((a, b) => a.position - b.position);
  }
  const intake = isOpenIntakeCard(message) ? putPosition(index.intake, position, message) : index.intake;
  return { byId: index.byId.set(message.id, row), versions, screens, intake };
}
export function transcriptIndex(messages: Message[]): Index {
  const held = cache.get(messages);
  if (held) return held;
  const change = arrayChange(messages);
  const prior = change && cache.get(change.previous);
  let index: Index;
  if (change && prior && change.index === change.previous.length) index = add(prior, change.value, change.index);
  else if (change && prior && change.index < change.previous.length) {
    const old = change.previous[change.index]!;
    let versions = prior.versions;
    if (old.role === "user" && old.kind === "text") versions = versions.set(old.parentId ?? "", (versions.get(old.parentId ?? "") ?? []).filter(row => row.id !== old.id));
    const reduced = {
      ...prior,
      versions,
      screens: old.kind === "screen" && old.png ? prior.screens.filter(row => row.position !== change.index) : prior.screens,
      intake: isOpenIntakeCard(old) ? putPosition(prior.intake, change.index, undefined) : prior.intake,
    };
    index = add(reduced, change.value, change.index);
  } else {
    prepareArray(messages);
    index = { byId: new TranscriptMap(), versions: new TranscriptMap(), screens: [], intake: [] };
    for (let i = 0; i < messages.length; i++) index = add(index, messages[i]!, i);
  }
  cache.set(messages, index);
  return index;
}

onArrayChange<Message>((before, after) => { if (cache.has(before)) transcriptIndex(after); });
