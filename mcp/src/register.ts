import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BoardError,
  EXECUTION_MODEL_MAX_LENGTH,
  EXECUTION_MODEL_PATTERN,
  ModelCatalogService,
  parseDeadline,
  type BoardEngine,
} from '@tasklane/core';
import * as handlers from './handlers.js';
import type { TaskExecutionActionInput, TaskUpdateActionInput } from './handlers.js';

const statusSchema = z.enum(['backlog', 'ready', 'doing', 'review', 'done']);
const prioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
const assigneeSchema = z.enum(['human', 'agent']);
/**
 * 截止时间：严格语法与日历校验（拒绝 02-30 等不存在的日期）；
 * 无时区标记按 UTC 解析，本地输入方应提交带时区偏移或 Z 的 ISO。
 */
const deadlineSchema = z
  .string()
  .refine((value) => parseDeadline(value) !== null, 'deadline 必须是真实存在的日期时间（如 2026-02-30 会被拒绝）');
const executionStateSchema = z.enum([
  'idle',
  'assigned',
  'starting',
  'running',
  'waiting',
  'blocked',
  'failed',
  'completed',
]);
const identifierSchema = z.string().min(1).max(200).refine((value) => value.trim().length > 0, '标识符不能为空白');
const idSchema = identifierSchema.describe('任务 ID，如 TASK-128（大小写不敏感）');
const executionTargetSchema = {
  id: idSchema,
  boardId: identifierSchema.describe('目标看板 ID（必填，事务内校验任务归属与归档状态）'),
  requestId: identifierSchema.describe('请求幂等标识（相同请求重放不启动新一轮）'),
};
const executionReceiptSchema = {
  ...executionTargetSchema,
  runId: identifierSchema.describe('task_execution 返回的服务端运行代次'),
};
const hostIdSchema = identifierSchema.describe('已核对的原生宿主标识（不代表调用者身份认证）');
const threadIdSchema = identifierSchema.describe('原生工具返回的就绪聊天标识，不接受 sess-* 或创建中占位值');
const claimIdSchema = identifierSchema.describe('本次认领标识；不同 claimId 不得抢占或再次创建聊天');
const boardIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    '目标看板 ID（board_list 可查）。列表/创建省略时仅单看板自动解析，多看板必须指定；' +
      '按任务 ID 的操作省略时用任务自身归属，传入错误归属会被拒绝',
  );

/** ok()/fail() 的公共结果形状：装饰器据此识别错误结果并合并 widget 字段 */
interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  // registerTool 期望结果可携带任意扩展键（如 _meta.widgetData）
  [key: string]: unknown;
}

/**
 * 插件入口注入的 MCP Apps 装饰。独立模式（stdio 直连、测试默认）不传，
 * 工具定义与结果和现状逐字段一致；仅插件模式把 task_execution_report
 * 绑定为报告卡片（宿主在会话流渲染 TaskLane 卡片，展开聚焦任务详情）。
 */
export interface AppsToolDecorations {
  /** MCP Apps widget 资源 URI，与插件注册的 ui:// 资源同源 */
  resourceUri: string;
  /**
   * 成功结果的 widget 字段回调：返回并入 structuredContent 的字段；
   * 返回 null 表示本次结果不附卡片（保留纯结果，不阻塞回执）。错误结果不经过回调。
   */
  widgetDataFor(result: Record<string, unknown>): Record<string, unknown> | null;
}

function ok(result: unknown) {
  // 文本与 structuredContent 使用同一份 JSON，兼容旧客户端且不丢失完整请求/回执。
  const structuredContent = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

function fail(err: unknown) {
  const code = err instanceof BoardError ? err.code : 'INTERNAL_ERROR';
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: `[${code}] ${message}` }],
    isError: true,
  };
}

function wrap<A extends object>(
  engine: BoardEngine,
  fn: (engine: BoardEngine, args: A) => Promise<unknown>,
): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return ok(await fn(engine, args));
    } catch (err) {
      return fail(err);
    }
  };
}

