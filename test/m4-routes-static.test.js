import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const routes = fs.readFileSync(new URL("routes/webui.js", root), "utf8");
const createTool = fs.readFileSync(new URL("tools/kb-create.js", root), "utf8");
const listTool = fs.readFileSync(new URL("tools/kb-list.js", root), "utf8");

test("webui routes expose redacted global config and display-name aware background ingest", () => {
  assert.match(routes, /\/api\/config/);
  assert.match(routes, /getConfigForUi/);
  assert.match(routes, /savePluginConfig/);
  assert.match(routes, /displayName/);
  assert.match(routes, /collectFiles/);
  assert.match(routes, /processMany/);
  assert.match(routes, /202/);
  assert.match(routes, /请先在设置里配置 embedding/);
});

test("create and list tools describe display names while preserving libraryId compatibility", () => {
  assert.match(createTool, /displayName/);
  assert.match(createTool, /libraryId/);
  assert.match(listTool, /displayName/);
});
