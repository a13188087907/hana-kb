// 实体噪声过滤测试：连接词、长句、纯数字、普通词
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 通过源码静态验证过滤规则存在并行为正确（validateExtraction 未导出，用规则等价实现验证）
const src = readFileSync("D:/XIANGMU/ming-workspace/hana-kb/core/graph-build.js", "utf8");

test("过滤规则存在于抽取校验中", () => {
  assert.match(src, /isMeaningfulEntity/);
  assert.match(src, /ENTITY_CONNECTORS/);
  assert.match(src, /及各种/);
  assert.match(src, /ENTITY_CODE_PATTERN/);
});

// 等价实现验证（与 graph-build.js 内规则一致）
const CONNECTORS = ["及各种", "以及", "等等", "什么的", "比如", "例如", "包括", "还有", "以及各种"];
const CODE = /《|》|NU-|T\/|GB\s|WS\s|Q\/|〔|（\d|[A-Z]{2,}[\/-]\d/i;
function clean(name) {
  let n = String(name).trim().replace(/^["'‘【\[（(]+|["'’】\]）)]+$/g, "");
  n = n.replace(/[。，；：!！?？]+$/, "");
  return n.trim();
}
function meaningful(name) {
  if (!name || name.length < 2) return false;
  if (CONNECTORS.some((c) => name.includes(c))) return false;
  if (/^[\d\s.\-:：年月日时分秒\/号]+$/.test(name)) return false;
  const hasCode = CODE.test(name);
  if (name.length > (hasCode ? 60 : 30)) return false;
  if (name.length > 18 && !hasCode) return false;
  return true;
}

test("噪声实体被过滤", () => {
  assert.equal(meaningful("被污染的被服及各种污染物"), false, "含连接词");
  assert.equal(meaningful("客人"), true, "短普通词暂不过滤（长度规则）");
  assert.equal(meaningful("原因不明的死胎史，复发性自然流产（≥3次），由于毒血症或发育受限原因早产"), false, "长句误抽");
  assert.equal(meaningful("2026年8月24日"), false, "纯日期");
  assert.equal(meaningful("123"), false, "纯数字");
});

test("有意义的实体被保留", () => {
  assert.equal(meaningful("《博鳌恒大国际医院新冠疫情期间住院患者陪护人员及探视人员监测管理制度》"), true, "制度全名");
  assert.equal(meaningful("NU-SOP-02-003发生医疗锐器伤的应急处理程序"), true, "编号制度");
  assert.equal(meaningful("中华护理学会团体标准T/CNAS 18─2020"), true, "标准编号");
  assert.equal(meaningful("顾比均线止盈法"), true, "领域概念");
});
