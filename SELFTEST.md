# Hana 知识库插件 M1 自测报告

日期：2026-08-24

## 测试环境

- 项目：`D:\XIANGMU\ming-workspace\hana-kb`
- Node：Node.js 24.13.0
- embedding：SiliconFlow OpenAI 兼容接口，`BAAI/bge-m3`
- API key：从实验目录 `config.local.json` 读取后写入临时插件 dataDir；本报告不记录 key。
- 语料：`D:\XIANGMU\ming-workspace\2026-08-23-检索对比实验\corpus\`

## 0. 自动化测试与静态检查

命令：

```powershell
npm test
```

实际输出摘要：

```text
ℹ tests 20
ℹ pass 20
ℹ fail 0
```

命令：

```powershell
node --check index.js
node --check core/db.js
node --check core/parser.js
node --check core/chunker.js
node --check core/embedding.js
node --check core/ingest.js
node --check core/search.js
node --check routes/webui.js
```

实际输出摘要：

```text
node_syntax_checks=passed
```

实现纪律检查命令结果：

```text
forbidden_vector_or_fts_matches=0
hardcoded_api_key_matches=0
```

## 1. 118 篇 Markdown 建库入库

操作命令：

```powershell
npm run selftest -- --corpus "D:\XIANGMU\ming-workspace\2026-08-23-检索对比实验\corpus" --api-config "D:\XIANGMU\ming-workspace\2026-08-23-检索对比实验\config.local.json" --data-dir "D:\XIANGMU\ming-workspace\hana-kb\.selftest-data" --library m1
```

实际输出：

```text
INITIAL documents=118 done=118 failed=0 chunks=1695 results=118 elapsed_ms=8775
```

结果：通过。118/118 文档完成，失败数 0；共生成 1695 个 chunk。向量写入 `vec_index.embedding` 普通 BLOB 列。

## 2. 向量检索返回相关结果

同一次真实 API 自测命令中的检索问题：

```text
压力测试 trigger 不准怎么办
```

实际输出摘要：

```text
SEARCH query="压力测试 trigger 不准怎么办" hits=15
HIT similarity=0.7092 source=2026-07-13_013_methodology__06-stage4-pressure-test.md title=阶段 4 — 压力测试 (darwin 兼容) > 为什么必须做 offset=163-251
HIT similarity=0.6623 source=2026-07-13_013_methodology__06-stage4-pressure-test.md title=阶段 4 — 压力测试 (darwin 兼容) > 评测原则: 独立 sub-agent 盲测优先 offset=281-351
HIT similarity=0.6134 source=2026-07-13_013_methodology__06-stage4-pressure-test.md title=阶段 4 — 压力测试 (darwin 兼容) > 判断"修 skill 还是修测试" offset=2513-2664
```

结果：通过。返回默认 15 条以内结果，相关命中集中在压力测试文档，结果包含文档名、标题路径和偏移量。

## 3. 删除、同 hash 跳过、内容变化重入

实际输出：

```text
SAME_HASH path=2026-07-13_001_extractors__case-extractor.md status=skipped chunks=9
DELETE path=2026-07-13_001_extractors__case-extractor.md deleted=true after={"documents":117,"done":117,"failed":0,"processing":0,"pending":0,"chunks":1686,"vectors":1686}
REINGEST_SAME_CONTENT_AFTER_DELETE path=2026-07-13_001_extractors__case-extractor.md status=done chunks=9
REINGEST_CHANGED_CONTENT path=mutation.md status=done chunks=9
```

结果：通过。

- 同路径同 hash：`skipped`。
- 删除：documents 从 118 变 117，chunk/vector 同步减少 9。
- 删除后重新导入相同内容：`done`。
- 修改内容后重新导入临时 mutation 文档：`done`，重新生成 9 个 chunk。

## 4. 模拟中断与续跑

同一次真实 API 自测命令使用 `beforeCommit` 抛出 `simulateCrash`，模拟写事务前进程中断。

实际输出：

```text
INTERRUPT simulated=true error=simulated interruption
INTERRUPT_STATE status=processing
RESUME results=[{"path":"D:\\XIANGMU\\ming-workspace\\hana-kb\\.selftest-data\\interrupt.md","status":"done","chunks":9}] stats={"documents":120,"done":120,"failed":0,"processing":0,"pending":0,"chunks":1713,"vectors":1713}
```

结果：通过。重开数据库时 `processing` 自动恢复为 `pending`，随后 `resume()` 完成未入库文档。

## 5. close/reopen 生命周期冒烟

同一次真实 API 自测命令最后执行：

```text
REOPEN_CLOSE ok=true file=D:\XIANGMU\ming-workspace\hana-kb\.selftest-data\kb\m1.sqlite
```

另外，自动化测试命令：

```powershell
npm test -- test/db.test.js
```

覆盖了 close 后重命名数据库文件的场景，结果为 3/3 通过。

结果：通过。插件生命周期注册了 `closeAll()`，数据库句柄释放后文件可继续操作。

## 结论

M1 自测的存储、解析、切块、真实 embedding 入库、cosine BLOB 检索、删除级联、hash 判定、模拟中断续跑、工具契约和最小 UI 代码检查均通过。图谱逻辑、FTS5/BM25、复杂格式解析和其他 M2/M3 能力未实现。

## M2 自测（2026-08-24）

### 0. 自动化测试与静态检查

命令：

```powershell
npm test
```

实际输出摘要：

```text
ℹ tests 33
ℹ pass 33
ℹ fail 0
```

命令：

```powershell
node --check core/db.js
node --check core/graph-build.js
node --check core/search.js
node --check core/ingest.js
node --check core/library-manager.js
node --check index.js
node --check routes/webui.js
node --check assets/panel.js
node --check tools/kb-graph-build.js
node --check tools/kb-graph-stats.js
node --check scripts/selftest.mjs
npm run selftest -- --help
```

实际结果：全部通过；帮助输出包含 `--graph` 与 `--bm25`。测试覆盖 FTS5 trigram 迁移与同步、别名归并、LLM 三次重试与失败记录、RRF 单路退化、BM25 融合、图谱追加不重排、开关迁移、工具契约和 token 透传。

源码检查：

- `vec_index` 仍为普通 BLOB 列，未引入 `vec0`。
- 未发现硬编码 API key。
- `routes/webui.js` 仍为 asset URL 透传 token，`panel.js` 仍从 `location.search` 读取 token 并使用原生 fetch。

### 1. 真实实验语料 M2 尝试

命令（key 只从实验目录读取并写入临时 dataDir，未写入仓库）：

```powershell
npm run selftest -- --corpus "D:\XIANGMU\ming-workspace\2026-08-23-检索对比实验\corpus" --api-config "D:\XIANGMU\ming-workspace\2026-08-23-检索对比实验\config.local.json" --data-dir "D:\XIANGMU\ming-workspace\hana-kb\.m2-selftest-data" --library m2 --graph --bm25
```

实际结果：向量入库阶段完成 `documents=118`、`chunks=1695`、`vec_index=1695`；图谱抽取开始后，外部 LLM 请求长时间无响应，临时进度停在 `graph_extract ok=31, processing=4`，为避免无限等待主动中止。`.m2-selftest-data` 已清理，未将 key 写入项目。

因此，本次真实 API 运行不能据此宣称达到“实体数千级、平均度 >1.5、孤立 <30%”；该项需在 LLM API 可稳定响应后重新执行。确定性自动化测试已覆盖图谱质量计算和失败续跑语义。

## M3 自测（2026-08-24）

### 0. 自动化测试与静态检查

命令：

```powershell
npm test
```

实际结果：`45` 项通过，`0` 项失败（实现 M3 管理配置持久化、文档分页、局部图摘要、工具契约和前端纯函数/静态检查）。

命令：

```powershell
Get-ChildItem -Recurse -File -Filter *.js | ForEach-Object { node --check $_.FullName }
npm run selftest -- --help
```

实际结果：所有 JavaScript 语法检查通过；帮助输出可发现 `--graph` 与 `--bm25`。

### 1. M3 管理能力

确定性测试覆盖：

- `search` 与 `chunking` 配置读写；切块目标/重叠变化会持久化 `requiresRebuild`，重建完成后清除。
- 文档分页与 `pending/processing/done/failed` 实时计数。
- 按当前切块参数强制重建文档，避免同 hash 快速跳过旧 chunk。
- 局部图仅返回实体搜索候选或指定实体一跳节点；节点上限 81、边上限 160、关系标签 120 字符、chunk 摘要 100 条且每条 240 字符。
- 管理 API 对 `/ingest`、文档删除、图谱重建和图数据提供统一 JSON 错误契约；五个 M3 Agent 工具复用 core。
- 原生单页包含 libraries/documents/search/graph 四视图、token 透传 fetch、资源选择器降级、结果展开和邻居实体局部展开；无第三方图库、阴影、渐变或 emoji。

### 2. 外部依赖说明

本次未宣称真实 LLM 图谱质量指标；外部 LLM 响应的稳定性与抽取质量仍需单独用真实语料复测。当前 M3 确定性规模控制和数据契约已由自动化测试覆盖。仓库目录无 Git 元数据，因此未执行提交。

## M4 前端布局改版（2026-08-24）

### 1. 改版范围

- `assets/panel.js` 改为左右分栏工作区：左侧库列表与置顶“新建知识库”，右侧当前库标题、文件/图谱标签、召回测试抽屉和设置弹层。
- 新建库弹层只提交库名；后端当前没有描述字段持久化能力，因此未显示描述输入框，避免“填写后丢失”。
- 文件表格新增复选框、当前页全选、批量删除、Markdown/txt 类型标识、更新时间、状态色点+文字双编码、重新入库和删除。
- 添加数据源先探测运行时 `globalThis.hana?.resources?.pick`；选择器可用时支持多资源和目录参数，不可用时显示路径输入降级。
- 召回测试保留 topK、相似度阈值、来源、标题路径和全文展开；图谱保留 M3 一跳局部 SVG 展开；设置承载参数、图谱/BM25、体检、重建和删除库。
- `assets/panel.css` 使用纸感米白、墨色、远山蓝 `#537D96`、少量赭石 `#9D5F4D`，无阴影、渐变和 emoji；窄屏时左栏转为横向库带。

