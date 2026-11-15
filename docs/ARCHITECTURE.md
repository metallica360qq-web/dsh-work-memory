# 架构

这份文档讲清楚三件事：数据长什么样、数据怎么长出来、召回怎么用它。

## 1. 数据模型

### 1.1 钩子（钩子 = 一条指针）

`<DSH_HOME>/work-memory/hooks.jsonl`，每行一条：

```json
{
  "id": "m-abc12345-02",
  "session": "session-…",        // 或 zcode:… / hermes:… / workbuddy:…
  "startSeq": 1204, "endSeq": 1288,
  "ask": "用户当时的原话（截断）",
  "title": "这一轮在做什么（模型或规则生成）",
  "kind": "auto|manual|design|…",
  "level": "module|turn",        // module = 一段完整工作；turn = 单轮
  "artifacts": ["D:\\…\\index.js"],
  "ts": "2026-11-14T…",
  "agent": "dsh|zcode|hermes|workbuddy",
  "origin": "dsh:user | zcode:subagent_child | hermes:cron | …",
  "topic": "g05",                // 宽类
  "topicFine": "i20",           // 细类
  "segment": "session-…#3",      // 所属段（多钩子会话才有）
  "segLabel": "这段在做什么",
  "status": "active|superseded"
}
```

正文不存。原文在 DSH 会话日志里，`(session, seq 区间)` 就能原样取回——包括被压缩遮蔽的部分。

### 1.2 起源（origin）

`lib/origin.js` 维护一份白名单：

- 人提的需求：`dsh:user`、`zcode:interactive`、`hermes:desktop|tui|cli|acp`、`workbuddy:title`
- 代理自产：`zcode:subagent_child | workflow_child | selection_side_chat`、`hermes:cron | subagent`

人类视图默认只显示前者；`includeAgents` 才把后者带进来。来源不是猜的——`zcode` 的 `session.task_type`、`hermes` 的 `sessions.source` 在导入时写进 `origin`，历史数据用 `cli/backfill-origin.js` 回填过。

### 1.3 主题表（两层）

`topics.json`（schema 2）：

```json
{
  "topics": [{ "id": "g05", "name": "DSH桌面应用与插件生态", "desc": "…",
               "annotation": "收…；边界是…", "keywords": ["dsh","插件"],
               "members": ["i20","i26","i31"] }],
  "fine":   [{ "id": "i20", "name": "DeepSeek Harness（DSH）桌面应用开发",
               "annotation": "…", "group": "g05" }]
}
```

`annotation`（评述）是分级召回的第一道过滤器，**可以手改**；重跑 `annotate-topics.mjs` 不会覆盖已有评述（除非 `--force`）。

### 1.4 段表

`segments.jsonl`，一行一段：

```json
{ "id": "session-…#3", "session": "…", "index": 3,
  "fromSeq": 589, "toSeq": 1204, "label": "排查跳转失效问题…",
  "hookIds": ["…"], "hooks": 2,
  "topicFine": "i20", "topic": "g05", "topicName": "…" }
```

### 1.5 当前方向

`pins.json`：`{ "pin": { "topic": "g05", "fine": "i20", "label": "…", "createdAt": "…", "ttlHours": 8 } }`。面板上选定后，**读**（注入）和**写**（新钩子归档）都跟着它走。

## 2. 数据怎么长出来

```
会话日志 ──bootstrap/autopilot──▶ 钩子（指针）
                                   │
                    两遍读归纳 ─────┴──▶ 主题表（12 宽类 + 81 细类 + 评述）
                                   │
                    逐条/逐段归类 ──┴──▶ 每个钩子的 topic/topicFine
                                   │
                    按会话切段 ─────┴──▶ segments.jsonl + 钩子的 segment/segLabel
```

### 2.1 两遍读归纳（`cli/induct-topics.mjs`）

| 阶段 | 命令 | 做什么 | 状态文件 |
|---|---|---|---|
| 第一遍 | `--pass 1` | 时间正序、一条一次调用，能归就归、归不进才新开 | `.induct/pass1.json` |
| 合并 | `--merge` | 问哪几对是同一个，合并重编号 | `.induct/final-topics.json` |
| 宽类 | `--group` | 把细线收成 12 个宽类 | `.induct/final-topics.grouped.json` |
| 第二遍 | `--pass 2` | 用定稿表重读全部材料，逐条落位（记 `NONE`） | `.induct/pass2.json` |

