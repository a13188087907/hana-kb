import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = new URL("../", import.meta.url);
const routes = fs.readFileSync(new URL("routes/webui.js", root), "utf8");
const panel = fs.readFileSync(new URL("assets/panel.js", root), "utf8");

test("keeps asset token passthrough and exposes source display fields", () => {
  assert.match(routes, /assets\/panel\.css\$\{auth\}/);
  assert.match(routes, /assets\/panel\.js\$\{auth\}/);
  assert.match(panel, /URLSearchParams\(location\.search\)/);
  assert.match(panel, /item\.source/);
});