### 2. 前端纯函数测试

新增并覆盖：

- `done/processing/failed/pending` 状态文字，其中就绪为“就绪”；
- `.md/.markdown/.txt` 文件类型标签；
- `resource.pick` 能力探测和多种宿主返回形状的路径提取；
- 全选、单项选择的不可变集合更新；
- 带既有 query 的 token URL 拼接。

### 3. 验证命令

```powershell
npm test
```

结果：`49` 项通过，`0` 项失败。

```powershell
Get-ChildItem -Recurse -File -Filter *.js | ForEach-Object { node --check $_.FullName }
```

结果：项目内 JavaScript 语法检查通过。

### 4. resource.pick 探测结果

- `manifest.json` 已声明 `ui.hostCapabilities: ["resource.pick"]`。
- 页面运行时使用 `globalThis.hana?.resources?.pick` 做能力探测，并解析字符串、数组、`resources[]`、`resource.path` 等返回形状。
- 当前 Node 测试环境没有 Hana 宿主对象，因此静态/纯函数验证走“不可用时路径输入”分支；实际 Hana 宿主若提供该能力则优先打开资源选择器。

## M5 用户实测反馈修复（2026-08-24）

### 1. 中文命名与配置测试

```powershell
npm test
```

结果：`61` 项通过，`0` 项失败。新增覆盖：中文显示名到 `kb-<16位hex>` 内部 ID 的稳定映射、旧 ASCII ID 保留、displayName 元数据回退、config.json 读写、API key 脱敏和 masked key 保留。

