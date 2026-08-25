import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const routes = fs.readFileSync(new URL("routes/webui.js", root), "utf8");
const panel = fs.readFileSync(new URL("assets/panel.js", root), "utf8");
const panelLogic = fs.readFileSync(new URL("assets/panel-logic.js", root), "utf8");
const css = fs.readFileSync(new URL("assets/panel.css", root), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", root), "utf8"));

test("panel uses the split workspace, token-aware fetch, native file input and local graph rendering", () => {
  assert.match(routes, /assets\/panel-logic\.js\$\{auth\}/);
  assert.match(panel, /URLSearchParams\(location\.search\)/);
  assert.match(panel, /tokenizedUrl/);
  assert.match(panel, /fetch\(/);
  for (const marker of ["sidebar", "library-list", "content-tabs", "add-source", "picker-file", "picker-directory", "open-search", "open-settings", "select-all", "bulk-delete", "open-global-settings", "settings-config"]) assert.match(panel, new RegExp(marker));
  assert.match(panel, /\.type\s*=\s*"file"/);
  assert.match(panel, /webkitdirectory/);
  assert.match(panel, /ingest-upload/);
  assert.match(panelLogic, /mode === \"directory\"/);
  assert.match(panelLogic, /: \"file\"/);
  assert.match(panelLogic, /mode === \"directory\" \? \"directory\"/);
  assert.doesNotMatch(panel, /allowDirectories/);
  assert.match(panel, /apiKey/);
  assert.match(panel, /与 embedding/);
  assert.match(panel, /请先在设置里配置 embedding/);
  assert.match(routes, /\/api\/config/);
  assert.match(panel, /<svg/);
  assert.match(panel, /one-hop|一跳|localGraph|graph-data/);
  assert.match(routes, /documents\/:libraryId\/ingest|libraries\/:libraryId\/ingest/);
  assert.match(panel, /requiresRebuild/);
  assert.match(panel, /setInterval|processing/);
  assert.doesNotMatch(panel, /name=\\"description\\"/);
  assert.doesNotMatch(panel, /forceSimulation|d3\\.|cytoscape/i);
  assert.ok(manifest.ui?.hostCapabilities?.includes("resource.pick"));
});

test("M3 styles follow paper, ink, blue and seal palette without shadows or gradients", () => {
  assert.match(css, /--blue:#/i);
  assert.match(css, /#9D5F4D/i);
  assert.match(css, /--sans:/i);
  assert.doesNotMatch(css, /box-shadow|linear-gradient|radial-gradient/);
});