export function registerAllTools(
  server: McpServer,
  engine: BoardEngine,
  catalog: ModelCatalogService,
  apps?: AppsToolDecorations,
): void {
  server.registerTool(
    'board_list',
    {
      title: 'board_list',
      description:
        '列出看板（项目/仓库）及其各状态任务计数（counts/total 仅统计未归档任务，' +
        '归档数量单独以 archivedCount 返回）。repoKey 为空表示非 Git 项目看板' +
        '（projectDir 为项目目录，无 Git 能力）；repoConflict 非 null 时为 Git 身份冲突提示。' +
        '调用时节流触发 Git 能力刷新（目录初始化/移除 Git 后自动更新）。对应 UI 的 Project/Repo selector。',
      inputSchema: {},
    },
    wrap(engine, handlers.boardList),
  );

  server.registerTool(
    'board_create',
    {
      title: 'board_create',
      description:
        '注册本地项目目录为新看板（多仓库管理入口）。Git 仓库校验工作区/根目录/基线分支；' +
        '尚无提交的仓库也可注册，基线使用当前未提交分支；创建任务 worktree 前才需要首次提交。' +
        '非 Git 目录同样可注册为项目看板（projectDir 记录目录身份，Git 分支/worktree 能力不可用，' +
        '可后续初始化 Git 自动获得能力）。同一仓库或同一物理目录（含符号链接视角）重复注册幂等返回已有看板。' +
        'Agent 工作流：board_list → 确认目标 boardId → 任务操作。',
      inputSchema: {
        repo: z.string().min(1).describe('本地项目目录绝对路径（Git 仓库归位主仓库；非 Git 目录按真实路径注册）'),
        name: z.string().min(1).optional().describe('看板名称，省略时使用目录名'),
        baseBranch: z.string().min(1).optional().describe('基线分支（仅 Git 项目），默认 main；须为已存在的本地分支或空仓库当前未提交分支'),
      },
    },
    wrap(engine, handlers.boardCreate),
  );

  server.registerTool(
    'task_export',
    {
      title: 'task_export',
      description:
        '按时间区间导出看板任务为 Markdown 报告并写入文件（只读能力，不改任务、存储版本与执行链）。' +
        '区间缺省为「今天往前一个月」（本地时区自然日，end 含当天）；start/end 支持 YYYY-MM-DD（按本地自然日）' +
        '或完整 ISO 时间，start 晚于 end 报 VALIDATION。命中口径：任务创建、更新或归档时间任一落在区间内。' +
        'scope 缺省 all（含归档，汇报需覆盖已完成归档项）。默认写入数据目录 exports/ 下，' +
        'path 可指定绝对路径（目录则补默认文件名，缺少 .md 时补全）；同名文件按覆盖处理。' +
        '返回 path、bytes、range、scope、stats 与完整 markdown（UI 预览与复制使用）。' +
        '对应 UI 头部的「导出报告」。',
      inputSchema: {
        boardId: boardIdSchema,
        start: z
          .string()
          .min(1)
          .max(40)
          .optional()
          .describe('区间开始（含），YYYY-MM-DD 或 ISO 时间；省略为 end 往前一个月'),
        end: z
          .string()
          .min(1)
          .max(40)
          .optional()
          .describe('区间结束（含），YYYY-MM-DD 或 ISO 时间；省略为今天（本地时区当天结束）'),
        scope: z
          .enum(['active', 'archived', 'all'])
          .default('all')
          .describe('导出范围：all=全部（默认，含归档），active=仅未归档，archived=仅已归档'),
        path: z
          .string()
          .min(1)
          .optional()
          .describe('报告落盘绝对路径（可选）；指向目录时补默认文件名，缺少 .md 后缀时补全'),
        lang: z
          .enum(['zh', 'en'])
          .default('zh')
          .describe('报告语言，默认 zh；UI 传入当前界面语言'),
      },
      // 面板专用（app-only）：宿主不把本工具暴露给模型，仅供 UI 调用
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    },
    wrap(engine, handlers.taskExport),
  );

  server.registerTool(
    'dir_list',
    {
      title: 'dir_list',
      description:
        '列出目录下的可见子目录（只读、单层），标记 Git 仓库及其基线分支（优先 main、其次 master，无提交时取当前分支，其余默认 main）。' +
        '添加仓库表单的文件夹选择器使用；Agent 一般不需要主动调用。',
      inputSchema: {
        path: z.string().min(1).optional().describe('要列出的目录绝对路径，省略为用户主目录'),
      },
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    },
    wrap(engine, handlers.dirList),
  );

  server.registerTool(
    'model_list',
    {
      title: 'model_list',
      description:
        '只读查询当前 Codex 宿主可用的模型目录（经 codex app-server 的 model/list，与宿主模型选择器同源）。' +
        '返回 models（id/displayName/isDefault/supportedReasoningEfforts）与 defaultModelId，供 UI 指定模型候选；' +
        'Agent 一般不需要主动调用。仅提供候选：不改变执行、会话或工作区，也不是执行兜底。',
      inputSchema: {},
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    },
    async () => {
      try {
        return ok(await handlers.modelList(catalog));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'task_list',
    {
      title: 'task_list',
      description:
        '按看板/状态/指派/优先级/归档范围过滤任务列表。默认只返回未归档任务（active）；' +
        'archived 查看归档区，all 返回全部（含归档，供完整同步）。对应 UI 的状态任务列表与多列 Board。',
      inputSchema: {
        boardId: boardIdSchema,
        status: statusSchema.optional().describe('按任务状态过滤'),
        assignee: assigneeSchema.optional().describe('按指派对象过滤'),
        priority: prioritySchema.optional().describe('按优先级过滤'),
        archive: z
          .enum(['active', 'archived', 'all'])
          .default('active')
          .describe('归档范围：active=未归档（默认），archived=已归档，all=全部'),
      },
    },
    wrap(engine, handlers.taskList),
  );

  server.registerTool(
    'task_get',
    {
      title: 'task_get',
      description: '读取单个任务详情 + 最近执行时间线（关键事件）。对应 UI 的 Task Detail。',
      inputSchema: { id: idSchema, boardId: boardIdSchema },
    },
    wrap(engine, handlers.taskGet),
  );

  server.registerTool(
    'task_create',
    {
      title: 'task_create',
      description:
        '创建任务（归属于指定看板）。默认 P2 / backlog / human。' +
        'deadline 为可选截止时间（严格日历校验，无时区标记按 UTC 解析，服务端规范化为 UTC ISO）。对应 UI 的 New Task。',
      inputSchema: {
        title: z.string().min(1).describe('任务标题（必填）'),
        boardId: boardIdSchema,
        description: z.string().optional().describe('任务描述（Markdown，可选）'),
        priority: prioritySchema.optional().describe('优先级，默认 P2'),
        status: statusSchema.optional().describe('初始状态，默认 backlog'),
        deadline: deadlineSchema.optional().describe('截止时间（可空；无时区标记按 UTC，如 2026-10-10T18:00:00+08:00）'),
      },
    },
    wrap(engine, handlers.taskCreate),
  );

  server.registerTool(
    'task_update',
    {
      title: 'task_update',
      description:
        '任务编辑复合入口，按 action 分发：' +
        'update=编辑字段（标题/描述/优先级/截止时间；boardId 仅作归属校验；deadline 传字符串为设置（规范化 UTC ISO）、' +
        '传 null 为清除、不传不动；旧 execution 子补丁仅保留输入兼容，任何无关联执行写入均返回 EXECUTION_REPORT_REQUIRED）；' +
        'assign=只指派 human/agent 负责人（不创建 session、原生聊天、分支或 worktree，不改变真实执行回执，改派 human 不是停止执行）；' +
        'review=更新 Review 工作流状态（仅 review 列，跨 Agent 共用）：expectedRevision 必须匹配 task.review.revision（CAS），' +
        '过期返回 REVIEW_STALE，须 task_get 后重试，不能静默覆盖他人结论；changes_requested / approved 须非空 conclusion 并关闭当前验收轮；' +
        'reviewing / fixing 不得绕过真实 running 回执；recheck_pending 由实现方完成修改后提交（changes_requested / fixing 均可进入）；' +
        'approved 不自动移动 Done，execution completed 不等于 approved，每轮结论持久留存，新轮不覆盖旧轮。',
      // SDK 仅向客户端公布 object 形状的 schema：复合工具用扁平字段 + superRefine
      // 按 action 校验分支必填项（引擎层保留全部原有校验）。
      inputSchema: z
        .object({
          action: z.enum(['update', 'assign', 'review']).describe('分发动作：update=字段编辑；assign=指派负责人；review=验收状态（CAS）'),
          id: idSchema,
          boardId: boardIdSchema,
          title: z.string().min(1).optional(),
          description: z.string().optional(),
          priority: prioritySchema.optional(),
          deadline: deadlineSchema.nullable().optional().describe('截止时间；传 null 清除（无时区标记按 UTC 解析）'),
          execution: z
            .object({
              state: executionStateSchema.optional().describe('旧执行状态字段（写入被拒绝，请用 task_execution action=report）'),
              activity: z.string().max(200).optional().describe('旧活动摘要字段（写入被拒绝）'),
            })
            .strict()
            .optional(),
          assignee: assigneeSchema.optional().describe('assign 必填：human | agent'),
          expectedRevision: z.number().int().min(0).optional().describe('review 必填：task_get 读取的当前 review.revision（CAS）'),
          status: z.enum(['reviewing', 'changes_requested', 'fixing', 'recheck_pending', 'approved']).optional()
            .describe('review 必填：本轮验收状态'),
          conclusion: z.string().trim().min(1).max(20000).optional()
            .describe('review 结论；changes_requested / approved 必填并持久保存'),
          actor: z.object({
            type: z.enum(['human', 'agent']),
            provider: z.string().trim().min(1).max(64).optional(),
            sessionId: z.string().trim().min(1).max(200).optional()
              .describe('更新者审计标识（provider-local，不是 Codex thread 绑定）'),
          }).strict().optional().describe('更新者审计信息（可选）'),
        })
        .strict(),
      // 分支必填（assign 的 assignee、review 的 boardId/expectedRevision/status）
      // 在 handler 层校验：superRefine 会把 schema 变成 ZodEffects，SDK 将不再公布字段。
    },
    wrap<TaskUpdateActionInput>(
      engine,
      handlers.taskUpdate as (engine: BoardEngine, args: TaskUpdateActionInput) => Promise<unknown>,
      // zod 扁平解析结果与联合入参运行时等价（superRefine 已保证分支必填）
    ) as unknown as (args: object, extra: object) => Promise<ToolResult>,
  );

  server.registerTool(
    'task_delete',
    {
      title: 'task_delete',
      description:
        '硬删除单个任务：任务与执行时间线/会话记录一并移除，不可恢复。仅允许 backlog 状态且' +
        '未进入执行链（无原生聊天绑定、执行态为 idle/assigned）的任务；非 backlog 拒绝，' +
        '已完成任务请使用 task_archive 留痕。对应 UI 任务详情底部的「删除任务」（需二次确认）。',
      inputSchema: {
        id: idSchema,
        boardId: boardIdSchema,
      },
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    },
    wrap(engine, handlers.taskDelete),
  );

  server.registerTool(
    'task_move',
    {
      title: 'task_move',
      description:
        '只移动任务业务状态（前向流转 + 一步回退），不启动、停止或完成执行。' +
        'doing→review 只读取已有工作区的变更摘要，不创建分支/worktree；执行状态只能由关联回执推进。',
      inputSchema: {
        id: idSchema,
        status: statusSchema.describe('目标状态'),
        boardId: boardIdSchema,
      },
    },
    wrap(engine, handlers.taskMove),
  );

  // 插件模式把回执分支（action=report）绑定为报告卡片：工具 _meta 对齐 open_tasklane
  // 最小集（不挂 openai/ui entrypoints，避免执行回执出现在侧边栏入口）。
  const reportMeta: Record<string, unknown> = apps
    ? {
        _meta: {
          ui: { resourceUri: apps.resourceUri, visibility: ['model', 'app'] },
          'openai/outputTemplate': apps.resourceUri,
          'openai/widgetAccessible': true,
          'openai/toolInvocation/invoking': '正在更新任务状态…',
          'openai/toolInvocation/invoked': '任务状态已更新',
        },
      }
    : {};
  const executionHandler = wrap<TaskExecutionActionInput>(
    engine,
    handlers.taskExecution as (engine: BoardEngine, args: TaskExecutionActionInput) => Promise<unknown>,
  );
  server.registerTool(
    'task_execution',
    {
      title: apps ? 'TaskLane 任务报告' : 'task_execution',
      description:
        '原生执行链复合入口，按 action 分发；六个子操作与原六个工具一一对应，全部校验保留：\n' +
        'request=记录用户明确要求的原生执行请求，并在同一事务内标记负责人为 agent；不调用执行器、不创建聊天/工作区。' +
        'requestAction：start 用于尚未绑定任务；明确分发失败后的用户新请求通过 recoveryOf 复用已知创建结果，' +
        '重新核对 created→bound 并向同一聊天投递，不能重复创建；reply/continue/retry 复用原绑定，reply 须携带完整非空消息；' +
        'blocked 仅允许 continue：保留已知会话/工作区，先核对宿主状态和阻塞原因再继续；没有真实创建结果时先等待用户在面板' +
        '人工解除等待（task_execution_recover），禁止重新创建。purpose 省略按 implementation；purpose=review 表示独立验收执行' +
        '（reviewExecution/reviewBinding），仅支持 start（首次验收，服务端解析实现工作区并锁定到请求）与 continue（复查，' +
        '复用 reviewBinding）；首次验收分发失败后仍复用已知验收聊天，真实 running 才开启验收轮次。' +
        'workspaceMode 必须为 existing；无项目看板任务不参与 Review 流转，review 请求被拒绝。' +
        'workspaceMode=projectless 表示无项目执行（仅无项目看板）：原生创建使用 create_thread target {type:"projectless"}，' +
        '不传 projectId，不记录工作区；非 Git 项目看板用 project 在项目目录执行，worktree 仅 Git 项目可用。' +
        'model 仅 start 可选指定新会话模型，后续动作禁止覆盖原会话模型；hostId/receiverThreadId 仅为可选初始路由提示，' +
        '可全部省略，由接收 Agent 在认领时核对真实身份。相同请求幂等重放或合并未确认请求；created=false 时不得再次投递；' +
        '新请求仅为 starting，未知结果不得自动重试创建。\n' +
        'delivery=记录消息 delivered、结果未知 uncertain、明确分发失败 rejected 或绑定前阻塞 blocked，不代表 Agent 已启动或停止；' +
        'rejected 适用于所有动作的明确分发失败，包括宿主路由不可用、创建明确失败、准备/绑定明确失败及消息投递明确失败，' +
        '必须有非空 error；认领后必须匹配原 claimId。本轮无 startedAt、无任何目标 reports 时，' +
        'claimed/created/bound/blocked/uncertain 均可收尾 rejected，保留任何真实 result/binding，' +
        'execution 恢复 assigned/idle，reviewExecution 恢复 idle，业务状态不变；task_get 确认后结束，不自动重试。' +
        '后续仅通过用户新请求重新发起；无创建结果且明确未创建时可重新 start，已知结果通过 recoveryOf 原样复用，' +
        '模式和模型保持不变。已有目标回执或真实开始不得回退；超时、传输中断或创建/发送结果未知必须 uncertain，' +
        '不能伪记分发失败，也不能用 blocked/failed 冒充明确分发失败。' +
        'blocked 必须由匹配 claimId 的认领者提供' +
        '非空 error，已知会话先用 created 保存，阻塞保留其真实标识及工作区；超时/创建结果未知须保持待确认，禁止伪记拒绝或' +
        'failed；面板迟到状态不覆盖认领、绑定或运行回执。\n' +
        'claim=接收 Agent 核对真实 hostId/receiverThreadId 后原子认领请求，两字段必须同时提供；无初始路由时必须提供真实接收者；' +
        '旧请求可沿用原路由。相同 claimId 幂等且不能替换接收者；其他认领者返回 EXECUTION_CONFLICT；明确拒绝后必须由用户请求' +
        '新一轮；不得超时抢占、再次创建聊天；结果未知时先核对已持久化映射。\n' +
        'bind=持久化经原生工具实际返回并核对的聊天/工作区结果：先 phase=created 立即保存，再 phase=bound 引用相同结果；' +
        'created 锁内校验就绪标识、绝对路径和不可替换规则，立即保存结果；bound 再只读验证 Git 根、仓库身份和工作区模式。' +
        'workspaceMode=projectless 时不记录工作区：workspacePath/workspaceOwner/branch 必须全部省略，绑定只需真实会话标识；' +
        '其他模式必须成对提供 workspacePath/workspaceOwner。旧工作区必须原样复用；不创建或重置分支/worktree；绑定不是 running；' +
        '拒绝 sess-*、创建中占位值及不匹配的关联。\n' +
        'external_bind=记录非 Codex Agent 的实现会话：provider 自己的 opaque sessionId 与实际 workspace；sessionId 保持' +
        'provider-local 语义：不解释为 Codex threadId、不产生 deep link、不支持原生续接，也不因记录推断 running 或改写执行状态；' +
        'Codex 会话必须走 bind 原生绑定。workspace 必须是任务所属看板仓库的真实工作区（Git 身份校验，主仓库或 worktree 皆可）；' +
        '已有不同外部会话时替换必须显式 force=true，且存在待确认或运行中请求时一律拒绝；相同内容重复记录幂等刷新；' +
        '该记录可供 Review 解析待验收工作区。\n' +
        'report=由执行 Agent 关联当前 requestId/runId 和真实 hostId/threadId 回报 running/waiting/blocked/failed/completed。' +
        '回执按请求持久化的 purpose 分流：implementation 写 execution，review 写 reviewExecution（无需调用者声明）。' +
        'review 的 running 在 pending/recheck_pending 时开新一轮验收轮并置 reviewing；review 的 completed 不等于 approved。' +
        'blocked 必须提供非空 activity 说明阻塞原因并保留会话绑定；不是停止证明，用户 continue 前须重新核对原会话状态。' +
        'reportId 幂等，旧代次回执不可覆盖当前执行，终态不可回退；completed 必须已有真实开始回执。' +
        '本轮首次有效 running 回执将 Ready 任务原子移至 Doing；后续 running 不覆盖手动流转，其他阶段仍通过 task_move 推进。' +
        '这些校验不证明调用者身份。',
      // 扁平字段 + superRefine：SDK 仅公布 object 形状 schema（union 会被清空）。
      // 分支必填在 refine 层表达，业务校验全部保留在引擎。
      inputSchema: z
        .object({
          action: z.enum(['request', 'delivery', 'claim', 'bind', 'external_bind', 'report'])
            .describe('执行链动作：request=发起请求；delivery=投递结果；claim=认领；bind=原生绑定；external_bind=非 Codex 会话；report=执行回执'),
          id: idSchema,
          boardId: identifierSchema.describe('目标看板 ID（必填，事务内校验任务归属与归档状态）'),
          requestId: identifierSchema.optional().describe('请求幂等标识（request/delivery/claim/bind/report 必填）'),
          runId: identifierSchema.optional().describe('task_execution 返回的服务端运行代次（receipt 类 action 必填）'),
          requestAction: z.enum(['start', 'reply', 'continue', 'retry']).optional().describe('request 必填：请求子动作（首次 start / 回复 reply / 续接 continue / 重试 retry）'),
          workspaceMode: z.enum(['project', 'worktree', 'existing', 'projectless']).optional().describe('request 必填：工作区模式'),
          purpose: z.enum(['implementation', 'review']).optional()
            .describe('request：执行目的，省略为 implementation；review 为独立验收会话（start/continue + existing）'),
          hostId: hostIdSchema.optional(),
          receiverThreadId: threadIdSchema.optional().describe('request/claim：真实接收 Agent 聊天（claim 须与 hostId 成对提供）'),
          message: z.string().max(20000).optional().describe('request：完整用户消息；reply 时核心校验非空，禁止用活动摘要替代'),
          model: z.string().trim().min(1).max(EXECUTION_MODEL_MAX_LENGTH).regex(EXECUTION_MODEL_PATTERN).optional()
            .describe('request：仅 start 可选，创建会话的模型 ID；首次省略时使用宿主默认，分发恢复时省略继承原模型且禁止更换'),
          status: z.enum(['delivered', 'uncertain', 'rejected', 'blocked']).optional().describe('delivery 必填：delivered=已投递；uncertain=结果未知；rejected=明确分发失败；blocked=原操作仍受阻'),
          error: z.string().max(200).optional().describe('delivery：最多 200 字符，rejected/blocked 必须非空；rejected 保存明确分发失败原因，blocked 保存阻塞原因'),
          claimId: claimIdSchema.optional().describe('claim/bind 必填：本次认领标识；delivery 的 uncertain/rejected/blocked 须匹配原认领'),
          phase: z.enum(['created', 'bound']).optional().describe('bind 必填：created 先保存，bound 再只读核验'),
          threadId: threadIdSchema.optional().describe('bind/report 必填：原生工具返回的就绪聊天标识'),
          workspacePath: z.string().min(1).optional().describe('bind/external_bind：实际执行目录绝对路径（projectless 请求必须省略）'),
          workspaceOwner: z.enum(['codex', 'tasklane', 'user', 'agent']).optional()
            .describe('bind：codex/tasklane/user（须与 workspacePath 成对）；external_bind：user/tasklane/agent'),
          branch: identifierSchema.optional().describe('bind/external_bind：实际检出分支（可选，须与工作区一致；projectless 禁止）'),
          provider: z.string().trim().min(1).max(64).optional().describe('external_bind 必填：提供方标识（如 claude-code、cursor-agent；禁止 codex-desktop）'),
          sessionId: z.string().trim().min(1).max(200).optional().describe('external_bind 必填：provider 本地会话标识（opaque，不套用 Codex thread 规则）'),
          force: z.boolean().optional().describe('external_bind：替换已有不同外部会话须显式 true；活跃执行期间仍会拒绝'),
          reportId: identifierSchema.optional().describe('report 必填：本次回执幂等标识'),
          state: z.enum(['running', 'waiting', 'blocked', 'failed', 'completed']).optional().describe('report 必填：回执状态'),
          activity: z.string().max(200).optional().describe('report：活动短摘要；blocked 必须提供非空阻塞原因；不是完整回复或进程监控'),
        })
        .strict()
        .strict(),
      // 分支必填由 handler 按动作校验（superRefine 会破坏 schema 公示）。
      ...reportMeta,
    },
    apps
      ? async (args) => {
          const result = await executionHandler(args as TaskExecutionActionInput);
          // 卡片装饰仅作用于回执分支：其余 action 结果原样返回。
          // 装饰是展示增强：回执此时已成功持久化，装饰链路的任何异常都不得把成功
          // 结果变成错误——组装器注入不可序列化数据时同样降级为纯结果，诊断写入 stderr。
          if (args.action !== 'report' || result.isError || !result.structuredContent) return result;
          try {
            const widgetData = apps.widgetDataFor(result.structuredContent);
            if (!widgetData) return result;
            // 合并后 text 与 structuredContent 保持 ok() 的同源不变式；_meta.widgetData 为同一合并对象。
            const structuredContent = { ...result.structuredContent, ...widgetData };
            return {
              content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
              structuredContent,
              _meta: { 'openai/outputTemplate': apps.resourceUri, widgetData: structuredContent },
            };
          } catch (err) {
            console.error(`[tasklane] 回执卡片装饰失败，降级为纯结果: ${err instanceof Error ? err.message : String(err)}`);
            return result;
          }
        }
      : (executionHandler as unknown as (args: object, extra: object) => Promise<ToolResult>),
  );

  // 面板专用等待解除（app-only，模型不可见）：发起核对改为 UI 直发消息，
  // 存活回报走 task_execution action=report，本工具只承载用户确认旧会话
  // 已结束后的解除动作；守卫在 core release（仅等待态可解除 + 幂等重放）。
  server.registerTool(
    'task_execution_recover',
    {
      title: 'task_execution_recover',
      description:
        '面板专用（模型不可见）：用户显式确认旧会话已结束后，解除仍在等待宿主回执的执行请求。' +
        '解除即取消该请求并把执行状态复位（实现回 assigned/idle、验收回 idle），已有创建结果后续必须复用，禁止重建；' +
        '不是停止证明，运行中的真实状态变化仍只能由目标会话通过 task_execution action=report 回写。',
      inputSchema: z.object({
        id: idSchema,
        boardId: identifierSchema.describe('目标看板 ID（必填，事务内校验任务归属与归档状态）'),
        requestId: identifierSchema.describe('待解除的执行请求 ID'),
        runId: identifierSchema.describe('请求对应的服务端运行代次'),
        reason: z.string().trim().min(1).max(200).describe('解除原因（必填，写入时间线）'),
      }).strict(),
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    },
    wrap(engine, handlers.taskExecutionRecover),
  );

  server.registerTool(
    'task_archive',
    {
      title: 'task_archive',
      description:
        '归档单个已完成（done）任务：从日常看板与状态计数中移出，任务内容、执行记录、' +
        '分支与 worktree 绑定全部保留（task_get 仍可读取）。仅允许 done 任务；' +
        '重复归档幂等（changed=false，不重复更新时间与时间线）。对应 UI Done 卡片的「归档」。',
      inputSchema: {
        id: idSchema,
        boardId: boardIdSchema,
      },
    },
    wrap(engine, handlers.taskArchive),
  );

  server.registerTool(
    'task_restore',
    {
      title: 'task_restore',
      description:
        '恢复归档任务到 Done 列（移除 archivedAt，保持 status: done），内容与执行记录不变。' +
        '重复恢复幂等（changed=false）。对应 UI 归档区的「恢复到 Done」。',
      inputSchema: {
        id: idSchema,
        boardId: boardIdSchema,
      },
    },
    wrap(engine, handlers.taskRestore),
  );

  server.registerTool(
    'task_archive_done',
    {
      title: 'task_archive_done',
      description:
        '原子归档指定看板全部未归档的 done 任务：事务内按磁盘最新状态选取目标，' +
        '并发回退到 review 的任务不会被归档；失败无部分写入。boardId 必填（不提供跨看板' +
        '隐式行为）；无目标任务时返回成功且数量为 0。对应 UI 的「归档全部已完成」。',
      inputSchema: {
        boardId: z.string().min(1).describe('目标看板 ID（board_list 可查；批量操作必须显式指定）'),
      },
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    },
    wrap(engine, handlers.taskArchiveDone),
  );
}
