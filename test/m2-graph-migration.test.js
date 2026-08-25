import test from "node:test";
import assert from "node:assert/strict";
import { getLibraryFeatures, setLibraryFeatures } from "../core/db.js";
import { LibraryManager } from "../core/library-manager.js";
import { makeTempDir, removeDir } from "./helpers.js";

test("enabling graph is a persisted migration switch and disabling preserves data", () => {
  const dataDir = makeTempDir();
  try {
    const manager = new LibraryManager({ dataDir });
    const db = manager.create("switch").db;
    db.prepare("INSERT INTO entities (name, aliases_json) VALUES ('保留实体', '[]')").run();
    setLibraryFeatures(db, { graphEnabled: true });
    assert.equal(getLibraryFeatures(db).graphEnabled, true);
    setLibraryFeatures(db, { graphEnabled: false });
    assert.equal(getLibraryFeatures(db).graphEnabled, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM entities").get().n, 1);
    manager.closeAll();
  } finally {
    removeDir(dataDir);
  }
});
