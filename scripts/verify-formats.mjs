// 真实文件格式验证（不进 npm test，路径为本机隐私文件，不随仓库分发结果）
import { convertToMarkdown } from "../core/converter.js";

const jobs = [
  {
    tag: "docx 制度文件",
    file: "D:\\xjcdeyu\\恒大 - General\\博鳌恒大国际医院\\体检中心\\【0】模板\\【0】制度文件\\【0】健康管理中心工作制度\\2025更新版\\体检科\\HM-MP-03-001 体检客人隐私保护制度.docx",
    expect: (md) => (md.match(/^## /gm) || []).length >= 6 && md.includes("|"),
    expectDesc: "≥6 个 ## 标题、含表格",
  },
  {
    tag: "xlsx 收入表",
    file: "D:\\xjcdeyu\\恒大 - General\\博鳌恒大国际医院\\体检中心\\【2】数据表\\健康管理中心历史收入.xlsx",
    expect: (md) => !/^\| 44\d{3} \|/m.test(md) && /\| 1\/1\/22 \|/.test(md) && md.split("\n")[2].split("|").length >= 7,
    expectDesc: "日期为正常格式、含年份列（≥7 列）",
  },
  {
    tag: "pptx 培训课件",
    file: "D:\\OneDrive - xjcdeyu\\桌面\\培训材料\\【1】急救相关培训\\3-5 休克的早期识别与复苏.pptx",
    expect: (md) => (md.match(/^## 幻灯片/gm) || []).length >= 20 && (md.match(/^### /gm) || []).length >= 20,
    expectDesc: "## 幻灯片分页 ≥20 且 ### 页标题 ≥20",
  },
  {
    tag: "docx 空壳",
    file: "D:\\xjcdeyu\\恒大 - General\\博鳌恒大国际医院\\体检中心\\【0】模板\\【0】制度文件\\【0】健康管理中心工作制度\\2025更新版\\内科工作制度.docx",
    expect: (md, warnings) => md === "" && warnings.length > 0,
    expectDesc: "markdown 为空 + 有 warning",
  },
];

let failed = 0;
for (const { tag, file, expect, expectDesc } of jobs) {
  try {
    const { markdown, warnings } = await convertToMarkdown(file);
    const headings = (markdown.match(/^#{1,3} /gm) || []).length;
    const tableRows = (markdown.match(/^\|/gm) || []).length;
    const ok = expect(markdown, warnings);
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"} ${tag}: ${markdown.length}字符 ${headings}标题 ${tableRows}表格行 warnings=${warnings.length}（预期：${expectDesc}）`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${tag}: ${e.message}`);
  }
}
console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项未达标`);
process.exit(failed === 0 ? 0 : 1);
