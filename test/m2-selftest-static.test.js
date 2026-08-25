import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../scripts/selftest.mjs", import.meta.url), "utf8");
test("selftest has M2 graph and BM25 switches without embedding a key", () => {
  assert.match(source, /graph/);
  assert.match(source, /bm25/i);
  assert.doesNotMatch(source, /sk-[A-Za-z0-9]{20,}/);
});
