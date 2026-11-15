# panel — 会话视图面板（配套 DSH 插件）

这是 `session-view-plugin` 的源码，随本仓库一起维护。它读同一份工作记忆数据，把主题体系画出来：

- **三层导航**：宽类方块 → 宽类下的细线清单 → 细类的会话星图（会话节点 + 钩子点）→ 展开原文 / 打开会话；
- **来源过滤**：默认只看人提的需求，「含代理自产」开关把子代理任务书、cron 样板放进来；
- **记忆方向**：选宽类（可再选细线）设为「当前方向」——召回按它注入，新写入的记忆也归到这条线下；默认 8 小时过期；
- **新开模块**：在选中的宽类下加一条细类（写 `topics.json`，带备份），之后归类/召回/面板都能用；
- **会话详情按段分组**：一段一个虚线标题，下面才是那几条钩子。

## 安装

```bash
# 在 profile 里装成本地包（示例：desktop profile）
#   package.json 的 dependencies 加 "session-view-plugin": "file:D:/…/panel"
#   cordis.patch.yml 里 insert 一条 session-view-plugin
node scripts/install.mjs        # 同步到 profile（逐文件复制，带 .bak 备份）
```

Host 半改动需要重启 DSH；浏览器半改动刷新页面即可。

## 接口

| 路由 | 作用 |
|---|---|
| `GET /session-view/api/memory/snapshot` | 账本瘦身快照 + 主题表（topics + fine） |
| `GET /session-view/api/memory/hook?id=` | 单条钩子完整记录 |
| `GET/POST /session-view/api/memory/pin` | 读/写/清除「当前方向」 |
| `POST /session-view/api/memory/topic-new` | 在某个宽类下新开细类 |

## 测试

```bash
node scripts/host-test.mjs     # 快照整形（真账本）
node scripts/selftest.mjs      # 索引整形（fixture）
node scripts/render-test.mjs   # 三层渲染 + 开关 + 跳转（最小 React 垫片）
node scripts/route-test.mjs    # pin / topic-new 写接口（临时目录）
```
