// registerMany 行为测试：即时登记、重复跳过、内容变化重新登记
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { IngestService } from "../core/ingest.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hana-kb-reg-"));
const fileA = path.join(tmp, "a.md");
const fileB = path.join(tmp, "b.md");
fs.writeFileSync(fileA, "# 甲\n\n这是文档甲的内容。");
fs.writeFileSync(fileB, "# 乙\n\n这是文档乙的内容。");

const dbFile = path.join(tmp, "lib.sqlite");
const db = new Database(dbFile);
db.exec(`
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    content_hash TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
    normalized_text TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', error_message TEXT,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    graph_status TEXT NOT NULL DEFAULT 'pending', graph_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const manager = { open: () => ({ db }) };
const embeddingClient = { embed: async (texts) => texts.map(() => new Array(8).fill(0.1)) };
const service = new IngestService({ manager, embeddingClient, concurrency: 1 });

test("registerMany 立即登记全部文件为 pending", async () => {
  const reg = await service.registerMany("lib", [fileA, fileB]);
  assert.equal(reg.length, 2);
  assert.equal(reg[0].status, "pending");
  const count = db.prepare("SELECT COUNT(*) c FROM documents WHERE status='pending'").get().c;
  assert.equal(count, 2);
});

test("重复登记同内容 done 文档返回 skipped", async () => {
  db.prepare("UPDATE documents SET status='done'").run();
  const reg = await service.registerMany("lib", [fileA, fileB]);
  assert.equal(reg[0].status, "skipped");
  assert.equal(reg[1].status, "skipped");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM documents").get().c, 2);
});

test("内容变化后重新登记为 pending 且不新增行", async () => {
  fs.writeFileSync(fileA, "# 甲\n\n这是文档甲的内容，已经更新。");
  const reg = await service.registerMany("lib", [fileA]);
  assert.equal(reg[0].status, "pending");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM documents").get().c, 2);
  const row = db.prepare("SELECT status FROM documents WHERE path=?").get(path.resolve(fileA));
  assert.equal(row.status, "pending");
});

test("force 登记强制全部 pending", async () => {
  db.prepare("UPDATE documents SET status='done'").run();
  const reg = await service.registerMany("lib", [fileA, fileB], { force: true });
  assert.equal(reg[0].status, "pending");
  assert.equal(reg[1].status, "pending");
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
