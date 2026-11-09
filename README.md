# dsh-work-memory

对话级工作记忆索引。记住「你提过什么需求、当时产出了什么文件、在会话的哪一段」，命中后按 `seq` 把**被上下文压缩掉的那段原文**回放出来。

## 解决什么

长会话压缩之后，早期的工作（提问、做法、产物）只剩一条摘要。再做相似任务时容易重造轮子，也说不清"上次做到哪一步"。

本插件把每段工作存成一条**指针**而不是摘要：

```json
{ "id": "...", "session": "...", "startSeq": 1204, "endSeq": 1288, "ask": "...", "title": "...", "artifacts": [], "ts": "..." }
```

正文不存——DSH 的会话日志是仅追加的，压缩只遮蔽 surface，原始事件一直在磁盘上。按 `(session, seq 区间)` 就能原样取回。

## 三个工具

| 工具 | 作用 |
|---|---|
| `memory_search(query, limit?, includeSuperseded?)` | 检索钩子：标题 + 当时的需求 + 产物路径 + 时间。不返回正文 |
| `memory_open(id, query?, maxChars?)` | 按 seq 回放原文：用户提问、助手回复、写过的文件 |
| `memory_write(title, ask?, artifacts?, supersedes?)` | 手动补一条，或标记"这条取代了哪几条旧记录" |

## 自动捕获

监听 `session/event`：累积本轮的用户消息与 `write`/`edit` 路径，`turn/end` 时落一条钩子（`kind: "auto"`），并按主题关键词即时判定归属。

只记有实义的轮次：提问总长 ≥ 20 字，或落下了工作区内的产物。`%TEMP%`、`node_modules`、`.tmp` 会被过滤。

## 上下文注入

`systemPrompt.context` 每步按当前用户消息检索：

| 情况 | 行为 |
|---|---|
| 判得出主题 | 只在该主题内检索，命中 ≥0.45 注入最多 3 行标题 |
| 判不出主题 | 全局检索，命中 ≥0.6 才注入 |
| 短句（<6 字且无主题） | 不注入（「好的」「成功了」这类没有信息量） |
| 最高分 ≥0.6 | 额外附 300 字原文摘录，省一次 `memory_open` |

注入总量 ≤400 字符，运行时不调用模型。

## 首次使用（一键流程）

装好后先跑一次 bootstrap，把本机历史对话变成账本：

```bash
node cli/bootstrap.js --dry-run          # 预演：看会做什么、扫描到多少会话
node cli/bootstrap.js --all              # 全跑（需要模型 key）
node cli/bootstrap.js --all --skip-llm   # 只跑不需要模型的步骤
node cli/bootstrap.js --all --max-sessions 50   # 限制归块数量，控制成本
```

| 阶段 | 做什么 | 需要模型 |
|---|---|---|
| 1 scan | 扫本机全部 DSH 会话，统计提问数 | 否 |
| 2 ingest | 检测 zcode / hermes / workbuddy，有就导入并合并 | 否 |
| 3 rebuild | 对 ≥3 条提问的会话归块（module 级），用 `--max-sessions` 限流 | **是** |
| 4 topics | 归纳主题 → 打标 → 规则修正（已有 `topics.json` 则跳过归纳） | **是** |
| 5 alts | 生成别名 + 重写导入标题 | **是** |
| 6 doctor | 全链路体检 + 账本校验 | 否 |

各阶段可单独重跑（都支持断点续跑），某一步失败不阻塞后续。中间文件写在 `<DSH_HOME>/work-memory/.bootstrap/`。

## 数据位置

```
<DSH_HOME>/work-memory/hooks.jsonl      账本（append-only）
<DSH_HOME>/work-memory/topics.json      你自己的主题定义（可选）
```

账本首次使用自动创建，为空。所有写入走 `.lock` 文件互斥，写前留备份并轮转（保留最近 7 天且最多 10 份）。

## CLI（不依赖 DSH 运行时）

