import test from "node:test";
import assert from "node:assert/strict";

const tools = [
  ["../tools/kb-update-config.js", "kb-update-config"],
  ["../tools/kb-delete-library.js", "kb-delete-library"],
  ["../tools/kb-doc-list.js", "kb-doc-list"],
  ["../tools/kb-graph-data.js", "kb-graph-data"],
  ["../tools/kb-rebuild-library.js", "kb-rebuild-library"],
];

test("all M3 tools expose the Hana static tool contract", async () => {
  for (const [file, name] of tools) {
    const tool = await import(file);
    assert.equal(tool.name, name);
    assert.equal(typeof tool.description, "string");
    assert.equal(typeof tool.parameters, "object");
    assert.equal(typeof tool.execute, "function");
    assert.ok(tool.sessionPermission);
  }
});