提示词版本记在状态文件里（`promptVersion`）。第一遍的约束是「主题是工作线、不是单次任务；一次性小任务挑最接近的线归进去」——没有这条时，8 条材料会长出 5 个主题。

### 2.2 落地（`cli/apply-induction.mjs`）

写 `topics.json`（两层 + 关键词 + 备份），再回写账本的 `topic`/`topicFine`；代理自产记录的旧主题被清空（它们不参与主题体系，但按定稿表归类）。

### 2.3 按段归类（`cli/segment-sessions.mjs`）

| 阶段 | 命令 | 做什么 |
|---|---|---|
| 切段 | `--build` | 每个多钩子会话一次调用，切成首尾相接的段；模型漏覆盖时补一段而不是整段作废 |
| 归类 | `--classify` | 一段一次调用，对定稿表落位 |
| 回填 | `--apply` | 段主题写回段内每条钩子 |
| 固化 | `--emit` | 写 `segments.jsonl`，并给钩子打 `segment`/`segLabel` |

### 2.4 维护（`cli/maintain.js`，计划任务每小时）

1. 缺 `topicFine` 的人类记录 → `--assign` + `--assign-apply`（限 20 条/次；判过 `NONE` 的不再重判）
2. 新的多钩子会话没切段 → `--build` + `--classify` + `--apply` + `--emit`
3. 清理过期备份

`cli/autopilot.cmd` 先跑 `autopilot.js`（重建最近会话），再跑 `maintain.js`。注意：重建出来的模块行会继承被覆盖轮次行的主题与 `origin`，否则每小时会把已归好的记忆洗回未打标。

## 3. 召回

### 3.1 三条路

| 路径 | 实现 | 何时用 |
|---|---|---|
| 分级判断 | `cli/recall-hier.mjs`（原型） | 目标：替代关键词；还没接生产 |
| 方向注入 | `lib/index.js` 的 `activePin()` | 面板选定方向后，直接按该类注入最近 5 条 |
| 关键词兜底 | `lib/store.js` 的 `searchHooks` | 没有方向时的默认路径；命中率低 |

### 3.2 注入单元

`lib/units.js` 把命中按段聚合成「单元」：命中段里任意一条，就带出整段的标签、seq 跨度和条数。生产路径与离线对账共用这份实现（环境变量 `DSH_WM_RECALL_UNIT=segment` 时启用）。

### 3.3 分级召回的三层

```
L1  12 条宽类评述（g12 不参评）        ~1.3k 字符
L2  选中宽类下的细类评述（含单元数）    ~0.2–2k 字符
L3  选中细类下的单元（日期 + 这段在做什么）~0.4–0.95k 字符
```

合计约 2.6k 字符 / 4.5 秒，对比「把 421 个单元一次性塞给模型」的 27k 字符。

## 4. 实测

| 指标 | 数值 |
|---|---|
| 关键词召回命中率 | 8.8%（80 题分层抽样）；干净样本 85/120 零命中 |
| 降阈值 A/B 盲评 | 更差（A 40%/70%，B 57.5%/57.5%，一致率 37.5% vs 35.0%） |
| 两遍一致率 | 细类 68.4%（399/583）、宽类 83.6%（469/561） |
| 第二遍未归类 | 3.8%（22 条） |
| 多钩子会话占比 | 41/250 个会话覆盖 64% 材料；36 个跨细类 |
| 分级召回原型 | 6 题 4 准；平均 2.6k 字符 / 4.5s |

## 5. 已知问题

1. **召回触发太少**是主因，不是单元粒度问题。下一步是把分级召回接进生产并做盲评。
2. 分级召回 L1 会判空（过于保守）；L3 候选集没扩到兄弟细类，相邻边界会落空。
3. 归纳/归类依赖模型（GLM），成本与延迟要控；`--limit` 与 `--dry-run` 是开关。
4. 账本存指针，删会话日志会让旧钩子失效。
5. `normalize()` 是历史教训：中间层丢字段（先是 `supersededBy`，后是 `topic`、`origin`、`topicFine`），每加一个字段都要补读回与自测断言。