```bash
node cli/query.js stats
node cli/query.js search "关键词"
node cli/query.js open <hookId>            # 回放原文
node cli/query.js open <hookId> "过滤词"    # 长区间只保留命中行
```

## 主题层

主题让你把长会话按工程切块，检索时先判主题再搜，避免跨项目噪声。主题数量由你的工作种类决定：模型归纳通常 8~15 个，再按实际合并或拆分。

主题定义放在 `<DSH_HOME>/work-memory/topics.json`；插件包内只带 `topics.example.json`（通用示例）。没定义主题也能用——退化为全局检索。

格式：

```json
{
  "topics": [
    { "id": "t01", "name": "产品交付", "keywords": ["版本", "发布", "上线"], "desc": "版本迭代与交付" },
    { "id": "t02", "name": "数据分析", "keywords": ["数据", "报表", "统计"], "desc": "清洗、分析与汇报" }
  ]
}
```

生成顺序（前提：账本里已有足够条目，建议 ≥50 条，否则归纳不出稳定的主题边界）：

```bash
node cli/derive-topics.js --out topics.json   # 让模型从现有账本归纳主题
node cli/tag-topics.js                        # 给每条钩子打主题标签
node cli/fix-topics.js                        # 规则修正打标偏差（期号系列、误入的杂项）
```

## 跨 agent 接入

可以把本机其他编程 agent 的历史导入同一账本，用 `memory_open` 统一回指。

| 来源 | 数据库 | 回指 |
|---|---|---|
| dsh | `<DSH_HOME>/sessions`（多帧 zstd） | 直接解压 |
| zcode | `~/.zcode/cli/db/db.sqlite` | `node:sqlite` 只读 |
| hermes | `~/AppData/Local/hermes/state.db` | `node:sqlite` 只读 |
| workbuddy | `~/.workbuddy/workbuddy.db` | 仅会话标题，无正文 |

```bash
node cli/ingest-zcode.js  --out ingest-zcode.jsonl
node cli/ingest-hermes.js --out ingest-hermes.jsonl
node cli/merge-ingest.js  --file ingest-zcode.jsonl --agent zcode
node cli/retitle.js       --agent all --batch 10   # 用模型重写导入条目的标题
```

库不存在时该源自动跳过，不影响其他源。路径可用环境变量覆盖（见下文）。

三个实现细节值得说明：

1. **只索引用户提问会漏内容**。有些话题在助手回复里反复出现、用户提问里一次没提。导入时用 `lib/keywords.js` 抽会话高频词（2/3/4 字，纯规则），以低权重参与召回。
2. **导入标题是首条提问，信息量低**。`cli/retitle.js` 用模型按整段提问重写成「做了什么 + 实体」。
3. **自动化任务会话要降权**。cron 派发的会话保留可查，但检索权重 ×0.7，否则会把真实工作挤出前排。

## 全量重建

把历史会话批量转成模块级钩子：

```bash
node cli/scan-sessions.js scan-sessions.json          # 1. 扫全部会话，统计提问数
node cli/rebuild.js --scan scan-sessions.json --out rebuilt.jsonl --min-asks 3 --concurrency 3
node cli/merge-rebuilt.js --rebuilt rebuilt.jsonl --scan scan-sessions.json --lite
```

`rebuild.js` 断点续跑（已处理会话跳过），失败记在 `rebuilt-failed.jsonl`。实测量级：数百个会话、约二十分钟、每会话一次模型调用（并发 3、关闭思考）。

## 记忆治理

| 机制 | 行为 |
|---|---|
| 时间衰减 | 半年内 ×1.2、一年内 ×1.0、更旧 ×0.7；只影响排名，不删条目 |
| superseded | `memory_write(supersedes=...)` 标记旧记录；检索默认排除，`includeSuperseded: true` 可查 |
| 过期不删 | 一律标状态，不物理删除 |
| 去重报告 | `cli/dedupe.js` 双门槛（标题 + 提问相似度），**只报告不自动合并**——同模板派发的会话标题和提问都会 1.00 相似，但内容不同 |

