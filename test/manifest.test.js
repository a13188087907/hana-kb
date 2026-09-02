import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

test("manifest exposes the M3 tools, page, startup, UI picker, and SiliconFlow network host", () => {
  assert.equal(manifest.activationEvents.includes("onStartup"), true);
  assert.equal(manifest.contributes.page.route, "/webui");
  assert.deepEqual(manifest.contributes.tools.map((file) => path.basename(file)), [
    "kb-create.js", "kb-ingest.js", "kb-search.js", "kb-list.js", "kb-delete-doc.js", "kb-graph-build.js", "kb-graph-clean.js", "kb-graph-stats.js", "kb-update-config.js", "kb-delete-library.js", "kb-doc-list.js", "kb-graph-data.js", "kb-rebuild-library.js", "kb-add-url.js",
  ]);
  assert.equal(manifest.capabilities.includes("network.fetch"), true);
  assert.equal(manifest.network.allowedHosts.includes("api.siliconflow.cn"), true);
  assert.equal(manifest.ui.hostCapabilities.includes("resource.pick"), true);
});
