/**
 * Codex 插件入口：宿主经 .mcp.json 以 stdio 拉起本文件（esbuild 自包含 bundle 后
 * 部署为 plugins/tasklane/server.mjs，不依赖仓库 node_modules）。
 *
 * 与独立模式的 mcp/src/index.ts 共用 Board Core 与 7 个 board/task tools，
 * 另外注册 MCP Apps widget（open_tasklane + ui:// 资源），供 Codex 应用面板渲染 UI。
 * 侧栏 UI 的读写经宿主桥回到本进程 —— 人与编码 agent 天然共享同一份 board.json。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BoardEngine, GitService, JsonFileBoardStore, defaultStorePath } from "@tasklane/core";
import { createServer } from "../../mcp/dist/src/server.js";
import { REPORT_WIDGET_URI, registerKanbanWidget, reportWidgetData } from "./widget.mjs";

// bundle 部署后：server.mjs 与 assets/、kanban-widget.html 同在插件根目录
const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const widgetPath = path.join(pluginDir, "kanban-widget.html");
const sidebarIcon = path.join(pluginDir, "assets", "sidebar-icon.svg");

// Extensions 协议的 serverInfo.icons：侧栏导航 fallback；缺失时降级为无图标，不阻塞启动
const sidebarIcons = existsSync(sidebarIcon)
  ? [
      {
        src: `data:image/svg+xml;base64,${readFileSync(sidebarIcon).toString("base64")}`,
        mimeType: "image/svg+xml",
        sizes: ["any"],
      },
    ]
  : [];

async function main() {
  const storePath = defaultStorePath();
  const store = new JsonFileBoardStore(storePath);
  const git = new GitService(process.env.TASKLANE_GIT !== "off");
  const engine = new BoardEngine(store, git);

  // apps 选项：task_execution_report 成功结果附加报告卡片字段（会话内出卡并聚焦任务）。
  // serverRef 在 createServer 返回后才有值，闭包经引用读取实际握手客户端；
  // 字段解析失败返回 null，保持纯回执结果，不阻塞执行回报。
  let serverRef = null;
  const server = createServer(engine, {
    serverInfo: { name: "tasklane", version: "0.3.20", icons: sidebarIcons },
    instructions:
      "tasklane MCP server: a task board shared by the user and the agent. " +
      "Use open_tasklane to open (or reuse) the native board MCP App in the Codex content panel. " +
      "In project chats, pass the active workspace as absolute projectDir; use empty arguments only for the global board. " +
      "Do not start a localhost bridge or open a browser URL unless the user explicitly asks for browser mode. " +
      "If open_tasklane fails, report the cause without changing boards or creating Git commits. Manage tasks through " +
      "board_list / task_list / task_get / task_create / task_update / task_move; task_update dispatches by action: " +
      "action=assign is a metadata tool that never creates a chat, starts/stops an agent or creates a worktree, and action=review records review verdicts. " +
      "The UI does not expose manual assignment; new execution requests atomically mark the task as agent without proving running. " +
      "For explicit native execution requests, follow the tasklane native-execution skill: reread task_get and board_list, " +
      "claim the persisted request before native chat creation, record phase=created then phase=bound, " +
      "and report actual execution with task_execution action=report matching threadId, hostId and runId. " +
      "Projectless boards (no repo) start tasks with workspaceMode=projectless: create_thread uses a projectless target with no projectId, the bind omits workspace fields, and such tasks skip the review workflow. " +
      "Non-Git project boards execute in their directory via the project mode; worktree requests are rejected there. " +
      "Message delivery and task_move are not proof of execution. Never use task_update(execution). " +
      "Connected Codex panels submit task requests without a separate verification chat. The receiving Agent confirms its real host/thread when claiming, " +
      "returns the new task chat identifiers immediately, persists created then bound before sending the task body, and reports explicit failures. " +
      "Execution is disabled outside Codex; there is no CLI or background fallback and no reliable Stop interface.",
    apps: {
      resourceUri: REPORT_WIDGET_URI,
      widgetDataFor: (result) =>
        reportWidgetData({
          result,
          boardHome: storePath,
          store,
          clientVersion: () => serverRef?.server?.getClientVersion(),
        }),
    },
  });
  serverRef = server;
  registerKanbanWidget(server, { widgetPath, boardHome: storePath, engine });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `[tasklane] plugin MCP server ready on stdio (store: ${storePath}, git: ${git.enabled ? "on" : "off"})`,
  );
}

main().catch((err) => {
  console.error("[tasklane] plugin fatal:", err);
  process.exit(1);
});
