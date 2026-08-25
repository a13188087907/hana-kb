import test from "node:test";
import assert from "node:assert/strict";

for (const [file, name] of [["../tools/kb-graph-build.js", "kb-graph-build"], ["../tools/kb-graph-stats.js", "kb-graph-stats"]]) {
  test(`${name} exposes the Hana static tool contract`, async () => {
    const tool = await import(file);
    assert.equal(tool.name, name);
    assert.equal(typeof tool.description, "string");
    assert.equal(typeof tool.parameters, "object");
    assert.equal(typeof tool.execute, "function");
    assert.ok(tool.sessionPermission);
  });
}
