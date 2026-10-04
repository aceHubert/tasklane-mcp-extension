/**
 * MCP Apps widget 注册（Codex 侧栏嵌入，插件名 TaskLane）。
 *
 * 把构建好的单文件看板 UI 注册为 MCP app resource，并提供
 * `open_tasklane` app tool：宿主据其 `_meta` 在侧边栏放入口，
 * 工具结果触发 widget 渲染。
 * （@modelcontextprotocol/ext-apps/server）。
 *
 * open_tasklane 支持两种打开模式（项目与全局看板入口执行计划）：
 * - `{}`：全局模式，widget 展示仓库选择器与添加入口。
 * - `{ projectDir, baseBranch? }`：项目模式，锁定 projectDir 所属仓库的看板；
 *   未登记时自动注册到共享数据集（幂等，子目录/worktree 归位主仓库），
 *   widget 隐藏切换/添加入口并锁定 lockedBoardId。
 * 模式与锁定 ID 只随本次工具结果返回，服务端不保存全局"当前仓库"；
 * 每个 widget 实例独立保留打开时的上下文。
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";

// 切换应用面板契约时使用新资源标识，避免宿主复用旧的 inline 页面缓存。
export const WIDGET_URI = "ui://widget/tasklane/board-panel-v0314.html";

const OPENAI_UI_META = {
  availableDisplayModes: ["fullscreen"],
  preferredDisplayMode: "fullscreen",
};

const openTasklaneSchema = z.object({
  projectDir: z
    .string()
    .optional()
    .describe(
      "当前聊天工作区的绝对路径（项目模式）。传入后看板锁定该目录所属 Git 仓库，" +
        "未登记时自动注册；省略或空对象打开全局看板。空白字符串会被拒绝，不会降级为全局模式。",
    ),
  baseBranch: z
    .string()
    .optional()
    .describe("项目模式自动注册的基线分支，默认 main；须为已有本地分支或空仓库当前未提交分支。已登记仓库沿用原配置。"),
});

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {{
 *   widgetPath: string,
 *   boardHome: string,
 *   engine: import("@tasklane/core").BoardEngine,
 * }} options
 */