## 召回评估

```bash
node cli/eval.js           # 默认读 <DSH_HOME>/work-memory/eval-set.json
node cli/eval.js --top 10 --show-fail 20
```

评估集做法：从账本抽 N 条真实条目，为每条写一个**刻意避开标题原词**的问法，跑 hit@k 与 MRR。

参考量级（自建 50 例评估集）：字面匹配基线 Hit@1 约 76%；加 IDF 加权、同义词扩展、复合词拆分后约 80%；再加离线别名扩展（`cli/gen-alts.js` 给每条生成 3 句「用户可能这样问」，0.55 权重）后约 84%，Hit@3 约 96%。

注意：评估问法与别名词条都是模型生成的口语改写，这组数字说明"同义改写方向有效"，不等于对真人提问的绝对准确率。

## 自测清单

这些脚本都依赖**本机的账本和会话日志**。刚 clone 下来直接跑会失败——先执行一次 `cli/bootstrap.js` 把账本建起来。

```bash
node cli/selftest.js         # 工具注册 / 自动捕获 / 上下文注入（mock ctx）
node cli/test-governance.js  # 时间衰减 / superseded / 不删除 / 同分排序
node cli/test-webpanel.js    # 面板四条路由 + 改名后回查 + 归档后消失
node cli/test-formats.js     # v3 / v4 / 无版本号 三种会话文件解析与回放
node cli/test-concurrency.js # 顺序写 / 重写与追加 / 备份轮转
node cli/verify.js           # 账本逐行 schema 校验
node cli/doctor.js           # 升级后全链路体检（账本/格式/跨源/主题/检索）
node cli/eval.js             # 召回率
```

## Web 面板

打开 **`http://127.0.0.1:8282/work-memory/`**（host 侧代码，装完要重启一次 DSH）。

搜索、展开原文、改标题、归档。API 是同源的四条 exact 路由：

```
GET  /work-memory/api/search?q=<kw>&limit=20
GET  /work-memory/api/open?id=<hookId>&maxChars=4000
POST /work-memory/api/update   {id, title}
POST /work-memory/api/archive  {id}
```

## 配置（环境变量）

