// 实体清洗规则（refine-loop 8 轮迭代产出，盲审验证零误伤）
// 三层：drop（删除，不进实体表）/ weak（保留实体供精确匹配，但不建边不参与社区）/ keep
// 泛化词表只放跨领域通用指代词；领域泛化词（如医疗库的"护士"）走库级配置 genericEntities

const DOC_NO = /^[A-Z]{2,4}(?:-[A-Z]{2,4})+-\d/; // NU-MP-01-046 式编号；不匹配 GPT-4.5（横杠后为数字段）
const BROKEN = /[（(][^）)]*$|、|、\s*$|^只能|^不[是定止]|及以上$|以下$|以内$|（[^）]*）[^\n]{0,6}的$/;
const TABLE_CELL = /^\S{1,8}(?:\d+(?:\.\d+)?\s*(?:m|cm|分|元|%|倍|岁|℃))$/;
const METADATA_PATH = /文档历史|文件历史|修订记录|文档变更/;
const CN_PERSON_NAME = /^[一-龥]{2,4}$/;

// 跨领域通用泛化词（任何库里都无独立指代）。领域泛化词（如医疗库的"护士/患者"）不进此表，走库级配置 libraryGenericWords
export const GENERIC_WORDS = new Set([
  "用户", "客户", "员工", "人员", "公司", "团队", "部门", "单位",
  "流程", "制度", "规范", "管理", "工作", "内容", "问题", "情况", "方面", "措施",
]);
const GENERIC_PATTERN = /^各[一个]?(护理单元|科室|部门|单位|病区|单元|岗位|级|类)/;

// 判定一个实体（name + 其出现块的标题路径）的处置
export function classifyEntity(name, { titlePaths = [], libraryGenericWords = [] } = {}) {
  if (DOC_NO.test(name)) return { action: "drop", rule: "R2 编号" };
  if (BROKEN.test(name) || name.length > 20) return { action: "drop", rule: "R4 边界崩坏" };
  if (TABLE_CELL.test(name)) return { action: "drop", rule: "R6 表格碎片" };
  if (CN_PERSON_NAME.test(name) && titlePaths.length > 0 && titlePaths.every((p) => METADATA_PATH.test(p))) {
    return { action: "drop", rule: "R2b 元数据区人名" };
  }
  const libSet = new Set(libraryGenericWords);
  if (GENERIC_WORDS.has(name) || libSet.has(name) || GENERIC_PATTERN.test(name)) {
    return { action: "weak", rule: "R1 泛化指代" };
  }
  return { action: "keep", rule: "-" };
}

// 存量清洗：对库执行删除+拆边（纯数据库操作，不动块与向量）。返回统计。
export function cleanLibraryEntities(db, { libraryGenericWords = [] } = {}) {
  const entities = db.prepare("SELECT id, name FROM entities").all();
  const dropIds = [], weakIds = [];
  for (const e of entities) {
    const paths = db.prepare("SELECT DISTINCT c.title_path AS p FROM chunk_entities ce JOIN chunks c ON c.id=ce.chunk_id WHERE ce.entity_id=?").all(e.id).map((r) => r.p || "");
    const r = classifyEntity(e.name, { titlePaths: paths, libraryGenericWords });
    if (r.action === "drop") dropIds.push(e.id);
    else if (r.action === "weak") weakIds.push(e.id);
  }
  const tx = db.transaction(() => {
    for (const id of dropIds) {
      db.prepare("DELETE FROM relations WHERE source_entity_id=? OR target_entity_id=?").run(id, id);
      db.prepare("DELETE FROM chunk_entities WHERE entity_id=?").run(id);
      db.prepare("DELETE FROM entities WHERE id=?").run(id);
    }
    if (weakIds.length) {
      const q = db.prepare("DELETE FROM relations WHERE source_entity_id=? OR target_entity_id=?");
      for (const id of weakIds) q.run(id, id);
    }
  });
  tx();
  return { dropped: dropIds.length, weakened: weakIds.length, total: entities.length };
}