export function registerKanbanWidget(server, { widgetPath, boardHome, engine }) {
  const readWidgetHtml = () => readFileSync(widgetPath, "utf8");

  registerAppResource(
    server,
    "TaskLane Board",
    WIDGET_URI,
    {
      title: "TaskLane Board",
      description:
        "MCP-native task board panel. The user and the agent share board tools and correlated native execution requests, bindings and receipts.",
      _meta: {
        ui: { csp: {} },
        "openai/ui": OPENAI_UI_META,
      },
    },
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: readWidgetHtml(),
          _meta: {
            ui: { csp: {} },
            "openai/ui": OPENAI_UI_META,
          },
        },
      ],
    }),
  );

  /** 组装 widget 打开结果（structuredContent 与 _meta.widgetData 保持一致） */
  // MCP Apps 的 UI 桥名可能通用；实际 MCP 客户端只能由已协商的连接读取，
  // 不能允许调用者通过 open_tasklane 参数伪造，也不作为执行路由已验证的证明。
  const widgetResult = (data, text) => {
    const peer = server.server.getClientVersion();
    const widgetData = { ...data, ...(peer ? { mcpClient: { name: peer.name, version: peer.version } } : {}) };
    return {
      content: [{ type: "text", text }],
      structuredContent: widgetData,
      _meta: {
        "openai/outputTemplate": WIDGET_URI,
        widgetData,
      },
    };
  };

  // 只读取本服务真实握手的客户端；刷新面板也能取得实时身份，不依赖一次性工具结果。
  server.registerTool("tasklane_host_info", {
    title: "TaskLane host info",
    description: "Read the actual MCP initialize client for the current TaskLane connection. This is an identity hint, not proof that a task has executed.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    _meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
  }, async () => {
    const peer = server.server.getClientVersion();
    const data = peer ? { mcpClient: { name: peer.name, version: peer.version } } : {};
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
  });

  /**
   * open_tasklane 失败结果：必须同样携带 structuredContent（widget 标识 + 模式）。
   * widget 端 parseWidgetContext 以它识别结果来源；缺失时错误上下文会被丢弃，
   * widget 静默回退全局看板 —— 恰是服务端明确要避免的行为。
   */
  const widgetError = (text) => ({
    isError: true,
    content: [{ type: "text", text }],
    structuredContent: {
      version: 2,
      widget: "tasklane-board",
      title: "TaskLane",
      rendering: "native-widget",
      mode: "project",
      boardHome,
    },
    _meta: {
      "openai/outputTemplate": WIDGET_URI,
      widgetData: {
        version: 2,
        widget: "tasklane-board",
        title: "TaskLane",
        rendering: "native-widget",
        mode: "project",
        boardHome,
      },
    },
  });

  registerAppTool(
    server,
    "open_tasklane",
    {
      title: "TaskLane",
      description:
        "Open the native TaskLane MCP App in the Codex content panel; no browser URL or localhost bridge is needed. " +
        "Project chats: pass the current workspace as absolute projectDir to lock " +
        "the board to that repo (auto-registered on first open; subdirs/worktrees resolve to the main repo). " +
        "Repositories with no commits can open a board using their current unborn branch as baseBranch; " +
        "Git worktree creation requires an initial commit, which must be made by the user. " +
        "Global sidebar: call without arguments to manage all registered boards. " +
        "Reuse the already-open widget instead of opening another one. If opening fails, report the error; " +
        "do not fall back to a browser or a different board unless the user explicitly requests it. " +
        "A connected Codex panel can submit explicit task requests directly. Verify native tools and workspace " +
        "routes within that task request; create no separate verification chat. Return ready thread/host/workspace " +
        "identifiers immediately, persist created then bound, and only then send the task body. " +
        "The returned mcpClient comes from the actual MCP initialize handshake; it is an identity hint, not execution proof. " +
        "A successful board open or message delivery does not prove execution has started.",
      inputSchema: openTasklaneSchema,
      _meta: {
        ui: {
          resourceUri: WIDGET_URI,
          visibility: ["model", "app"],
        },
        "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] },
        "openai/outputTemplate": WIDGET_URI,
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking": "Opening TaskLane...",
        "openai/toolInvocation/invoked": "TaskLane board ready",
      },
    },
    async (args) => {
      const input = args ?? {};

      // 全局模式：空对象/无 projectDir
      if (input.projectDir === undefined) {
        return widgetResult(
          {
            version: 2,
            widget: "tasklane-board",
            title: "TaskLane",
            rendering: "native-widget",
            mode: "global",
            boardHome,
          },
          "Opened the global TaskLane board widget.",
        );
      }

      // 空白/非字符串 projectDir：明确报错，不误触发全局模式
      if (typeof input.projectDir !== "string" || !input.projectDir.trim()) {
        return widgetError(
          "[VALIDATION] projectDir 不能为空字符串；项目聊天请传当前工作区绝对路径，" +
            "不带该参数则打开全局看板。",
        );
      }
      const rawDir = input.projectDir.trim();
      if (!path.isAbsolute(rawDir)) {
        return widgetError(
          `[VALIDATION] projectDir 必须是绝对路径: ${rawDir}（不能从插件目录或全局聊天目录推断项目）`,
        );
      }

      const projectDir = path.resolve(rawDir);
      const baseBranch =
        typeof input.baseBranch === "string" && input.baseBranch.trim()
          ? input.baseBranch.trim()
          : "main";

      try {
        // resolveProjectBoard：已登记仓库按身份直接复用（不因传入 baseBranch 无效而拒绝）；
        // 未登记时校验工作区与基线；空仓库允许当前未提交分支，基线缺省 main。
        const board = await engine.resolveProjectBoard({ repo: projectDir, baseBranch });
        return widgetResult(
          {
            version: 2,
            widget: "tasklane-board",
            title: "TaskLane",
            rendering: "native-widget",
            mode: "project",
            boardHome,
            projectDir,
            repoRoot: board.repo ?? projectDir,
            lockedBoardId: board.id,
            boardName: board.name,
          },
          `Opened the TaskLane board widget locked to ${board.name} (${board.repo}).`,
        );
      } catch (err) {
        // 路径无效/非 Git 目录/基线不匹配：明确提示并停止打开，不回退全局第一个仓库。
        const message = err instanceof Error ? err.message : String(err);
        return widgetError(`[VALIDATION] 项目看板打开失败: ${message}`);
      }
    },
  );
}
