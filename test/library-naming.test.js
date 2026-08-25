import test from "node:test";
import assert from "node:assert/strict";
import { LibraryManager } from "../core/library-manager.js";
import { safeLibraryId } from "../core/db.js";
import { makeTempDir, removeDir } from "./helpers.js";

test("maps a Chinese display name to a stable Windows-safe internal id", () => {
  const first = safeLibraryId("中文知识库");
  assert.match(first, /^kb-[0-9a-f]{16}$/);
  assert.equal(safeLibraryId("中文知识库"), first);
  assert.notEqual(safeLibraryId("中文知识库2"), first);
});

test("preserves existing ASCII library ids", () => {
  assert.equal(safeLibraryId("work-rules"), "work-rules");
  assert.equal(safeLibraryId("A_1"), "A_1");
});

test("stores and lists a Chinese display name without changing the internal id", () => {
  const dataDir = makeTempDir();
  try {
    const manager = new LibraryManager({ dataDir });
    const handle = manager.create("我的中文库");
    const listed = manager.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, handle.libraryId);
    assert.equal(listed[0].displayName, "我的中文库");
    assert.equal(manager.open("我的中文库").libraryId, handle.libraryId);
    manager.closeAll();
  } finally {
    removeDir(dataDir);
  }
});

test("falls back to the legacy id when an existing library has no display metadata", () => {
  const dataDir = makeTempDir();
  try {
    const manager = new LibraryManager({ dataDir });
    manager.open("legacy");
    assert.equal(manager.list()[0].displayName, "legacy");
    manager.closeAll();
  } finally {
    removeDir(dataDir);
  }
});
