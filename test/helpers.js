import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeTempDir(prefix = "hana-kb-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir) {
  // Windows 上 better-sqlite3 句柄释放有延迟，同步重试后静默降级（残留临时目录由系统清理）
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EBUSY") throw error;
      const waitUntil = Date.now() + 300;
      while (Date.now() < waitUntil) { /* busy wait */ }
    }
  }
  console.warn(`[test] 临时目录残留（文件锁未释放）: ${dir}`);
}

export function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
}
