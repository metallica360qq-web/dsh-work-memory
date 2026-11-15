/**
 * session-view-plugin — 会话视图 + 工作记忆图谱（浏览器半）。
 *
 * 形态：全局中央面板，三个视图。
 *   图谱   主题方块 → 径向星图（主题在中心，会话环绕，钩子从会话外扩）→ 会话详情抽屉
 *   会话   会话列表（按工作区分组，带「记忆 N」徽章）
 *   产物   产物路径按目录聚合，点文件看相关钩子
 *
 * 跨来源：会话节点不按 agent 分栏，只上色（dsh / hermes / zcode / workbuddy），
 * 同一个主题下不同 agent 的会话在同一圈上。
 *
 * 数据通路：
 *   会话：ctx.sessions.list / ctx.workspaces.list
 *   账本：GET /session-view/api/memory/snapshot（Host 半只读 hooks.jsonl 后整形）
 *   单条：GET /session-view/api/memory/hook?id=
 *   原文：GET /work-memory/api/open?id=（复用 dsh-work-memory）
 */
window.__ModuleLoader__.load({
  id: "session-view-plugin",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var PANEL_ID = "session-view";
    var PANEL_LABEL = "会话视图";
    var STYLE_ID = "session-view-plugin-styles";
    var WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    var MEMORY_SNAPSHOT = "/session-view/api/memory/snapshot";
    var MEMORY_HOOK = "/session-view/api/memory/hook";
    var MEMORY_TRANSCRIPT = "/work-memory/api/open";
    var MEMORY_PIN = "/session-view/api/memory/pin";
    var MEMORY_TOPIC_NEW = "/session-view/api/memory/topic-new";

    var EMPTY_SESSIONS = { ids: [], byId: {}, phase: "pending", projectionsBySession: {} };
    var EMPTY_WORKSPACES = { items: [], archivedSessionIds: [], pinnedSessionIds: [] };

    var AGENTS = [
      { id: "dsh", label: "DSH" },
      { id: "hermes", label: "Hermes" },
      { id: "zcode", label: "zcode" },
      { id: "workbuddy", label: "WorkBuddy" },
    ];

    var SCOPES = [
      { id: "all", label: "全部" },
      { id: "running", label: "运行中" },
      { id: "recent", label: "最近 7 天" },
      { id: "blank", label: "空白会话" },
      { id: "archived", label: "已归档" },
    ];

    var VIEWS = [
      { id: "graph", label: "图谱" },
      { id: "sessions", label: "会话" },
      { id: "artifacts", label: "产物" },
    ];

    // 星图画布（viewBox 坐标，实际按容器宽度等比缩放）
    var GRAPH_W = 1000;
    var GRAPH_H = 720;
    var GRAPH_CX = 500;
    var GRAPH_CY = 360;
    var HOOK_FAN_MAX = 12;
    var HOOK_FAN_RADIUS = 84;
    var LABEL_LIMIT = 12;
    /** 星图里单独成节点的会话上限；超出的和单钩子会话一起聚合成一个节点。 */
    var PRIMARY_NODE_CAP = 40;
    /** 「单次会话」聚合节点的伪会话 id。 */
    var TAIL_ID = "__tail__";

    var CSS = [
      ".svp-page{flex:1 1 auto;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);}",
      ".svp-view{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;}",
      ".svp-head{flex:none;display:flex;align-items:flex-end;gap:16px;padding:22px clamp(24px,4vw,48px) 12px;}",
      ".svp-head-titles{display:flex;flex-direction:column;gap:2px;min-width:0;}",
      ".svp-head-title{font-size:17px;font-weight:600;letter-spacing:.01em;}",
      ".svp-head-sub{font-size:12px;color:var(--dsw-alias-label-secondary);}",
      ".svp-head-spacer{flex:1 1 auto;}",
      ".svp-search{width:260px;max-width:34vw;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:13px;outline:none;}",
      ".svp-search:focus-visible{border-color:var(--dsw-alias-brand-primary);}",
      ".svp-btn{flex:none;padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease;}",
      ".svp-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);}",
      ".svp-btn:disabled{opacity:.55;cursor:default;}",
      ".svp-tabs{flex:none;display:flex;align-items:center;gap:4px;padding:0 clamp(24px,4vw,48px);border-bottom:1px solid var(--dsw-alias-border-l1);}",
      ".svp-tab{position:relative;padding:8px 12px 9px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;border-radius:6px 6px 0 0;}",
      ".svp-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);}",
      '.svp-tab[data-active="true"]{color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.svp-tab[data-active="true"]::after{content:"";position:absolute;left:10px;right:10px;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary);}',
      ".svp-tab-count{margin-left:6px;font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:400;}",
      ".svp-tabbar-spacer{flex:1 1 auto;}",
      ".svp-toolbar{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px clamp(24px,4vw,48px);border-bottom:1px solid var(--dsw-alias-border-l1);}",
      ".svp-chip{flex:none;padding:4px 11px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;}",
      ".svp-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}",
      '.svp-chip[data-active="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:600;}',
      ".svp-toolbar-spacer{flex:1 1 auto;}",
      ".svp-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;}",
      ".svp-check input{margin:0;accent-color:var(--dsw-alias-brand-primary);}",
      ".svp-select{padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:12px;cursor:pointer;max-width:220px;}",
      ".svp-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:18px clamp(24px,4vw,48px) 48px;}",
      ".svp-column{max-width:1040px;margin:0 auto;display:flex;flex-direction:column;gap:18px;}",
      ".svp-note{font-size:12px;color:var(--dsw-alias-label-secondary);}",
      ".svp-warn{font-size:12px;color:var(--dsw-alias-state-warn-primary);}",
      ".svp-crumb{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);}",
      ".svp-crumb button{border:none;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer;padding:0;}",
      ".svp-crumb button:hover{text-decoration:underline;}",
      ".svp-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(198px,1fr));gap:10px;}",
      ".svp-tile{display:flex;flex-direction:column;gap:7px;padding:12px 13px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;}",
      ".svp-tile:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);}",
      ".svp-tile-name{font-size:13.5px;font-weight:600;display:flex;align-items:center;gap:6px;}",
      ".svp-tile-nums{font-size:11.5px;color:var(--dsw-alias-label-secondary);}",
      ".svp-tile-bar{display:flex;height:5px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);}",
      ".svp-tile-seg{height:100%;min-width:2px;}",
      '.svp-tile-seg[data-agent="dsh"], .svp-pile-dot[data-agent="dsh"], .svp-swatch[data-agent="dsh"]{background:var(--dsw-alias-brand-primary);}',
      '.svp-tile-seg[data-agent="hermes"], .svp-pile-dot[data-agent="hermes"], .svp-swatch[data-agent="hermes"]{background:var(--dsw-alias-state-success-primary);}',
      '.svp-tile-seg[data-agent="zcode"], .svp-pile-dot[data-agent="zcode"], .svp-swatch[data-agent="zcode"]{background:var(--dsw-alias-state-warn-primary);}',
      '.svp-tile-seg[data-agent="workbuddy"], .svp-pile-dot[data-agent="workbuddy"], .svp-swatch[data-agent="workbuddy"]{background:var(--dsw-alias-state-idle-primary);}',
      ".svp-legend{display:flex;flex-wrap:wrap;align-items:center;gap:12px;font-size:11.5px;color:var(--dsw-alias-label-secondary);}",
      ".svp-legend-item{display:flex;align-items:center;gap:5px;}",
      ".svp-swatch{width:9px;height:9px;border-radius:2px;display:inline-block;}",
      ".svp-graph{width:100%;height:auto;display:block;overflow:visible;}",
      ".svp-graph-edge{stroke:var(--dsw-alias-border-l2);stroke-width:1.1;fill:none;opacity:.75;}",
      '.svp-graph-edge[data-selected="true"]{stroke:var(--dsw-alias-brand-primary);stroke-width:2;opacity:1;}',
      ".svp-graph-node{cursor:pointer;}",
      ".svp-graph-node circle{stroke:var(--dsw-alias-bg-base);stroke-width:1.5;}",
      '.svp-graph-node[data-agent="dsh"] circle{fill:var(--dsw-alias-brand-primary);}',
      '.svp-graph-node[data-agent="hermes"] circle{fill:var(--dsw-alias-state-success-primary);}',
      '.svp-graph-node[data-agent="zcode"] circle{fill:var(--dsw-alias-state-warn-primary);}',
      '.svp-graph-node[data-agent="workbuddy"] circle{fill:var(--dsw-alias-state-idle-primary);}',
      '.svp-graph-node[data-selected="true"] circle{stroke:var(--dsw-alias-label-primary);stroke-width:2.5;}',
      ".svp-tail-node circle{fill:var(--dsw-alias-bg-layer-2) !important;stroke:var(--dsw-alias-border-l2) !important;stroke-dasharray:3 3;}",
      ".svp-tail-count{font-size:12.5px;font-weight:600;fill:var(--dsw-alias-label-primary);pointer-events:none;}",
      ".svp-graph-label{font-size:11.5px;fill:var(--dsw-alias-label-primary);pointer-events:none;}",
      ".svp-graph-sublabel{font-size:10px;fill:var(--dsw-alias-label-secondary);pointer-events:none;}",
      ".svp-hub circle{fill:var(--dsw-alias-bg-layer-2);stroke:var(--dsw-alias-border-l2);stroke-width:1.5;}",
      ".svp-hub-label{font-size:12.5px;font-weight:600;fill:var(--dsw-alias-label-primary);}",
      ".svp-hook-dot{cursor:pointer;}",
      ".svp-hook-dot circle{fill-opacity:.55;stroke:var(--dsw-alias-bg-base);stroke-width:1;}",
      '.svp-hook-dot[data-agent="dsh"] circle{fill:var(--dsw-alias-brand-primary);}',
      '.svp-hook-dot[data-agent="hermes"] circle{fill:var(--dsw-alias-state-success-primary);}',
      '.svp-hook-dot[data-agent="zcode"] circle{fill:var(--dsw-alias-state-warn-primary);}',
      '.svp-hook-dot[data-agent="workbuddy"] circle{fill:var(--dsw-alias-state-idle-primary);}',
      '.svp-hook-dot[data-open="true"] circle{fill-opacity:1;stroke:var(--dsw-alias-label-primary);stroke-width:2;}',
      ".svp-fan-edge{stroke:var(--dsw-alias-border-l1);stroke-width:1;fill:none;}",
      ".svp-pile{display:flex;flex-wrap:wrap;gap:4px;}",
      ".svp-pile-dot{border:none;border-radius:50%;padding:0;cursor:pointer;opacity:.8;}",
      ".svp-pile-dot:hover{opacity:1;outline:1px solid var(--dsw-alias-label-primary);}",
      '.svp-pile-dot[data-selected="true"]{opacity:1;outline:2px solid var(--dsw-alias-label-primary);}',
      ".svp-detail{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1);}",
      ".svp-detail-head{display:flex;align-items:center;gap:10px;min-width:0;}",
      ".svp-detail-title{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".svp-detail-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;}",
      ".svp-detail-spacer{flex:1 1 auto;}",
      ".svp-hookrow{display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:8px;border:1px solid transparent;cursor:pointer;}",
      ".svp-hookrow:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);}",
      '.svp-hookrow[data-open="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);}',
      ".svp-hookrow-seq{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;min-width:74px;}",
      ".svp-hookrow-title{flex:1 1 auto;min-width:0;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".svp-hookrow-date{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);}",
      ".svp-hookbody{padding:4px 8px 8px 91px;display:flex;flex-direction:column;gap:4px;}",
      ".svp-hook-ask{font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;}",
      ".svp-artifact-path{font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-all;}",
      ".svp-pre{white-space:pre-wrap;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;max-height:340px;overflow:auto;font-size:12px;line-height:1.55;margin:4px 0 0;}",
      ".svp-group-head{display:flex;align-items:center;gap:8px;padding:0 2px 6px;min-width:0;}",
      ".svp-collapse{flex:none;width:18px;height:18px;display:flex;align-items:center;justify-content:center;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:9px;line-height:1;cursor:pointer;padding:0;}",
      ".svp-collapse:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}",
      ".svp-group-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".svp-group-path{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;}",
      ".svp-group-spacer{flex:1 1 auto;}",
      ".svp-group-count{flex:none;font-size:12px;color:var(--dsw-alias-label-secondary);}",
      ".svp-group-add{flex:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;padding:2px 6px;border-radius:6px;}",
      ".svp-group-add:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}",
      ".svp-rows{display:flex;flex-direction:column;gap:2px;}",
      ".svp-row{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;text-align:left;padding:8px 10px;border-radius:8px;border:1px solid transparent;background:transparent;color:inherit;font:inherit;cursor:pointer;transition:background .12s ease,border-color .12s ease;}",
      ".svp-row:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1);}",
      '.svp-row[data-current="true"]{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1);}',
      '.svp-row[data-openable="false"]{cursor:default;opacity:.62;}',
      '.svp-row[data-openable="false"]:hover{background:transparent;border-color:transparent;}',
      ".svp-dot{flex:none;width:8px;height:8px;border-radius:50%;box-sizing:border-box;}",
      '.svp-dot[data-running="true"]{background:var(--dsw-alias-state-success-primary);}',
      '.svp-dot[data-running="false"]{border:1.5px solid var(--dsw-alias-border-l2);}',
      ".svp-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}",
      ".svp-title{display:flex;align-items:center;gap:6px;min-width:0;font-size:13.5px;}",
      ".svp-title-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".svp-badges{flex:none;display:flex;align-items:center;gap:4px;}",
      ".svp-badge{font-size:10.5px;line-height:15px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap;}",
      '.svp-badge[data-tone="accent"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}',
      '.svp-badge[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);}',
      '.svp-badge[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);}',
      ".svp-mem-pill{flex:none;font-size:11px;line-height:18px;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;}",
      ".svp-mem-pill:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);}",
      ".svp-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".svp-go{flex:none;font-size:12px;color:var(--dsw-alias-label-secondary);opacity:0;transition:opacity .12s ease;}",
      ".svp-row:hover .svp-go{opacity:1;}",
      ".svp-empty{padding:56px 12px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:6px;align-items:center;}",
      ".svp-empty-title{font-size:14px;color:var(--dsw-alias-label-primary);}",
      ".svp-dir{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;}",
      ".svp-dir-head{display:flex;align-items:center;gap:8px;padding:8px 11px;background:var(--dsw-alias-bg-layer-1);font-size:12px;}",
      ".svp-dir-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);}",
      ".svp-file{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 11px;border:none;border-top:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;text-align:left;}",
      ".svp-file:hover{background:var(--dsw-alias-bg-layer-1);}",
      ".svp-file-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".svp-line{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;text-align:left;padding:9px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:transparent;color:inherit;font:inherit;cursor:pointer;}",
      ".svp-line:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);}",
      ".svp-line-name{flex:1 1 auto;min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".svp-line-meta{flex:none;font-size:11.5px;color:var(--dsw-alias-label-secondary);}",
      ".svp-seg-label{margin-top:6px;padding:3px 2px 1px;font-size:11.5px;color:var(--dsw-alias-label-secondary);border-top:1px dashed var(--dsw-alias-border-l1);}",
      ".svp-direction{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);margin-bottom:10px;}",
      ".svp-direction-title{font-size:12px;color:var(--dsw-alias-label-secondary);}",
      ".svp-direction-active{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-brand-primary);}",
      ".svp-select{height:26px;padding:0 6px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:inherit;font:inherit;font-size:12px;max-width:260px;}",
      ".svp-newmodule{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;margin-bottom:10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;}",
      ".svp-btn-quiet{background:transparent;border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);}",
      ".svp-file-count{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);}",
      "@media (max-width:820px){.svp-search{width:180px;max-width:40vw;}.svp-group-path{display:none;}}",
    ].join("");

    // ── 小工具 ────────────────────────────────────────────────────────────────

    function h(tag) {
      var children = Array.prototype.slice.call(arguments, 2);
      var props = arguments[1] || null;
      if (children.length === 0) return React.createElement(tag, props);
      var merged = {};
      if (props !== null) {
        for (var key in props) {
          if (Object.prototype.hasOwnProperty.call(props, key)) merged[key] = props[key];
        }
      }
      merged.children = children.length === 1 ? children[0] : children;
      return React.createElement(tag, merged);
    }

    function pad2(n) {
      return n < 10 ? "0" + n : String(n);
    }

    function relativeTime(ms, now) {
      if (!Number.isFinite(ms) || ms <= 0) return "";
      var diff = now - ms;
      if (diff < 0) return "刚刚";
      if (diff < 45 * 1000) return "刚刚";
      if (diff < 60 * 60 * 1000) return Math.max(1, Math.round(diff / 60000)) + " 分钟前";
      if (diff < 24 * 60 * 60 * 1000) return Math.round(diff / 3600000) + " 小时前";
      if (diff < 2 * 24 * 60 * 60 * 1000) return "昨天";
      if (diff < 30 * 24 * 60 * 60 * 1000) return Math.round(diff / 86400000) + " 天前";
      var date = new Date(ms);
      var today = new Date(now);
      if (date.getFullYear() === today.getFullYear()) {
        return date.getMonth() + 1 + " 月 " + date.getDate() + " 日";
      }
      return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
    }

    function baseName(path) {
      if (typeof path !== "string" || path === "") return "";
      var parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
      return parts[parts.length - 1] || path;
    }

    function dirName(path) {
      if (typeof path !== "string" || path === "") return "";
      var normalized = path.replace(/[\\/]+$/, "");
      var index = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
      return index > 0 ? normalized.slice(0, index) : normalized;
    }

    function shortId(id) {
      if (typeof id !== "string") return "";
      var stripped = id.replace(/^session-/, "");
      return stripped.length > 10 ? stripped.slice(0, 8) : stripped;
    }

    function shortDate(ts) {
      var text = String(ts || "");
      return text.length >= 10 ? text.slice(0, 10) : text;
    }

    function agentLabel(id) {
      for (var i = 0; i < AGENTS.length; i += 1) {
        if (AGENTS[i].id === id) return AGENTS[i].label;
      }
      return String(id || "?");
    }

    function truncate(text, max) {
      var value = String(text === undefined || text === null ? "" : text);
      return value.length > max ? value.slice(0, max - 1) + "…" : value;
    }

    function ensureStyle() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID) !== null) return;
      var element = document.createElement("style");
      element.id = STYLE_ID;
      element.textContent = CSS;
      document.head.appendChild(element);
    }

    function useObs(source, fallback) {
      var subscribe = React.useCallback(
        function (onChange) {
          if (source === undefined || source === null || typeof source.subscribe !== "function") {
            return function () {};
          }
          try {
            return source.subscribe(onChange);
          } catch (error) {
            return function () {};
          }
        },
        [source]
      );
      var read = React.useCallback(
        function () {
          if (source === undefined || source === null || typeof source.getSnapshot !== "function") return fallback;
          try {
            return source.getSnapshot();
          } catch (error) {
            return fallback;
          }
        },
        [source, fallback]
      );
      return React.useSyncExternalStore(subscribe, read, read);
    }

    function useTicker(interval) {
      var state = React.useState(0);
      var tick = state[1];
      React.useEffect(function () {
        var handle = setInterval(function () {
          tick(function (value) {
            return value + 1;
          });
        }, interval);
        return function () {
          clearInterval(handle);
        };
      }, [interval, tick]);
      return Date.now();
    }

    function getJson(url) {
      return fetch(url, { cache: "no-store", headers: { accept: "application/json" } }).then(function (res) {
        return res.json().then(function (json) {
          if (!res.ok) throw new Error((json && json.error) || "HTTP " + res.status);
          return json;
        });
      });
    }

    function postJson(url, body) {
      return fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body || {}),
      }).then(function (res) {
        return res.json().then(function (json) {
          if (!res.ok) throw new Error((json && json.error) || "HTTP " + res.status);
          return json;
        });
      });
    }

    // ── 会话整形 ──────────────────────────────────────────────────────────────

    function buildSessionModel(list, wss, options) {
      var ids = list.ids || [];
      var byId = list.byId || {};
      var items = wss.items || [];
      var archived = wss.archivedSessionIds || [];
      var pinned = wss.pinnedSessionIds || [];

      var archivedSet = {};
      for (var a = 0; a < archived.length; a++) archivedSet[archived[a]] = true;
      var pinRank = {};
      for (var p = 0; p < pinned.length; p++) pinRank[pinned[p]] = p;

      var workspaceOfSession = {};
      for (var w = 0; w < items.length; w++) {
        var sessionIds = items[w].sessionIds || [];
        for (var s = 0; s < sessionIds.length; s++) workspaceOfSession[sessionIds[s]] = items[w];
      }

      var memoryCounts = options.memoryCounts || {};
      var currentId;
      for (var c = 0; c < ids.length; c++) {
        var candidate = byId[ids[c]];
        if (candidate !== undefined && candidate.retainedBy !== undefined
          && (candidate.retainedBy.mainView || 0) > 0) {
          currentId = ids[c];
          break;
        }
      }

      var query = typeof options.query === "string" ? options.query.trim().toLowerCase() : "";
      var total = 0;
      var running = 0;
      var archivedTotal = 0;
      var withMemory = 0;
      var rows = [];
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var summary = byId[id];
        if (summary === undefined || summary === null) continue;
        var isArchived = archivedSet[id] === true;
        var isSubagent = summary.origin === "subagent";
        var memCount = memoryCounts[id] || 0;
        if (!isSubagent) {
          total += 1;
          if (summary.running === true) running += 1;
          if (isArchived) archivedTotal += 1;
          if (memCount > 0) withMemory += 1;
        }
        if (isSubagent && options.showSubagents !== true) continue;
        if (options.onlyWithMemory === true && memCount === 0) continue;
        if (options.scope === "archived") {
          if (!isArchived) continue;
        } else if (isArchived) {
          continue;
        }
        if (options.scope === "running" && summary.running !== true) continue;
        if (options.scope === "recent" && !(options.now - (summary.updatedAt || 0) < WEEK_MS)) continue;
        if (options.scope === "blank" && summary.blank !== true) continue;

        var title = summary.displayTitle || summary.title || id;
        if (query !== "") {
          var haystack = (title + "\n" + (summary.cwd || "") + "\n" + id + "\n" + (summary.parentId || "")).toLowerCase();
          if (haystack.indexOf(query) === -1) continue;
        }
        rows.push({
          id: id,
          title: title,
          cwd: summary.cwd || "",
          updatedAt: summary.updatedAt || 0,
          running: summary.running === true,
          blank: summary.blank === true,
          subagent: isSubagent,
          parentId: summary.parentId || "",
          archived: isArchived,
          pinned: pinRank[id] !== undefined,
          pinRank: pinRank[id] === undefined ? Number.MAX_SAFE_INTEGER : pinRank[id],
          current: id === currentId,
          memCount: memCount,
          workspace: workspaceOfSession[id],
        });
      }

      var groups = [];
      var groupIndexOf = {};
      for (var g = 0; g < items.length; g++) {
        var item = items[g];
        if (item === undefined || item === null) continue;
        groupIndexOf[item.workspaceId] = groups.length;
        groups.push({
          key: "ws:" + item.workspaceId,
          title: item.title || baseName(item.path) || String(item.workspaceId),
          path: item.path || "",
          workspaceId: item.workspaceId,
          rows: [],
        });
      }

      var orphan = null;
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        var owner = row.workspace;
        var index = owner === undefined ? undefined : groupIndexOf[owner.workspaceId];
        if (index !== undefined) {
          groups[index].rows.push(row);
          continue;
        }
        if (orphan === null) {
          orphan = { key: "orphan", title: "未归入工作区", path: "", workspaceId: undefined, rows: [] };
        }
        orphan.rows.push(row);
      }
      if (orphan !== null) groups.push(orphan);

      var compare = options.sort === "title"
        ? function (left, right) { return left.title.localeCompare(right.title, "zh-Hans-CN"); }
        : function (left, right) {
          if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
          if (left.pinned && right.pinned) return left.pinRank - right.pinRank;
          return right.updatedAt - left.updatedAt;
        };

      var visible = [];
      var visibleCount = 0;
      for (var gi = 0; gi < groups.length; gi++) {
        var group = groups[gi];
        if (group.rows.length === 0) continue;
        group.rows.sort(compare);
        visibleCount += group.rows.length;
        visible.push(group);
      }

      return {
        total: total,
        running: running,
        archivedTotal: archivedTotal,
        withMemory: withMemory,
        currentId: currentId,
        groups: visible,
        visibleCount: visibleCount,
        pending: list.phase !== "ready" && ids.length === 0,
      };
    }

    // ── 账本整形（主题 → 会话 → 钩子） ───────────────────────────────────────

    /** 算「人提的需求」的来源白名单（与 dsh-work-memory/lib/origin.js 同一口径）。 */
    var HUMAN_ORIGINS = {
      "dsh:user": true,
      "zcode:interactive": true,
      "hermes:desktop": true,
      "hermes:tui": true,
      "hermes:cli": true,
      "hermes:acp": true,
      "hermes:app": true,
      "hermes:web": true,
      "workbuddy:title": true,
      "workbuddy:session": true,
    };

    /**
     * 这条钩子是不是「人提的需求」（而不是子代理任务书、cron 样板）。
     * 没有 origin 的老记录按人算。
     * @param {string} origin 来源串。
     * @returns {boolean} true 表示人类需求。
     */
    function isHumanOrigin(origin) {
      if (typeof origin !== "string" || origin === "") return true;
      if (HUMAN_ORIGINS[origin] === true) return true;
      return origin.indexOf(":unknown") !== -1;
    }

    function buildMemoryIndex(snapshot, options) {
      if (snapshot === null || snapshot === undefined || snapshot.ok !== true) return null;
      var includeAgents = options !== undefined && options !== null && options.includeAgents === true;
      var allHooks = Array.isArray(snapshot.hooks) ? snapshot.hooks.slice() : [];
      var humanTotal = 0;
      for (var hi = 0; hi < allHooks.length; hi += 1) {
        if (isHumanOrigin(allHooks[hi].origin)) humanTotal += 1;
      }
      var hooks = includeAgents
        ? allHooks
        : allHooks.filter(function (hook) { return isHumanOrigin(hook.origin); });
      hooks.sort(function (left, right) { return String(right.ts).localeCompare(String(left.ts)); });
      var topicDefs = Array.isArray(snapshot.topics) ? snapshot.topics : [];
      var topicById = {};
      for (var t = 0; t < topicDefs.length; t += 1) topicById[topicDefs[t].id] = topicDefs[t];
      // 第二层：细类（i01…i81），属于某个宽类（group）
      var fineDefs = Array.isArray(snapshot.fine) ? snapshot.fine : [];
      var fineById = {};
      for (var fi = 0; fi < fineDefs.length; fi += 1) fineById[fineDefs[fi].id] = fineDefs[fi];

      var agents = {};
      var bySession = {};
      var byMonth = {};
      var byTopic = {};
      var topicSessions = {};
      var fineSessions = {};
      var pathHooks = {};
      var stats = {
        total: hooks.length,
        tagged: 0,
        untagged: 0,
        withArtifacts: 0,
        artifactPaths: 0,
        sessions: 0,
        humanTotal: humanTotal,
        agentTotal: allHooks.length - humanTotal,
        includeAgents: includeAgents,
      };

      for (var i = 0; i < hooks.length; i += 1) {
        var hook = hooks[i];
        agents[hook.agent] = (agents[hook.agent] || 0) + 1;
        if (hook.topic === "") stats.untagged += 1; else stats.tagged += 1;

        var topicKey = hook.topic === "" ? "" : hook.topic;
        if (byTopic[topicKey] === undefined) byTopic[topicKey] = { total: 0, byAgent: {} };
        byTopic[topicKey].total += 1;
        byTopic[topicKey].byAgent[hook.agent] = (byTopic[topicKey].byAgent[hook.agent] || 0) + 1;

        if (topicSessions[topicKey] === undefined) topicSessions[topicKey] = {};
        var topicMap = topicSessions[topicKey];
        if (topicMap[hook.session] === undefined) {
          topicMap[hook.session] = { id: hook.session, agent: hook.agent, hooks: [], count: 0, latest: "" };
        }
        var sessionRecord = topicMap[hook.session];
        sessionRecord.hooks.push(hook);
        sessionRecord.count += 1;
        if (String(hook.ts) > sessionRecord.latest) sessionRecord.latest = String(hook.ts);

        // 第二层：按细类再聚一遍（细类 id 落在 hook.topicFine 上）
        var fineKey = typeof hook.topicFine === "string" ? hook.topicFine : "";
        if (fineKey !== "") {
          if (fineSessions[fineKey] === undefined) fineSessions[fineKey] = {};
          var fineMap = fineSessions[fineKey];
          if (fineMap[hook.session] === undefined) {
            fineMap[hook.session] = { id: hook.session, agent: hook.agent, hooks: [], count: 0, latest: "" };
          }
          var fineRecord = fineMap[hook.session];
          fineRecord.hooks.push(hook);
          fineRecord.count += 1;
          if (String(hook.ts) > fineRecord.latest) fineRecord.latest = String(hook.ts);
        }

        var monthKey = String(hook.ts || "").slice(0, 7);
        if (byMonth[monthKey] === undefined) byMonth[monthKey] = { key: monthKey, total: 0, byAgent: {} };
        byMonth[monthKey].total += 1;
        byMonth[monthKey].byAgent[hook.agent] = (byMonth[monthKey].byAgent[hook.agent] || 0) + 1;

        if (bySession[hook.session] === undefined) bySession[hook.session] = [];
        bySession[hook.session].push(hook);

        if (hook.artifacts.length > 0) {
          stats.withArtifacts += 1;
          for (var f = 0; f < hook.artifacts.length; f += 1) {
            var artifactPath = hook.artifacts[f];
            if (pathHooks[artifactPath] === undefined) pathHooks[artifactPath] = [];
            pathHooks[artifactPath].push(hook.id);
          }
        }
      }

      stats.sessions = Object.keys(bySession).length;
      stats.artifactPaths = Object.keys(pathHooks).length;

      var dirs = {};
      for (var artifact in pathHooks) {
        if (!Object.prototype.hasOwnProperty.call(pathHooks, artifact)) continue;
        var dir = dirName(artifact);
        if (dirs[dir] === undefined) dirs[dir] = { dir: dir, count: 0, files: [] };
        dirs[dir].count += pathHooks[artifact].length;
        dirs[dir].files.push({ path: artifact, count: pathHooks[artifact].length });
      }
      var dirList = Object.keys(dirs).map(function (key) { return dirs[key]; });
      dirList.sort(function (left, right) { return right.count - left.count; });
      for (var d = 0; d < dirList.length; d += 1) {
        dirList[d].files.sort(function (left, right) { return right.count - left.count; });
      }

      var topicRows = topicDefs.map(function (topic) {
        var row = byTopic[topic.id];
        return {
          id: topic.id,
          name: topic.name,
          desc: topic.desc || "",
          keywords: topic.keywords || [],
          total: row === undefined ? 0 : row.total,
          byAgent: row === undefined ? {} : row.byAgent,
        };
      });
      topicRows.sort(function (left, right) { return right.total - left.total; });

      var untaggedRow = byTopic[""] === undefined ? { total: 0, byAgent: {} } : byTopic[""];

      var topicNodes = {};
      for (var topicKey2 in topicSessions) {
        if (!Object.prototype.hasOwnProperty.call(topicSessions, topicKey2)) continue;
        var sessions = [];
        var map = topicSessions[topicKey2];
        for (var sessionId in map) {
          if (!Object.prototype.hasOwnProperty.call(map, sessionId)) continue;
          var entry = map[sessionId];
          entry.hooks.sort(function (left, right) { return left.startSeq - right.startSeq; });
          sessions.push(entry);
        }
        sessions.sort(function (left, right) {
          if (right.count !== left.count) return right.count - left.count;
          return String(right.latest).localeCompare(String(left.latest));
        });
        topicNodes[topicKey2] = {
          id: topicKey2,
          sessions: sessions,
          hooksTotal: byTopic[topicKey2].total,
          sessionCount: sessions.length,
          agents: byTopic[topicKey2].byAgent,
        };
      }

      // 细类节点：与宽类同构（sessions + hooksTotal + sessionCount），星图直接用
      var fineNodes = {};
      for (var fineKey2 in fineSessions) {
        if (!Object.prototype.hasOwnProperty.call(fineSessions, fineKey2)) continue;
        var fineList = [];
        var fineMap2 = fineSessions[fineKey2];
        for (var fineSessionId in fineMap2) {
          if (!Object.prototype.hasOwnProperty.call(fineMap2, fineSessionId)) continue;
          var fineEntry = fineMap2[fineSessionId];
          fineEntry.hooks.sort(function (left, right) { return left.startSeq - right.startSeq; });
          fineList.push(fineEntry);
        }
        fineList.sort(function (left, right) {
          if (right.count !== left.count) return right.count - left.count;
          return String(right.latest).localeCompare(String(left.latest));
        });
        var fineHooks = 0;
        for (var fl = 0; fl < fineList.length; fl += 1) fineHooks += fineList[fl].count;
        var fineDef = fineById[fineKey2];
        fineNodes[fineKey2] = {
          id: fineKey2,
          name: fineDef === undefined ? fineKey2 : fineDef.name,
          group: fineDef === undefined ? "" : fineDef.group,
          sessions: fineList,
          hooksTotal: fineHooks,
          sessionCount: fineList.length,
        };
      }

      // 宽类 → 细类清单（按材料数降序），中间层用
      var fineByGroup = {};
      for (var fd = 0; fd < fineDefs.length; fd += 1) {
        var def = fineDefs[fd];
        var node = fineNodes[def.id];
        if (node === undefined) continue;
        if (fineByGroup[def.group] === undefined) fineByGroup[def.group] = [];
        var latest = "";
        for (var fs = 0; fs < node.sessions.length; fs += 1) {
          if (node.sessions[fs].latest > latest) latest = node.sessions[fs].latest;
        }
        fineByGroup[def.group].push({
          id: def.id,
          name: def.name,
          desc: def.desc || "",
          hooks: node.hooksTotal,
          sessions: node.sessionCount,
          lastTs: latest,
        });
      }
      for (var fg in fineByGroup) {
        if (!Object.prototype.hasOwnProperty.call(fineByGroup, fg)) continue;
        fineByGroup[fg].sort(function (left, right) { return right.hooks - left.hooks; });
      }

      return {
        hooks: hooks,
        source: snapshot.source || null,
        generatedAt: snapshot.generatedAt || "",
        topicDefs: topicDefs,
        topicById: topicById,
        topicRows: topicRows,
        fineDefs: fineDefs,
        fineById: fineById,
        fineNodes: fineNodes,
        fineByGroup: fineByGroup,
        untagged: { id: "", name: "未打标", desc: "没打上主题的钩子", total: untaggedRow.total, byAgent: untaggedRow.byAgent },
        topicNodes: topicNodes,
        agents: agents,
        bySession: bySession,
        months: Object.keys(byMonth).sort().map(function (key) { return byMonth[key]; }),
        dirs: dirList,
        pathHooks: pathHooks,
        stats: stats,
      };
    }

    // ── 组件 ──────────────────────────────────────────────────────────────────

    function SessionsIcon(props) {
      var size = props !== null && props !== undefined && Number.isFinite(props.size) ? props.size : 16;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("rect", { x: 2.25, y: 2.25, width: 11.5, height: 11.5, rx: 2.5 }),
        h("path", { d: "M5 5.9h6M5 8.5h6M5 11.1h3.4" })
      );
    }

    function SessionsPanel() {
      var services = panelServices;
      var sessions = services.sessions;
      var workspaces = services.workspaces;
      var uiWorkspace = services.uiWorkspace;

      var list = useObs(sessions === undefined || sessions === null ? undefined : sessions.list, EMPTY_SESSIONS);
      var workspaceList = useObs(workspaces === undefined || workspaces === null ? undefined : workspaces.list, EMPTY_WORKSPACES);
      var now = useTicker(30000);

      var viewState = React.useState("graph");
      var view = viewState[0];
      var setView = viewState[1];
      var queryState = React.useState("");
      var query = queryState[0];
      var setQuery = queryState[1];
      var scopeState = React.useState("all");
      var scope = scopeState[0];
      var setScope = scopeState[1];
      var sortState = React.useState("recent");
      var sort = sortState[0];
      var setSort = sortState[1];
      var subagentState = React.useState(false);
      var showSubagents = subagentState[0];
      var setShowSubagents = subagentState[1];
      var onlyMemState = React.useState(false);
      var onlyWithMemory = onlyMemState[0];
      var setOnlyWithMemory = onlyMemState[1];
      var collapsedState = React.useState({});
      var collapsed = collapsedState[0];
      var setCollapsed = collapsedState[1];
      var refreshingState = React.useState(false);
      var refreshing = refreshingState[0];
      var setRefreshing = refreshingState[1];

      var memoryState = React.useState({ status: "idle", data: null, error: null });
      var memory = memoryState[0];
      var setMemory = memoryState[1];
      var agentsState = React.useState(false);
      var includeAgents = agentsState[0];
      var setIncludeAgents = agentsState[1];
      var pinState = React.useState(null);
      var pin = pinState[0];
      var setPin = pinState[1];
      var pinPickState = React.useState("");
      var pinPick = pinPickState[0];
      var setPinPick = pinPickState[1];
      var pinFineState = React.useState("");
      var pinFinePick = pinFineState[0];
      var setPinFinePick = pinFineState[1];
      var newModuleState = React.useState(false);
      var newModuleOpen = newModuleState[0];
      var setNewModuleOpen = newModuleState[1];
      var newNameState = React.useState("");
      var newName = newNameState[0];
      var setNewName = newNameState[1];
      var newAnnState = React.useState("");
      var newAnn = newAnnState[0];
      var setNewAnn = newAnnState[1];
      var topicState = React.useState("");
      var graphTopic = topicState[0];
      var setGraphTopic = topicState[1];
      // 三层：宽类（graphGroup）→ 细类（graphTopic）→ 会话/钩子
      var groupState = React.useState("");
      var graphGroup = groupState[0];
      var setGraphGroup = groupState[1];
      var sessionState = React.useState("");
      var graphSession = sessionState[0];
      var setGraphSession = sessionState[1];
      var tailLimitState = React.useState(60);
      var tailLimit = tailLimitState[0];
      var setTailLimit = tailLimitState[1];
      var openHookState = React.useState("");
      var openHook = openHookState[0];
      var setOpenHook = openHookState[1];
      var detailState = React.useState({ id: "", status: "idle", hook: null, error: null });
      var detail = detailState[0];
      var setDetail = detailState[1];
      var transcriptState = React.useState({ id: "", status: "idle", text: "", error: null });
      var transcript = transcriptState[0];
      var setTranscript = transcriptState[1];

      var loadMemory = React.useCallback(function () {
        setMemory(function (previous) {
          return { status: "loading", data: previous.data, error: null };
        });
        getJson(MEMORY_SNAPSHOT)
          .then(function (json) {
            if (json === null || json.ok !== true) throw new Error((json && json.error) || "账本快照读取失败");
            setMemory({ status: "ready", data: json, error: null });
          })
          .catch(function (error) {
            setMemory({ status: "error", data: null, error: String(error && error.message ? error.message : error) });
          });
      }, [setMemory]);

      React.useEffect(function () {
        loadMemory();
      }, [loadMemory]);

      // 当前工作方向（面板上选的标签），召回按它注入
      React.useEffect(function () {
        getJson(MEMORY_PIN)
          .then(function (json) { setPin(json.pin || null); })
          .catch(function () { setPin(null); });
      }, [setPin]);

      var index = React.useMemo(function () {
        return buildMemoryIndex(memory.data, { includeAgents: includeAgents });
      }, [memory.data, includeAgents]);

      var memoryCounts = React.useMemo(function () {
        var counts = {};
        if (index === null) return counts;
        for (var sessionId in index.bySession) {
          if (Object.prototype.hasOwnProperty.call(index.bySession, sessionId)) {
            counts[sessionId] = index.bySession[sessionId].length;
          }
        }
        return counts;
      }, [index]);

      var model = React.useMemo(function () {
        return buildSessionModel(list, workspaceList, {
          query: view === "sessions" ? query : "",
          scope: scope,
          sort: sort,
          showSubagents: showSubagents,
          onlyWithMemory: onlyWithMemory,
          now: now,
          memoryCounts: memoryCounts,
        });
      }, [list, workspaceList, query, view, scope, sort, showSubagents, onlyWithMemory, now, memoryCounts]);

      function refresh() {
        if (refreshing) return;
        setRefreshing(true);
        var tasks = [];
        if (sessions !== undefined && sessions !== null && typeof sessions.refresh === "function") {
          tasks.push(Promise.resolve().then(function () { return sessions.refresh(); }).catch(function () {}));
        }
        tasks.push(Promise.resolve().then(function () { loadMemory(); }).catch(function () {}));
        Promise.all(tasks).then(function () { setRefreshing(false); });
      }

      function openSession(sessionId) {
        if (uiWorkspace === undefined || uiWorkspace === null || typeof uiWorkspace.openSession !== "function") return;
        try {
          uiWorkspace.openSession(sessionId);
        } catch (error) {
          // DSH 自己会提示（归档/不存在）
        }
      }

      function startSession(workspaceId) {
        if (uiWorkspace === undefined || uiWorkspace === null || typeof uiWorkspace.startSession !== "function") return;
        try {
          uiWorkspace.startSession(workspaceId);
        } catch (error) {
          // 同上
        }
      }

      function toggleGroup(key) {
        setCollapsed(function (previous) {
          var next = {};
          for (var existing in previous) {
            if (Object.prototype.hasOwnProperty.call(previous, existing)) next[existing] = previous[existing];
          }
          if (next[key] === true) delete next[key];
          else next[key] = true;
          return next;
        });
      }

      function openOverview() {
        setGraphGroup("");
        setGraphTopic("");
        setGraphSession("");
        setOpenHook("");
      }

      /** 进宽类：看它下面的细线清单。 */
      function openGroup(groupId) {
        setGraphGroup(groupId);
        setGraphTopic("");
        setGraphSession("");
        setOpenHook("");
      }

      /** 进细类：看这个细类的会话星图。 */
      function openFine(fineId) {
        setGraphTopic(fineId);
        setGraphSession("");
        setOpenHook("");
      }

      /** 未打标的散点视图。 */
      function openPile() {
        setGraphGroup("");
        setGraphTopic("none");
        setGraphSession("");
        setOpenHook("");
      }

      /** 把选中的宽类/细类设为当前工作方向。 */
      function applyDirection() {
        if (pinPick === "") return;
        var label = "";
        if (index !== null) {
          if (pinFinePick !== "" && index.fineById[pinFinePick] !== undefined) label = index.fineById[pinFinePick].name;
          else if (index.topicById[pinPick] !== undefined) label = index.topicById[pinPick].name;
        }
        postJson(MEMORY_PIN, { topic: pinPick, fine: pinFinePick, label: label })
          .then(function (json) { setPin(json.pin || null); })
          .catch(function (error) { console.warn("[session-view] 设置记忆方向失败", error); });
      }

      /** 清除当前工作方向，召回回到自动判断。 */
      function clearDirection() {
        postJson(MEMORY_PIN, { clear: true })
          .then(function () { setPin(null); })
          .catch(function (error) { console.warn("[session-view] 清除记忆方向失败", error); });
      }

      /** 在选中的宽类下新开一个模块（细类）。 */
      function createModule() {
        var name = newName.trim();
        if (name === "" || pinPick === "") return;
        postJson(MEMORY_TOPIC_NEW, { group: pinPick, name: name, annotation: newAnn.trim() })
          .then(function () {
            setNewModuleOpen(false);
            setNewName("");
            setNewAnn("");
            loadMemory();
          })
          .catch(function (error) { console.warn("[session-view] 新开模块失败", error); });
      }

      function selectSession(sessionId) {
        setGraphSession(graphSession === sessionId ? "" : sessionId);
        setOpenHook("");
      }

      function loadDetail(hookId) {
        if (detail.id === hookId && detail.status !== "idle") return;
        setDetail({ id: hookId, status: "loading", hook: null, error: null });
        getJson(MEMORY_HOOK + "?id=" + encodeURIComponent(hookId))
          .then(function (json) {
            if (json === null || json.ok !== true) throw new Error((json && json.error) || "读取失败");
            setDetail({ id: hookId, status: "ready", hook: json.hook, error: null });
          })
          .catch(function (error) {
            setDetail({ id: hookId, status: "error", hook: null, error: String(error && error.message ? error.message : error) });
          });
      }

      function loadTranscript(hook) {
        if (transcript.id === hook.id && transcript.status === "ready") {
          setTranscript({ id: "", status: "idle", text: "", error: null });
          return;
        }
        setTranscript({ id: hook.id, status: "loading", text: "", error: null });
        getJson(MEMORY_TRANSCRIPT + "?id=" + encodeURIComponent(hook.id) + "&maxChars=6000")
          .then(function (json) {
            if (json === null || json.text === undefined) throw new Error((json && json.error) || "读取失败");
            setTranscript({ id: hook.id, status: "ready", text: String(json.text), error: null });
          })
          .catch(function (error) {
            setTranscript({ id: hook.id, status: "error", text: "", error: String(error && error.message ? error.message : error) });
          });
      }

      function toggleHook(hook) {
        if (openHook === hook.id) {
          setOpenHook("");
          return;
        }
        setOpenHook(hook.id);
        loadDetail(hook.id);
      }

      function sessionExists(sessionId) {
        var map = list.byId || {};
        return map[sessionId];
      }

      function labelOfSession(sessionId, hooks) {
        var known = sessionExists(sessionId);
        if (known !== undefined && known.displayTitle) return known.displayTitle;
        if (hooks !== undefined && hooks.length > 0) {
          var first = hooks[0];
          if (first.title !== "") return first.title;
        }
        return shortId(sessionId) || sessionId;
      }

      // ── 会话视图 ────────────────────────────────────────────────────────────

      function renderSessionRow(row) {
        var meta = [];
        var when = relativeTime(row.updatedAt, now);
        if (when !== "") meta.push(when);
        if (row.cwd !== "") meta.push(baseName(row.cwd));
        if (row.subagent && row.parentId !== "") meta.push("父 " + shortId(row.parentId));
        meta.push(shortId(row.id));

        var badges = [];
        if (row.current) badges.push(h("span", { key: "current", className: "svp-badge", "data-tone": "accent" }, "当前"));
        if (row.running) badges.push(h("span", { key: "running", className: "svp-badge", "data-tone": "ok" }, "运行中"));
        if (row.pinned) badges.push(h("span", { key: "pinned", className: "svp-badge" }, "置顶"));
        if (row.subagent) badges.push(h("span", { key: "subagent", className: "svp-badge" }, "子会话"));
        if (row.blank) badges.push(h("span", { key: "blank", className: "svp-badge" }, "空白"));
        if (row.archived) badges.push(h("span", { key: "archived", className: "svp-badge", "data-tone": "warn" }, "已归档"));

        var hover = row.archived ? "已归档会话不能从面板打开" : "打开会话";
        var tip = hover + (row.cwd === "" ? "" : "\n" + row.cwd) + "\n" + row.id;

        return h(
          "div",
          {
            key: row.id,
            className: "svp-row",
            role: "button",
            tabIndex: row.archived ? -1 : 0,
            "data-current": row.current ? "true" : "false",
            "data-openable": row.archived ? "false" : "true",
            "aria-current": row.current ? "true" : undefined,
            title: tip,
            onClick: function () {
              if (!row.archived) openSession(row.id);
            },
            onKeyDown: function (event) {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              if (!row.archived) openSession(row.id);
            },
          },
          h("span", { className: "svp-dot", "data-running": row.running ? "true" : "false" }),
          h(
            "span",
            { className: "svp-main" },
            h(
              "span",
              { className: "svp-title" },
              h("span", { className: "svp-title-text" }, row.title),
              badges.length === 0 ? null : h("span", { className: "svp-badges" }, badges)
            ),
            h("span", { className: "svp-meta" }, meta.join(" · "))
          ),
          row.memCount === 0
            ? null
            : h(
              "button",
              {
                type: "button",
                className: "svp-mem-pill",
                title: "在图谱里看这个会话的记忆（" + row.memCount + " 条）",
                onClick: function (event) {
                  event.stopPropagation();
                  // 找到这个会话落在哪条细线下（细类 → 宽类 → 星图）
                  var found = false;
                  var fineId = "";
                  var groupId = "";
                  if (index !== null) {
                    for (var key in index.fineNodes) {
                      if (!Object.prototype.hasOwnProperty.call(index.fineNodes, key)) continue;
                      var node = index.fineNodes[key];
                      for (var s = 0; s < node.sessions.length; s += 1) {
                        if (node.sessions[s].id === row.id) {
                          fineId = key;
                          groupId = node.group;
                          found = true;
                          break;
                        }
                      }
                      if (found) break;
                    }
                  }
                  setView("graph");
                  setGraphGroup(found ? groupId : "");
                  setGraphTopic(found ? fineId : "");
                  setGraphSession(row.id);
                  setOpenHook("");
                },
              },
              "记忆 " + row.memCount
            ),
          h("span", { className: "svp-go" }, "打开 →")
        );
      }

      function renderGroup(group) {
        var isCollapsed = collapsed[group.key] === true;
        var canAdd = group.workspaceId !== undefined && group.workspaceId !== null;
        return h(
          "section",
          { key: group.key },
          h(
            "div",
            { className: "svp-group-head" },
            h(
              "button",
              {
                type: "button",
                className: "svp-collapse",
                title: isCollapsed ? "展开" : "折叠",
                "aria-expanded": isCollapsed ? "false" : "true",
                onClick: function () { toggleGroup(group.key); },
              },
              isCollapsed ? "▶" : "▼"
            ),
            h("span", { className: "svp-group-title", title: group.title }, group.title),
            group.path === "" || group.path === group.title
              ? null
              : h("span", { className: "svp-group-path", title: group.path }, group.path),
            h("span", { className: "svp-group-spacer" }),
            h("span", { className: "svp-group-count" }, group.rows.length + " 个"),
            canAdd
              ? h(
                "button",
                {
                  type: "button",
                  className: "svp-group-add",
                  title: "在此工作区新建会话",
                  onClick: function () { startSession(group.workspaceId); },
                },
                "＋ 新会话"
              )
              : null
          ),
          isCollapsed ? null : h("div", { className: "svp-rows" }, group.rows.map(renderSessionRow))
        );
      }

      function renderSessionsView() {
        var body;
        if (model.pending) {
          body = h(
            "div",
            { className: "svp-empty" },
            h("span", { className: "svp-empty-title" }, "正在读取会话 …"),
            h("span", null, "Host 还没回第一份会话列表")
          );
        } else if (model.groups.length === 0) {
          body = h(
            "div",
            { className: "svp-empty" },
            h("span", { className: "svp-empty-title" }, "没有匹配的会话"),
            h("span", null, query.trim() === "" ? "换个筛选条件试试" : "换个关键词，或把筛选切回「全部」")
          );
        } else {
          body = h("div", { className: "svp-column" }, model.groups.map(renderGroup));
        }

        return h(
          "div",
          { className: "svp-view" },
          h(
            "div",
            { className: "svp-toolbar" },
            SCOPES.map(function (entry) {
              return h(
                "button",
                {
                  key: entry.id,
                  type: "button",
                  className: "svp-chip",
                  "data-active": scope === entry.id ? "true" : "false",
                  onClick: function () { setScope(entry.id); },
                },
                entry.label
              );
            }),
            h("span", { className: "svp-toolbar-spacer" }),
            h(
              "label",
              { className: "svp-check", title: "子会话默认不列出" },
              h("input", {
                type: "checkbox",
                checked: showSubagents,
                onChange: function (event) { setShowSubagents(event.target.checked); },
              }),
              "含子会话"
            ),
            h(
              "label",
              { className: "svp-check", title: "只留工作记忆里出现过的会话" },
              h("input", {
                type: "checkbox",
                checked: onlyWithMemory,
                onChange: function (event) { setOnlyWithMemory(event.target.checked); },
              }),
              "只看有记忆"
            ),
            h(
              "select",
              {
                className: "svp-select",
                value: sort,
                title: "排序方式",
                onChange: function (event) { setSort(event.target.value); },
              },
              h("option", { value: "recent" }, "最近活动"),
              h("option", { value: "title" }, "标题")
            )
          ),
          h("div", { className: "svp-body" }, body)
        );
      }

      // ── 图谱视图 ────────────────────────────────────────────────────────────

      function topicTile(topic, node, isUntagged) {
        var agentOrder = ["dsh", "hermes", "zcode", "workbuddy"];
        var total = topic.total;
        return h(
          "button",
          {
            key: isUntagged ? "untagged" : topic.id,
            type: "button",
            className: "svp-tile",
            title: isUntagged ? "没打上主题的钩子：先看散点，补标之后会散进各个主题" : topic.desc,
            onClick: function () { if (isUntagged) openPile(); else openGroup(topic.id); },
            style: isUntagged ? { borderStyle: "dashed" } : undefined,
          },
          h(
            "span",
            { className: "svp-tile-name" },
            topic.name,
            isUntagged ? h("span", { className: "svp-badge", "data-tone": "warn" }, "待整理") : null
          ),
          h("span", { className: "svp-tile-nums" }, node === undefined ? "0 条" : node.hooksTotal + " 条钩子 · " + node.sessionCount + " 个会话"),
          h(
            "span",
            { className: "svp-tile-bar" },
            agentOrder.map(function (agentId) {
              var count = (topic.byAgent && topic.byAgent[agentId]) || 0;
              if (count === 0) return null;
              return h("span", {
                key: agentId,
                className: "svp-tile-seg",
                "data-agent": agentId,
                style: { width: Math.max(2, Math.round((count / Math.max(1, total)) * 100)) + "%" },
                title: agentLabel(agentId) + " " + count + " 条",
              });
            })
          )
        );
      }

      /**
       * 记忆方向条：挑一个宽类（可再挑细类）作为当前工作方向，召回按它注入；
       * 「新开模块」直接往 topics.json 里加一条细类。
       */
      function renderDirectionBar() {
        var broads = index === null ? [] : index.topicRows;
        var fines = index !== null && pinPick !== "" && index.fineByGroup[pinPick] ? index.fineByGroup[pinPick] : [];
        return h(
          "div",
          { className: "svp-direction" },
          h("span", { className: "svp-direction-title" }, "记忆方向"),
          h(
            "select",
            {
              className: "svp-select",
              value: pinPick,
              "aria-label": "宽类",
              onChange: function (event) { setPinPick(event.target.value); setPinFinePick(""); },
            },
            h("option", { value: "" }, "选宽类 …"),
            broads.map(function (topic) {
              return h("option", { key: topic.id, value: topic.id }, topic.name + "（" + topic.total + "）");
            })
          ),
          h(
            "select",
            {
              className: "svp-select",
              value: pinFinePick,
              "aria-label": "细类",
              disabled: pinPick === "",
              onChange: function (event) { setPinFinePick(event.target.value); },
            },
            h("option", { value: "" }, "整个宽类"),
            fines.map(function (fine) {
              return h("option", { key: fine.id, value: fine.id }, fine.name + "（" + fine.hooks + "）");
            })
          ),
          h(
            "button",
            {
              type: "button",
              className: "svp-btn",
              disabled: pinPick === "",
              title: "把这个方向作为当前工作方向，召回时按它注入记忆",
              onClick: function () { applyDirection(); },
            },
            "设为当前方向"
          ),
          h(
            "button",
            {
              type: "button",
              className: "svp-btn",
              title: "在选中的宽类下新开一个模块（写进 topics.json，之后归类/召回都能用）",
              disabled: pinPick === "",
              onClick: function () { setNewModuleOpen(!newModuleOpen); },
            },
            "新开模块"
          ),
          pin === null
            ? null
            : h(
              "span",
              { className: "svp-direction-active" },
              "当前：" + (pin.label || pin.fine || pin.topic),
              h("button", { type: "button", className: "svp-btn svp-btn-quiet", onClick: function () { clearDirection(); } }, "清除")
            )
        );
      }

      function renderNewModuleForm() {
        if (!newModuleOpen) return null;
        return h(
          "div",
          { className: "svp-newmodule" },
          h("input", {
            className: "svp-search",
            type: "text",
            placeholder: "模块名（例如：星图交互改版）",
            value: newName,
            spellCheck: false,
            onChange: function (event) { setNewName(event.target.value); },
          }),
          h("input", {
            className: "svp-search",
            type: "text",
            placeholder: "一句评述：这个模块收什么事、边界在哪",
            value: newAnn,
            spellCheck: false,
            onChange: function (event) { setNewAnn(event.target.value); },
          }),
          h("button", { type: "button", className: "svp-btn", disabled: newName.trim() === "", onClick: function () { createModule(); } }, "保存"),
          h("button", { type: "button", className: "svp-btn svp-btn-quiet", onClick: function () { setNewModuleOpen(false); } }, "取消")
        );
      }

      function renderTopicOverview() {
        var tiles = [];
        for (var i = 0; i < index.topicRows.length; i += 1) {
          var topic = index.topicRows[i];
          if (query.trim() !== "" && topic.name.toLowerCase().indexOf(query.trim().toLowerCase()) === -1) continue;
          tiles.push(topicTile(topic, index.topicNodes[topic.id], false));
        }
        if (query.trim() === "" || "未打标".indexOf(query.trim()) !== -1) {
          if (index.untagged.total > 0) tiles.push(topicTile(index.untagged, index.topicNodes[""], true));
        }
        if (tiles.length === 0) {
          tiles.push(h("div", { key: "none", className: "svp-empty" }, h("span", { className: "svp-empty-title" }, "没有匹配的主题")));
        }
        return h(
          "div",
          { className: "svp-view" },
          h(
            "div",
            { className: "svp-body" },
            h(
              "div",
              { className: "svp-column" },
              h(
                "div",
                { className: "svp-note" },
                "点主题方块看它下面的会话。色条是来源占比（同一主题下各 agent 混在一起，不分开）。"
              ),
              renderDirectionBar(),
              renderNewModuleForm(),
              h("div", { className: "svp-tiles" }, tiles),
              h(
                "div",
                { className: "svp-legend" },
                AGENTS.map(function (agent) {
                  var count = index.agents[agent.id] || 0;
                  if (count === 0) return null;
                  return h(
                    "span",
                    { key: agent.id, className: "svp-legend-item" },
                    h("span", { className: "svp-swatch", "data-agent": agent.id }),
                    agent.label + " " + count
                  );
                }),
                h("span", null, "账本 " + index.stats.total + " 条 · " + index.stats.sessions + " 个会话")
              )
            )
          )
        );
      }

      function svgText(x, y, content, className, anchor) {
        return h("text", {
          x: x,
          y: y,
          className: className,
          textAnchor: anchor || "middle",
          dominantBaseline: "middle",
        }, content);
      }

      function renderTopicGraph(node) {
        var sessions = node.sessions;
        var queryLower = query.trim().toLowerCase();
        var visibleSessions = sessions;
        if (queryLower !== "") {
          visibleSessions = sessions.filter(function (session) {
            if (labelOfSession(session.id, session.hooks).toLowerCase().indexOf(queryLower) !== -1) return true;
            for (var i = 0; i < session.hooks.length; i += 1) {
              var hook = session.hooks[i];
              if ((hook.title + hook.ask).toLowerCase().indexOf(queryLower) !== -1) return true;
            }
            return false;
          });
        }

        // 会话数远多于画布能放的时候：多钩子的会话单独成节点，单钩子的会话聚成一个「单次会话」节点。
        // 补标之后 hermes/zcode 的大量导入是一会话一条钩子，229 个会话全画上去只会糊成一圈。
        var allSessions = visibleSessions;
        var primary = [];
        var tail = [];
        for (var pi = 0; pi < allSessions.length; pi += 1) {
          if (allSessions[pi].count >= 2 && primary.length < PRIMARY_NODE_CAP) primary.push(allSessions[pi]);
          else tail.push(allSessions[pi]);
        }
        var ringItems = primary.map(function (session) { return { kind: "session", session: session }; });
        if (tail.length > 0) ringItems.push({ kind: "tail", size: tail.length });

        // 没有任何多钩子会话：星图只会是一个孤零零的点，改成列表
        if (primary.length === 0) return renderFlatTopic(node);

        var count = ringItems.length;
        var ring = count <= 6 ? 170 : count <= 10 ? 205 : count <= 16 ? 235 : 275;
        var maxHooks = 1;
        for (var mi = 0; mi < primary.length; mi += 1) {
          if (primary[mi].count > maxHooks) maxHooks = primary[mi].count;
        }
        var labelChars = count > 20 ? 8 : count > 12 ? 12 : 16;

        var edges = [];
        var nodes = [];
        var labels = [];
        var fanEdges = [];
        var fanDots = [];

        for (var index2 = 0; index2 < ringItems.length; index2 += 1) {
          var item = ringItems[index2];
          var angle = -Math.PI / 2 + (index2 * 2 * Math.PI) / Math.max(1, ringItems.length);
          var x = GRAPH_CX + Math.cos(angle) * ring;
          var y = GRAPH_CY + Math.sin(angle) * ring;

          if (item.kind === "tail") {
            var tailRadius = 15 + 13 * Math.sqrt(item.size / Math.max(1, allSessions.length));
            var tailSelected = graphSession === TAIL_ID;
            var tailAnchor = Math.cos(angle) > 0.25 ? "start" : Math.cos(angle) < -0.25 ? "end" : "middle";
            edges.push(h("line", {
              key: "edge-tail",
              className: "svp-graph-edge",
              "data-selected": tailSelected ? "true" : "false",
              x1: GRAPH_CX,
              y1: GRAPH_CY,
              x2: x,
              y2: y,
            }));
            nodes.push(
              h(
                "g",
                {
                  key: "node-tail",
                  className: "svp-graph-node svp-tail-node",
                  "data-selected": tailSelected ? "true" : "false",
                  transform: "translate(" + x + "," + y + ")",
                  onClick: function () { setGraphSession(TAIL_ID); setOpenHook(""); },
                },
                h("title", null, item.size + " 个单次会话（每个只有 1 条钩子）"),
                h("circle", { r: tailRadius }),
                svgText(0, 0, String(item.size), "svp-tail-count")
              )
            );
            labels.push(
              h(
                "g",
                { key: "label-tail" },
                svgText(GRAPH_CX + Math.cos(angle) * (ring + tailRadius + 12), GRAPH_CY + Math.sin(angle) * (ring + tailRadius + 12), "单次会话 " + item.size + " 个", "svp-graph-label", tailAnchor),
                svgText(GRAPH_CX + Math.cos(angle) * (ring + tailRadius + 12), GRAPH_CY + Math.sin(angle) * (ring + tailRadius + 12) + 13, "点开看列表", "svp-graph-sublabel", tailAnchor)
              )
            );
            continue;
          }

          var session = item.session;
          var radius = 9 + 15 * Math.sqrt(session.count / maxHooks);
          var selected = graphSession === session.id;

          edges.push(
            h("line", {
              key: "edge-" + session.id,
              className: "svp-graph-edge",
              "data-selected": selected ? "true" : "false",
              x1: GRAPH_CX,
              y1: GRAPH_CY,
              x2: x,
              y2: y,
              strokeWidth: 1 + Math.min(3, session.count / 6),
            })
          );

          nodes.push(
            h(
              "g",
              {
                key: "node-" + session.id,
                className: "svp-graph-node",
                "data-agent": session.agent,
                "data-selected": selected ? "true" : "false",
                transform: "translate(" + x + "," + y + ")",
                onClick: function (record) {
                  return function () { selectSession(record.id); };
                }(session),
              },
              h("title", null, labelOfSession(session.id, session.hooks) + " · " + agentLabel(session.agent) + " · " + session.count + " 条钩子"),
              h("circle", { r: radius })
            )
          );

          // 标签只在稀疏时全给；密集时只给钩子最多的前几个 + 选中的那个，避免绕圈糊成一片
          var showLabel = count <= 14 || index2 < LABEL_LIMIT || selected;
          if (showLabel) {
            var labelText = truncate(labelOfSession(session.id, session.hooks), labelChars);
            var labelRadius = radius + 12;
            var labelX = GRAPH_CX + Math.cos(angle) * (ring + labelRadius);
            var labelY = GRAPH_CY + Math.sin(angle) * (ring + labelRadius);
            var anchor = Math.cos(angle) > 0.25 ? "start" : Math.cos(angle) < -0.25 ? "end" : "middle";
            labels.push(
              h(
                "g",
                { key: "label-" + session.id },
                svgText(labelX, labelY, labelText, "svp-graph-label", anchor),
                svgText(labelX, labelY + 13, agentLabel(session.agent) + " · " + session.count, "svp-graph-sublabel", anchor)
              )
            );
          }

          if (selected && session.hooks.length > 0) {
            var baseAngle = Math.atan2(y - GRAPH_CY, x - GRAPH_CX);
            var shown = session.hooks.slice(0, HOOK_FAN_MAX);
            var spread = Math.PI * 0.62;
            for (var k = 0; k < shown.length; k += 1) {
              var hookAngle = shown.length === 1
                ? baseAngle
                : baseAngle - spread / 2 + (spread * k) / (shown.length - 1);
              var hx = x + Math.cos(hookAngle) * (radius + HOOK_FAN_RADIUS);
              var hy = y + Math.sin(hookAngle) * (radius + HOOK_FAN_RADIUS);
              var hook = shown[k];
              var hookOpen = openHook === hook.id;
              fanEdges.push(
                h("line", {
                  key: "fan-" + hook.id,
                  className: "svp-fan-edge",
                  x1: x,
                  y1: y,
                  x2: hx,
                  y2: hy,
                })
              );
              fanDots.push(
                h(
                  "g",
                  {
                    key: "dot-" + hook.id,
                    className: "svp-hook-dot",
                    "data-agent": hook.agent,
                    "data-open": hookOpen ? "true" : "false",
                    transform: "translate(" + hx + "," + hy + ")",
                    onClick: function (hookRecord) {
                      return function () { toggleHook(hookRecord); };
                    }(hook),
                  },
                  h("title", null, shortDate(hook.ts) + " · " + hook.title),
                  h("circle", { r: 5 })
                )
              );
            }
            if (session.hooks.length > HOOK_FAN_MAX) {
              fanDots.push(
                h(
                  "g",
                  { key: "dot-more", className: "svp-hook-dot", transform: "translate(" + (x + Math.cos(baseAngle) * (radius + HOOK_FAN_RADIUS + 18)) + "," + (y + Math.sin(baseAngle) * (radius + HOOK_FAN_RADIUS + 18)) + ")" },
                  h("title", null, "还有 " + (session.hooks.length - HOOK_FAN_MAX) + " 条，看下方列表"),
                  h("circle", { r: 4, fillOpacity: 0.25 })
                )
              );
            }
          }
        }

        var nodeDef = index.fineById[node.id];
        var nodeName = nodeDef !== undefined ? nodeDef.name : (index.topicById[node.id] ? index.topicById[node.id].name : node.id);
        var groupDef = nodeDef === undefined ? undefined : index.topicById[nodeDef.group];
        var hubName = nodeName;
        // 主题名最多折成两行放进半径 52 的圆里
        var hubLines = hubName.length <= 5
          ? [hubName]
          : [hubName.slice(0, Math.ceil(hubName.length / 2)), hubName.slice(Math.ceil(hubName.length / 2))];
        var hubTexts = hubLines.length === 1
          ? [svgText(GRAPH_CX, GRAPH_CY - 6, hubLines[0], "svp-hub-label")]
          : [
            svgText(GRAPH_CX, GRAPH_CY - 15, hubLines[0], "svp-hub-label"),
            svgText(GRAPH_CX, GRAPH_CY + 1, hubLines[1], "svp-hub-label"),
          ];

        return h(
          "div",
          { className: "svp-view" },
          h(
            "div",
            { className: "svp-body" },
            h(
              "div",
              { className: "svp-column" },
              h(
                "div",
                { className: "svp-crumb" },
                h("button", { type: "button", onClick: function () { openOverview(); } }, "← 全部主题"),
                h("span", null, "/"),
                groupDef === undefined
                  ? null
                  : h("button", { type: "button", onClick: function () { openGroup(groupDef.id); } }, groupDef.name),
                groupDef === undefined ? null : h("span", null, "/"),
                h("span", null, nodeName)
              ),
              h(
                "div",
                { className: "svp-note" },
                node.hooksTotal + " 条钩子 · " + node.sessionCount + " 个会话"
                  + (tail.length > 0 ? "（" + primary.length + " 个多钩子会话画成节点，" + tail.length + " 个单次会话聚合）" : "")
                  + " · 点节点看它的钩子"
              ),
              h(
                "svg",
                { className: "svp-graph", viewBox: "0 0 " + GRAPH_W + " " + GRAPH_H, role: "img" },
                h("g", null, edges),
                fanEdges.length > 0 ? h("g", null, fanEdges) : null,
                h(
                  "g",
                  { className: "svp-hub" },
                  h("circle", { cx: GRAPH_CX, cy: GRAPH_CY, r: 52 }),
                  h("g", null, hubTexts),
                  svgText(GRAPH_CX, GRAPH_CY + (hubLines.length === 1 ? 12 : 19), node.hooksTotal + " 钩 / " + node.sessionCount + " 会话", "svp-graph-sublabel")
                ),
                h("g", null, nodes),
                h("g", null, labels),
                h("g", null, fanDots)
              ),
              h(
                "div",
                { className: "svp-legend" },
                AGENTS.map(function (agent) {
                  var sessionsOfAgent = 0;
                  for (var s = 0; s < sessions.length; s += 1) {
                    if (sessions[s].agent === agent.id) sessionsOfAgent += 1;
                  }
                  if (sessionsOfAgent === 0) return null;
                  return h(
                    "span",
                    { key: agent.id, className: "svp-legend-item" },
                    h("span", { className: "svp-swatch", "data-agent": agent.id }),
                    agent.label + " " + sessionsOfAgent + " 个会话"
                  );
                }),
                h("span", null, "节点大小 = 钩子数")
              ),
              (function () {
                if (graphSession === TAIL_ID) return renderTailList(tail);
                if (graphSession === "") return null;
                var record = null;
                for (var si = 0; si < sessions.length; si += 1) {
                  if (sessions[si].id === graphSession) {
                    record = sessions[si];
                    break;
                  }
                }
                return record === null ? null : renderSessionDetail(record, node);
              })()
            )
          )
        );
      }

      function renderHookRow(hook) {
        var expanded = openHook === hook.id;
        var detailReady = detail.id === hook.id && detail.status === "ready" && detail.hook !== null;
        var body = null;
        if (expanded) {
          var detailBlock;
          if (detail.id === hook.id && detail.status === "loading") detailBlock = h("div", { className: "svp-note" }, "读取钩子 …");
          else if (detail.id === hook.id && detail.status === "error") detailBlock = h("div", { className: "svp-warn" }, detail.error || "读取失败");
          else detailBlock = h("div", { className: "svp-hook-ask" }, detailReady ? detail.hook.ask : hook.ask);

          var transcriptBlock = null;
          if (transcript.id === hook.id && transcript.status === "loading") transcriptBlock = h("div", { className: "svp-note" }, "读取原文 …");
          else if (transcript.id === hook.id && transcript.status === "error") transcriptBlock = h("div", { className: "svp-warn" }, transcript.error || "原文读取失败");
          else if (transcript.id === hook.id && transcript.status === "ready") transcriptBlock = h("pre", { className: "svp-pre" }, transcript.text === "" ? "(空)" : transcript.text);

          var exists = sessionExists(hook.session) !== undefined;
          body = h(
            "div",
            { className: "svp-hookbody" },
            detailBlock,
            hook.artifacts.length > 0
              ? h(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: "2px" } },
                hook.artifacts.map(function (pathText) {
                  return h("div", { key: pathText, className: "svp-artifact-path", title: pathText }, pathText);
                })
              )
              : null,
            h(
              "div",
              { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
              h(
                "button",
                { type: "button", className: "svp-btn", onClick: function () { loadTranscript(hook); } },
                transcript.id === hook.id && transcript.status === "ready" ? "收起原文" : "展开原文"
              ),
              hook.agent === "dsh" && exists
                ? h("button", { type: "button", className: "svp-btn", onClick: function () { openSession(hook.session); } }, "打开会话")
                : null,
              !exists && hook.agent !== "dsh" ? h("span", { className: "svp-note" }, "跨来源会话，无法在 DSH 打开") : null
            ),
            transcriptBlock
          );
        }

        return h(
          "div",
          { key: hook.id },
          h(
            "div",
            {
              className: "svp-hookrow",
              role: "button",
              tabIndex: 0,
              "data-open": expanded ? "true" : "false",
              onClick: function () { toggleHook(hook); },
              onKeyDown: function (event) {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                toggleHook(hook);
              },
            },
            h("span", { className: "svp-hookrow-seq" }, "seq " + hook.startSeq + "–" + hook.endSeq),
            h("span", { className: "svp-hookrow-title", title: hook.title }, hook.title === "" ? "(无标题)" : hook.title),
            h("span", { className: "svp-hookrow-date" }, shortDate(hook.ts))
          ),
          body
        );
      }

      function renderSessionList(heading, metaText, sessions) {
        var shown = sessions.slice(0, tailLimit);
        return h(
          "div",
          { className: "svp-detail" },
          h(
            "div",
            { className: "svp-detail-head" },
            h("span", { className: "svp-detail-title" }, heading),
            h("span", { className: "svp-detail-meta" }, metaText),
            h("span", { className: "svp-detail-spacer" }),
            graphSession === "" ? null : h("button", { type: "button", className: "svp-btn", onClick: function () { setGraphSession(""); setOpenHook(""); } }, "收起")
          ),
          h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: "2px" } },
            shown.map(function (session) {
              return h(
                "button",
                {
                  key: session.id,
                  type: "button",
                  className: "svp-file",
                  title: session.id,
                  onClick: function () { setGraphSession(session.id); setOpenHook(""); },
                },
                h("span", { className: "svp-swatch", "data-agent": session.agent }),
                h("span", { className: "svp-file-name" }, labelOfSession(session.id, session.hooks)),
                h("span", { className: "svp-file-count" }, agentLabel(session.agent) + " · " + session.count + " 条 · " + shortDate(session.latest))
              );
            })
          ),
          sessions.length > shown.length
            ? h(
              "button",
              { type: "button", className: "svp-btn", style: { alignSelf: "center" }, onClick: function () { setTailLimit(tailLimit + 60); } },
              "显示更多（还有 " + (sessions.length - shown.length) + " 个）"
            )
            : null
        );
      }

      function renderTailList(tailSessions) {
        return renderSessionList("单次会话 " + tailSessions.length + " 个", "每个会话只有 1 条钩子", tailSessions);
      }

      /**
       * 主题下没有多钩子会话时（hermes/zcode 导入的常见形状），星图退化成一个点，
       * 不如直接把会话列表摊开。
       * @param {object} node 该主题的节点。
       * @returns {object} 列表视图。
       */
      function renderFlatTopic(node) {
        var queryLower = query.trim().toLowerCase();
        var sessions = node.sessions;
        if (queryLower !== "") {
          sessions = sessions.filter(function (session) {
            if (labelOfSession(session.id, session.hooks).toLowerCase().indexOf(queryLower) !== -1) return true;
            for (var i = 0; i < session.hooks.length; i += 1) {
              var hook = session.hooks[i];
              if ((hook.title + hook.ask).toLowerCase().indexOf(queryLower) !== -1) return true;
            }
            return false;
          });
        }
        var record = null;
        if (graphSession !== "" && graphSession !== TAIL_ID) {
          for (var si = 0; si < sessions.length; si += 1) {
            if (sessions[si].id === graphSession) {
              record = sessions[si];
              break;
            }
          }
        }
        var body;
        if (record !== null) body = renderSessionDetail(record, node);
        else if (sessions.length === 0) {
          body = h("div", { className: "svp-empty" }, h("span", { className: "svp-empty-title" }, "没有匹配的会话"));
        } else {
          body = renderSessionList("这个主题下的会话", "共 " + sessions.length + " 个，点一个看它的钩子", sessions);
        }
        return h(
          "div",
          { className: "svp-view" },
          h(
            "div",
            { className: "svp-body" },
            h(
              "div",
              { className: "svp-column" },
              h(
                "div",
                { className: "svp-crumb" },
                h("button", { type: "button", onClick: function () { openOverview(); } }, "← 全部主题"),
                h("span", null, "/"),
                h("span", null, node.id === "" ? "未打标" : (index.topicById[node.id] ? index.topicById[node.id].name : node.id))
              ),
              h(
                "div",
                { className: "svp-note" },
                node.hooksTotal + " 条钩子 · " + node.sessionCount + " 个会话，都是单次会话（一个会话一条钩子），画星图没有意义，直接列出来。"
              ),
              body
            )
          )
        );
      }

      function renderSessionDetail(sessionRecord, node) {
        var known = sessionExists(sessionRecord.id);
        var title = labelOfSession(sessionRecord.id, sessionRecord.hooks);
        var openable = sessionRecord.agent === "dsh" && known !== undefined;
        return h(
          "div",
          { className: "svp-detail" },
          h(
            "div",
            { className: "svp-detail-head" },
            h("span", { className: "svp-detail-title", title: title }, title),
            h(
              "span",
              { className: "svp-detail-meta" },
              agentLabel(sessionRecord.agent) + " · " + sessionRecord.count + " 条钩子" + (sessionRecord.latest === "" ? "" : " · 最近 " + shortDate(sessionRecord.latest))
            ),
            h("span", { className: "svp-detail-spacer" }),
            openable
              ? h("button", { type: "button", className: "svp-btn", onClick: function () { openSession(sessionRecord.id); } }, "打开会话")
              : null,
            h("button", { type: "button", className: "svp-btn", onClick: function () { setGraphSession(""); setOpenHook(""); } }, "收起")
          ),
          h(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: "2px" } },
            (function () {
              // 按「段」分组：同一段内的钩子是一个连续的工作单元，先给出段标签再列钩子
              var groups = [];
              var index = {};
              for (var i = 0; i < sessionRecord.hooks.length; i += 1) {
                var hook = sessionRecord.hooks[i];
                var key = typeof hook.segment === "string" && hook.segment !== "" ? hook.segment : "h:" + hook.id;
                if (index[key] === undefined) {
                  index[key] = groups.length;
                  groups.push({ key: key, label: hook.segLabel || "", hooks: [] });
                }
                groups[index[key]].hooks.push(hook);
              }
              var out = [];
              for (var g = 0; g < groups.length; g += 1) {
                var group = groups[g];
                if (group.label !== "") {
                  out.push(
                    h(
                      "div",
                      { key: "seg-" + group.key, className: "svp-seg-label" },
                      "▍" + group.label + (group.hooks.length > 1 ? "（" + group.hooks.length + " 条）" : "")
                    )
                  );
                }
                for (var k = 0; k < group.hooks.length; k += 1) out.push(renderHookRow(group.hooks[k]));
              }
              return out;
            })()
          )
        );
      }

      function renderPile(node) {
        var queryLower = query.trim().toLowerCase();
        var sessions = node.sessions;
        if (queryLower !== "") {
          sessions = sessions.filter(function (session) {
            if (labelOfSession(session.id, session.hooks).toLowerCase().indexOf(queryLower) !== -1) return true;
            for (var i = 0; i < session.hooks.length; i += 1) {
              if ((session.hooks[i].title + session.hooks[i].ask).toLowerCase().indexOf(queryLower) !== -1) return true;
            }
            return false;
          });
        }
        var selected = null;
        for (var i2 = 0; i2 < sessions.length; i2 += 1) {
          if (sessions[i2].id === graphSession) selected = sessions[i2];
        }
        return h(
          "div",
          { className: "svp-view" },
          h(
            "div",
            { className: "svp-body" },
            h(
              "div",
              { className: "svp-column" },
              h(
                "div",
                { className: "svp-crumb" },
                h("button", { type: "button", onClick: function () { openOverview(); } }, "← 全部主题"),
                h("span", null, "/"),
                h("span", null, "未打标")
              ),
              h(
                "div",
                { className: "svp-note" },
                node.hooksTotal + " 条钩子散落在 " + node.sessionCount + " 个会话里（多数会话只有一条，画不成网络）。点圆点看那个会话的钩子；跑一遍 cli/tag-topics.js 之后这些会散进各主题。"
              ),
              h(
                "div",
                { className: "svp-pile" },
                sessions.map(function (session) {
                  var size = 8 + Math.min(14, Math.sqrt(session.count) * 5);
                  return h("button", {
                    key: session.id,
                    type: "button",
                    className: "svp-pile-dot",
                    "data-agent": session.agent,
                    "data-selected": graphSession === session.id ? "true" : "false",
                    style: { width: Math.round(size) + "px", height: Math.round(size) + "px" },
                    title: labelOfSession(session.id, session.hooks) + " · " + agentLabel(session.agent) + " · " + session.count + " 条",
                    onClick: function (record) {
                      return function () { selectSession(record.id); };
                    }(session),
                  });
                })
              ),
              h(
                "div",
                { className: "svp-legend" },
                AGENTS.map(function (agent) {
                  var n = 0;
                  for (var s = 0; s < sessions.length; s += 1) if (sessions[s].agent === agent.id) n += 1;
                  if (n === 0) return null;
                  return h("span", { key: agent.id, className: "svp-legend-item" }, h("span", { className: "svp-swatch", "data-agent": agent.id }), agent.label + " " + n + " 个会话");
                })
              ),
              selected === null ? null : renderSessionDetail(selected, node)
            )
          )
        );
      }

      function renderGraphView() {
        if (memory.status === "error") {
          return h(
            "div",
            { className: "svp-body" },
            h(
              "div",
              { className: "svp-empty" },
              h("span", { className: "svp-empty-title" }, "账本读不到"),
              h("span", null, memory.error || ""),
              h("button", { type: "button", className: "svp-btn", onClick: loadMemory }, "重试")
            )
          );
        }
        if (index === null) {
          return h("div", { className: "svp-body" }, h("div", { className: "svp-empty" }, h("span", { className: "svp-empty-title" }, "正在读取账本 …")));
        }
        if (graphGroup === "" && graphTopic === "") return renderTopicOverview();
        if (graphTopic === "") return renderGroupPage(graphGroup);
        if (graphTopic === "none") {
          var untaggedNode = index.topicNodes[""];
          if (untaggedNode === undefined) return renderTopicOverview();
          return renderPile(untaggedNode);
        }
        var node = index.fineNodes[graphTopic] || index.topicNodes[graphTopic];
        if (node === undefined) return renderGroupPage(graphGroup);
        return renderTopicGraph(node);
      }

      /** 中间层：一个宽类下面的细线清单。 */
      function renderGroupPage(groupId) {
        var groupDef = index.topicById[groupId];
        if (groupDef === undefined) return renderTopicOverview();
        var fineRows = index.fineByGroup[groupId] || [];
        var totalHooks = 0;
        var totalSessions = 0;
        for (var i = 0; i < fineRows.length; i += 1) {
          totalHooks += fineRows[i].hooks;
          totalSessions += fineRows[i].sessions;
        }
        var list = fineRows.map(function (row) {
          return h(
            "button",
            {
              key: row.id,
              type: "button",
              className: "svp-line",
              title: row.desc === "" ? row.name : row.desc,
              onClick: function () { openFine(row.id); },
            },
            h("span", { className: "svp-line-name" }, row.name),
            h("span", { className: "svp-line-meta" }, row.hooks + " 条 · " + row.sessions + " 个会话 · " + String(row.lastTs).slice(0, 10))
          );
        });
        return h(
          "div",
          { className: "svp-view" },
          h(
            "div",
            { className: "svp-body" },
            h(
              "div",
              { className: "svp-column" },
              h(
                "div",
                { className: "svp-crumb" },
                h("button", { type: "button", onClick: function () { openOverview(); } }, "← 全部主题"),
                h("span", null, "/"),
                h("span", null, groupDef.name)
              ),
              h("div", { className: "svp-note" }, totalHooks + " 条钩子 · " + totalSessions + " 个会话 · " + fineRows.length + " 条细线（点一条看它的会话）"),
              fineRows.length === 0
                ? h("div", { className: "svp-empty" }, h("span", { className: "svp-empty-title" }, "这个宽类下还没有细线"))
                : h("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } }, list)
            )
          )
        );
      }

      // ── 产物视图 ────────────────────────────────────────────────────────────

      function renderArtifactsView() {
        if (index === null) {
          return h(
            "div",
            { className: "svp-body" },
            h("div", { className: "svp-empty" }, h("span", { className: "svp-empty-title" }, memory.status === "error" ? "账本读不到" : "正在读取账本 …"))
          );
        }
        var queryLower = query.trim().toLowerCase();
        var dirs = index.dirs;
        var shown = [];
        for (var i = 0; i < dirs.length && shown.length < 40; i += 1) {
          var dir = dirs[i];
          var files = dir.files;
          if (queryLower !== "") {
            files = files.filter(function (file) { return file.path.toLowerCase().indexOf(queryLower) !== -1; });
          }
          if (files.length === 0) continue;
          shown.push({ dir: dir.dir, count: dir.count, files: files.slice(0, 12) });
        }

        function openArtifactFile(pathText) {
          var found = false;
          var targetGroup = "";
          var targetFine = "";
          var targetSession = "";
          if (index !== null) {
            for (var key in index.fineNodes) {
              if (!Object.prototype.hasOwnProperty.call(index.fineNodes, key)) continue;
              var node = index.fineNodes[key];
              for (var s = 0; s < node.sessions.length; s += 1) {
                var session = node.sessions[s];
                for (var k = 0; k < session.hooks.length; k += 1) {
                  if (session.hooks[k].artifacts.indexOf(pathText) !== -1) {
                    targetFine = key;
                    targetGroup = node.group;
                    targetSession = session.id;
                    found = true;
                    break;
                  }
                }
                if (found) break;
              }
              if (found) break;
            }
          }
          setView("graph");
          setGraphGroup(found ? targetGroup : "");
          setGraphTopic(found ? targetFine : "");
          setGraphSession(targetSession);
          setOpenHook("");
        }

        return h(
          "div",
          { className: "svp-view" },
          h(
            "div",
            { className: "svp-body" },
            h(
              "div",
              { className: "svp-column" },
              h(
                "div",
                { className: "svp-note" },
                index.stats.artifactPaths + " 个产物路径，来自 " + index.stats.withArtifacts + " 条钩子；点文件跳到图谱里对应的主题与会话。"
              ),
              shown.length === 0
                ? h("div", { className: "svp-empty" }, h("span", { className: "svp-empty-title" }, "没有匹配的产物"))
                : shown.map(function (entry) {
                  return h(
                    "div",
                    { key: entry.dir, className: "svp-dir" },
                    h(
                      "div",
                      { className: "svp-dir-head" },
                      h("span", { className: "svp-dir-path", title: entry.dir }, entry.dir),
                      h("span", { className: "svp-file-count" }, entry.files.length + " 个文件")
                    ),
                    entry.files.map(function (file) {
                      return h(
                        "button",
                        { key: file.path, type: "button", className: "svp-file", title: file.path, onClick: function () { openArtifactFile(file.path); } },
                        h("span", { className: "svp-file-name" }, baseName(file.path)),
                        h("span", { className: "svp-file-count" }, file.count + " 次")
                      );
                    })
                  );
                })
            )
          )
        );
      }

      // ── 外壳 ────────────────────────────────────────────────────────────────

      var memorySource;
      if (memory.status === "loading") memorySource = "账本读取中 …";
      else if (memory.status === "error") memorySource = "账本读不到";
      else if (index !== null) {
        memorySource = "账本 " + index.stats.total + " 条 · " + index.stats.sessions + " 个会话";
        if (index.stats.agentTotal > 0) {
          memorySource += index.stats.includeAgents
            ? "（含代理自产 " + index.stats.agentTotal + " 条）"
            : "（人类需求；另有 " + index.stats.agentTotal + " 条代理自产）";
        }
        if (index.source !== null && index.source.mtimeMs > 0) memorySource += " · " + relativeTime(index.source.mtimeMs, now) + "更新";
      } else memorySource = "账本未加载";

      var statsBits = ["会话 " + model.total];
      if (model.running > 0) statsBits.push("运行中 " + model.running);
      if (model.withMemory > 0) statsBits.push("有记忆 " + model.withMemory);
      statsBits.push(memorySource);

      var placeholder = view === "artifacts"
        ? "搜产物路径"
        : view === "sessions"
          ? "搜索标题、路径或会话 ID"
          : graphTopic === ""
            ? "搜主题"
            : "搜会话或钩子";

      var tabs = VIEWS.map(function (entry) {
        var count = "";
        if (entry.id === "graph" && index !== null) count = String(index.topicRows.length);
        else if (entry.id === "sessions") count = String(model.visibleCount);
        else if (entry.id === "artifacts" && index !== null) count = String(index.stats.artifactPaths);
        return h(
          "button",
          {
            key: entry.id,
            type: "button",
            className: "svp-tab",
            "data-active": view === entry.id ? "true" : "false",
            onClick: function () { setView(entry.id); },
          },
          entry.label,
          count === "" ? null : h("span", { className: "svp-tab-count" }, count)
        );
      });

      var viewBody;
      if (view === "graph") viewBody = renderGraphView();
      else if (view === "sessions") viewBody = renderSessionsView();
      else viewBody = renderArtifactsView();

      return h(
        "div",
        { className: "svp-page" },
        h(
          "div",
          { className: "svp-head" },
          h(
            "div",
            { className: "svp-head-titles" },
            h("div", { className: "svp-head-title" }, "会话视图"),
            h("div", { className: "svp-head-sub" }, statsBits.join(" · "))
          ),
          h("div", { className: "svp-head-spacer" }),
          view === "graph"
            ? h(
              "label",
              {
                className: "svp-check",
                title: "代理自产 = 子代理任务书 / cron 投递样板 / 工作流子会话。默认只看人提的需求。",
              },
              h("input", {
                type: "checkbox",
                checked: includeAgents,
                onChange: function (event) { setIncludeAgents(event.target.checked); },
              }),
              "含代理自产" + (index === null ? "" : "（" + index.stats.agentTotal + " 条）")
            )
            : null,
          h("input", {
            className: "svp-search",
            type: "search",
            value: query,
            placeholder: placeholder,
            spellCheck: false,
            "aria-label": "搜索",
            onChange: function (event) { setQuery(event.target.value); },
          }),
          h(
            "button",
            { type: "button", className: "svp-btn", title: "重新读取会话列表与账本", disabled: refreshing, onClick: refresh },
            refreshing ? "刷新中 …" : "刷新"
          )
        ),
        h("div", { className: "svp-tabs" }, tabs, h("span", { className: "svp-tabbar-spacer" })),
        viewBody
      );
    }

    // ── 注册 ──────────────────────────────────────────────────────────────────

    var panelServices = { sessions: undefined, workspaces: undefined, uiWorkspace: undefined };

    var inject = ["slots", "sessions", "workspaces", "uiWorkspace"];

    function apply(ctx) {
      var slots = ctx.get("slots");
      if (slots === undefined || slots === null) {
        console.warn("[session-view] slots 服务不可用，面板未注册");
        return;
      }
      panelServices.sessions = ctx.get("sessions");
      panelServices.workspaces = ctx.get("workspaces");
      panelServices.uiWorkspace = ctx.get("uiWorkspace");
      ensureStyle();

      slots.inject("sidebar.panellist", function () {
        return slots.register(
          { name: "sidebar.panellist", id: PANEL_ID, order: 11, label: PANEL_LABEL },
          SessionsIcon
        );
      });
      slots.inject("main", function () {
        return slots.register({ name: "main", key: PANEL_ID }, SessionsPanel);
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    exports.__internals = {
      buildSessionModel: buildSessionModel,
      buildMemoryIndex: buildMemoryIndex,
      relativeTime: relativeTime,
      baseName: baseName,
      dirName: dirName,
      shortId: shortId,
      PANEL_ID: PANEL_ID,
    };
    return module.exports;
  },
});
