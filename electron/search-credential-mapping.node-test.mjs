import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKSPACE_CREDENTIALS } from "./workspace-credentials.mjs";

test("actual desktop search credential mapping preserves provider selection", () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const mapping = source.match(/const CREDENTIAL_PATCH = (\{[\s\S]*?\n\});/);
  assert.ok(mapping);
  const handlers = runInNewContext(`(${mapping[1]})`);
  for (const [name, field, env] of [["tavilySearchApiKey", "tavilyApiKey", "MURAGE_TAVILY_SEARCH_KEY"], ["exaSearchApiKey", "exaApiKey", "MURAGE_EXA_SEARCH_KEY"]]) {
    assert.deepEqual(JSON.parse(JSON.stringify(handlers[name]("fake-search-key"))), { webSearch: { [field]: "fake-search-key" } });
    assert.deepEqual(WORKSPACE_CREDENTIALS.find(item => item.name === name), { section: "webSearch", field, name, env });
    assert.deepEqual(JSON.parse(JSON.stringify(handlers[name](""))), { webSearch: { [field]: "" } });
  }
});