### 2. JavaScript 语法检查

```powershell
$files = Get-ChildItem -Recurse -File -Filter *.js | Where-Object { $_.FullName -notmatch '\\node_modules\\' }; $files | ForEach-Object { node --check $_.FullName }
```

结果：`51` 个项目 JavaScript 文件全部通过。

### 3. 数据源与配置入口

- 页面入口拆为“添加文件”“添加文件夹”“输入路径”。`resource.pick` 分别使用 `mode: "file"` 和 `mode: "directory"`；当前正式安装的 prompt-shelf 也使用 `mode: "directory"`，因此目录选择能力已确认支持。
- picker 不可用时回退路径输入；后端按文件/目录自动识别，并在预检后后台启动入库，页面轮询 `pending/processing`。
- 全局设置位于左侧“全局设置”按钮；`/api/config` 只返回脱敏 key，完整 key 仅在勾选修改时提交。
- embedding 配置缺失或无效时，入库接口直接返回“请先在设置里配置 embedding”。

### 4. 正式安装目录同步边界

同步到 `C:\Users\a1318\.hanako\plugins\hana-kb\` 的运行文件不包含 `config.json`、SQLite 数据库/WAL 文件和 `node_modules`。同步后对 12 个文件执行 SHA-256 对照，要求全部一致；运行态配置和数据库未覆盖。
