import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir, removeDir } from "./helpers.js";
import { LibraryManager } from "../core/library-manager.js";
import { IngestService } from "../core/ingest.js";

function makeRuntime({ dataDir, embed, concurrency = 4, hooks } = {}) {
  const manager = new LibraryManager({ dataDir });
  manager.create("main");
  const embeddingClient = { config: () => ({ baseUrl: "https://test.local", model: "test-model" }), embed: embed ?? (async (texts) => texts.map(() => [1, 0])) };
  const service = new IngestService({ manager, embeddingClient, concurrency, hooks });
  return { manager, service };
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

test("ingests a document, skips same hash, and replaces changed content", async () => {
  const dataDir = makeTempDir();
  const sourceDir = makeTempDir();
  try {
    const file = path.join(sourceDir, "one.md");
    fs.writeFileSync(file, `# 标题\n\n${"旧内容".repeat(30)}`);
    const { manager, service } = makeRuntime({ dataDir });
    const first = await service.ingest("main", [file]);
    assert.equal(first[0].status, "done");
    assert.equal(first[0].chunks, 1);
    assert.equal(count(manager.open("main").db, "vec_index"), 1);

    const skipped = await service.ingest("main", [file]);
    assert.equal(skipped[0].status, "skipped");

    fs.writeFileSync(file, `# 标题\n\n${"新内容".repeat(30)}`);
    const replaced = await service.ingest("main", [file]);
    assert.equal(replaced[0].status, "done");
    assert.equal(manager.open("main").db.prepare("SELECT text FROM chunks").get().text.includes("新内容"), true);
    assert.equal(manager.open("main").db.prepare("SELECT text FROM chunks").get().text.includes("旧内容"), false);
    await manager.closeAll();
  } finally {
    removeDir(dataDir);
    removeDir(sourceDir);
  }
});

test("deletes a document and cascades chunk storage", async () => {
  const dataDir = makeTempDir();
  const sourceDir = makeTempDir();
  try {
    const file = path.join(sourceDir, "delete.md");
    fs.writeFileSync(file, "要被删除的内容".repeat(20));
    const { manager, service } = makeRuntime({ dataDir });
    await service.ingest("main", [file]);
    const deleted = service.deleteDocument("main", file);
    assert.equal(deleted, true);
    const db = manager.open("main").db;
    assert.equal(count(db, "documents"), 0);
    assert.equal(count(db, "chunks"), 0);
    assert.equal(count(db, "vec_index"), 0);
    assert.equal(count(db, "fts_chunks"), 0);
    await manager.closeAll();
  } finally {
    removeDir(dataDir);
    removeDir(sourceDir);
  }
});

test("limits document processing concurrency to four workers", async () => {
  const dataDir = makeTempDir();
  const sourceDir = makeTempDir();
  try {
    const files = Array.from({ length: 8 }, (_, index) => {
      const file = path.join(sourceDir, `${index}.txt`);
      fs.writeFileSync(file, `${index}`.repeat(60));
      return file;
    });
    let active = 0;
    let maximum = 0;
    const { manager, service } = makeRuntime({
      dataDir,
      embed: async (texts) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return texts.map(() => [1, 0]);
      },
    });
    const result = await service.ingest("main", files);
    assert.equal(result.filter((item) => item.status === "done").length, 8);
    assert.ok(maximum <= 4, `maximum active workers was ${maximum}`);
    await manager.closeAll();
  } finally {
    removeDir(dataDir);
    removeDir(sourceDir);
  }
});

test("leaves processing state for a simulated crash and resumes after reopen", async () => {
  const dataDir = makeTempDir();
  const sourceDir = makeTempDir();
  try {
    const file = path.join(sourceDir, "resume.md");
    fs.writeFileSync(file, "断点续跑内容".repeat(30));
    const first = makeRuntime({ dataDir, hooks: { beforeCommit: async () => { const error = new Error("simulated crash"); error.simulateCrash = true; throw error; } } });
    await assert.rejects(() => first.service.processDocument("main", file), /simulated crash/);
    assert.equal(first.manager.open("main").db.prepare("SELECT status FROM documents WHERE path=?").get(path.resolve(file)).status, "processing");
    await first.manager.closeAll();

    const resumed = makeRuntime({ dataDir });
    assert.equal(resumed.manager.open("main").db.prepare("SELECT status FROM documents WHERE path=?").get(path.resolve(file)).status, "pending");
    const result = await resumed.service.resume("main");
    assert.equal(result[0].status, "done");
    await resumed.manager.closeAll();
  } finally {
    removeDir(dataDir);
    removeDir(sourceDir);
  }
});