全部可选，缺省走默认值。

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_WM_LLM_BASE_URL` | 离线批处理的模型端点（OpenAI 兼容 chat/completions） | 智谱 coding plan |
| `DSH_WM_LLM_MODEL` | 模型名 | `glm-5.3-flash` |
| `DSH_WM_LLM_API_KEY` | 模型 key | 读 `~/.dsh/.credentials.yaml` 的 `ZAI_CODING_CN_API_KEY` |
| `DSH_WM_LLM_THINKING` | `on` 才开思考（默认 off，省 token） | off |
| `DSH_WM_ZCODE_DB` / `_HERMES_DB` / `_WORKBUDDY_DB` | 各源数据库路径 | 各自默认路径 |
| `DSH_WORK_MEMORY_DIR` | 账本目录（测试/多实例隔离） | `<DSH_HOME>/work-memory` |
| `DSH_WM_SEED` | 可选种子文件，首次启动时复制成账本 | 无 |

## 两层颗粒度

| level | 来源 | 用途 |
|---|---|---|
| `module` | 模型离线分组（`rebuild.js` / `rebuild-one.js`） | 主索引，检索权重 ×1.15 |
| `turn` | `turn/end` 自动捕获 | 细节流水，强匹配时补位 |

自动捕获是 **turn 级**：一个几百问的长会话会产出数百条 turn 钩子。模块级索引仍要模型批处理生成，所以两者都保留。

新会话可以交给 `cli/autopilot.js --hours 24 --limit 5`（幂等，可直接挂计划任务）自动归块。

## 并发与备份

| 机制 | 实现 |
|---|---|
| 账本锁 | `.lock` 文件互斥；等待上限 5s，陈旧锁（>30s）自动接管 |
| 读—改—写 | CLI 必须用 `updateLedger(fn)`：锁内重新读最新账本再变换。**不要用「旧快照 + saveLedger」，会覆盖并发追加** |
| 备份轮转 | 每次写前留 `.bak-<时间戳>`，保留最近 7 天且最多 10 份 |

## 会话格式兼容

`session.jsonl.zstd`（无版本号）、`.v3.`、`.v4.` 三种文件都能解析，`readSessionEvents()` 返回 `version`；解压后没有有效事件时返回明确的 `error`，不静默返回空数组。

## Model Experience

### 三个工具的 schema

#### What the model sees

每次请求都带三个工具的 schema：`memory_search`（`query`、`limit`、`includeSuperseded`）、`memory_open`（`id`、`query`、`maxChars`）、`memory_write`（`title`、`ask`、`artifacts`、`supersedes`、`startSeq`、`endSeq`）。三个都是纯字符串返回，`output.schema` 为 `{ type: "string" }`。

#### Token effect

固定：每次请求都在，与请求内容无关。三个 description 加上参数说明合计约 400 token。

#### KV Cache effect

前缀稳定。工具集在会话生命周期内不增删，本包不会因自身行为让前缀缓存失效。工具定义变化只会来自 DSH 自身的工具装配。

### 运行时上下文快照

#### What the model sees

命中时向运行时上下文追加一段，形如：

```markdown
工作记忆（主题：<主题名>）：需要当时的过程细节时调用 memory_open。
· [<hookId>] <日期> <标题> ｜<产物文件名>
· 摘录（<hookId>）：<≤300 字的原文节选>
```

判不出主题时首行为「工作记忆（跨主题）」；没有命中时不追加任何内容。

#### Token effect

条件性，有上限：命中 ≤3 条指针，合计 ≤400 字符；最高分 ≥0.6 时额外附 300 字摘录。量级约 200–600 token，未命中时为零。

#### KV Cache effect

替换既有请求 token。快照作为一条 user-role 消息追加在历史尾部；内容变化时生成新的快照消息，从该点往后的前缀不可复用。内容未变化时 `runtimeContext` 不重复追加，前缀保持稳定。

### 工具结果

#### What the model sees

`memory_search` 返回最多 `limit` 条（默认 3），每条三行：标题、原始提问、时间与产物、`memory_open` 调用提示。`memory_open` 返回按 seq 回放的原文，默认 ≤4000 字符，调用方可指定到 12000。

#### Token effect

条件性，由调用方参数决定：`memory_search` 单次约 300–800 字符；`memory_open` 默认上限 4000 字符（约 2000 token）。

#### KV Cache effect

仅追加增长。结果作为工具结果进入历史；之后的请求前缀包含它，不会失效既有内容。

### 自动捕获（模型不可见）

#### What the model sees

无。`turn/end` 时的索引写入只读会话日志、只写账本，不产生模型可见内容。

#### Token effect

零。

#### KV Cache effect

无影响。

## 已知限制

- 自动捕获的 `title` 是提问首句，不如模型分组出的模块标题。要更好的标题跑 `rebuild-one.js` 或 `memory_write`。
- 检索是中文 bigram + 拉丁词（含复合词拆分）的字面匹配，同义不同词靠 `alts` 和同义词表兜，换语言或换领域需要自己补。
- 跨源回指依赖对方数据库结构，对方升级改了表就可能要改 `lib/foreign.js`。
- 注入按"当前会话最近一条用户消息"判定，跨会话召回需要显式调 `memory_search`。
- WorkBuddy 只有会话标题，没有消息正文，`memory_open` 会明确说明。

## 与 dsh-cairn 的分工

- `dsh-cairn`：当前这一轮的状态快照（覆盖式），压缩后立刻重注入系统提示。
- `dsh-work-memory`：跨会话的需求指针库（append-only），按需展开历史原文。

两者互不写对方数据，注入通道也不同（section vs context），可以同时装。
