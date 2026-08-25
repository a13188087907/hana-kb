import test from "node:test";
import assert from "node:assert/strict";

const tools = [
  ["../tools/kb-create.js", "kb-create"],
  ["../tools/kb-ingest.js", "kb-ingest"],
  ["../tools/kb-search.js", "kb-search"],
  ["../tools/kb-list.js", "kb-list"],
  ["../tools/kb-delete-doc.js", "kb-delete-doc"],
];

test("all M1 tools expose the Hana static tool contract", async () => {
  for (const [modulePath, name] of tools) {
    const tool = await import(modulePath);
    assert.equal(tool.name, name);
    assert.equal(typeof tool.description, "string");
    assert.equal(typeof tool.parameters, "object");
    assert.equal(typeof tool.execute, "function");
    assert.ok(tool.sessionPermission);
  }
});
