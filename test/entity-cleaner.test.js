import test from "node:test";
import assert from "node:assert/strict";
import { classifyEntity, cleanLibraryEntities, GENERIC_WORDS } from "../core/entity-cleaner.js";

test("classifyEntity: 编号删除", () => {
  assert.equal(classifyEntity("NU-MP-01-046").action, "drop");
  assert.equal(classifyEntity("NU-MP-02-042-05 血栓评估表").action, "drop");
  // 模型版本号不误伤
  assert.equal(classifyEntity("GPT-4.5").action, "keep");
});

test("classifyEntity: 边界崩坏删除", () => {
  assert.equal(classifyEntity("主管护师及以上").action, "drop");
  assert.equal(classifyEntity("销售（B2B、咨询顾问").action, "drop");
  assert.equal(classifyEntity("法律、法规、规章或者诊疗技术规范").action, "drop");
  assert.equal(classifyEntity("只能发音").action, "drop");
});

test("classifyEntity: 表格碎片删除", () => {
  assert.equal(classifyEntity("平地行走45m").action, "drop");
  assert.equal(classifyEntity("25岁").action, "drop");
});

test("classifyEntity: 元数据区人名删除，正文人名保留", () => {
  assert.equal(classifyEntity("纪淑云", { titlePaths: ["8. 文档历史 > | 版本号"] }).action, "drop");
  assert.equal(classifyEntity("纪淑云", { titlePaths: ["5.内容 > 职责"] }).action, "keep");
  // 非人名长词不受此规则影响
  assert.equal(classifyEntity("患者隐私保护制度", { titlePaths: ["8. 文档历史"] }).action, "keep");
});

test("classifyEntity: 泛化词降级（通用表+库级配置+各X模式）", () => {
  assert.equal(classifyEntity("流程").action, "weak");
  assert.equal(classifyEntity("各部门").action, "weak");
  assert.equal(classifyEntity("护士", { libraryGenericWords: ["护士"] }).action, "weak");
  // 未配置时领域词不受影响
  assert.equal(classifyEntity("护士").action, "keep");
  assert.equal(classifyEntity("门诊护士长").action, "keep");
});

test("classifyEntity: 正常实体保留", () => {
  for (const name of ["特级护理", "危急值报告制度", "基金定投", "Barthel指数", "双人核对"]) {
    assert.equal(classifyEntity(name).action, "keep", name);
  }
});
