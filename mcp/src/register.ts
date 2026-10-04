import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BoardError,
  EXECUTION_MODEL_MAX_LENGTH,
  EXECUTION_MODEL_PATTERN,
  ModelCatalogService,
  type BoardEngine,
} from '@tasklane/core';
import * as handlers from './handlers.js';

const statusSchema = z.enum(['backlog', 'ready', 'doing', 'review', 'done']);
const prioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
const assigneeSchema = z.enum(['human', 'agent']);
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
  runId: identifierSchema.describe('task_execution_request 返回的服务端运行代次'),
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
) {
  return async (args: A) => {
    try {
      return ok(await fn(engine, args));
    } catch (err) {
      return fail(err);
    }
  };
}

export function registerAllTools(server: McpServer, engine: BoardEngine, catalog: ModelCatalogService): void {
  server.registerTool(
    'board_list',
    {
      title: 'board_list',
      description:
        '列出看板（项目/仓库）及其各状态任务计数（counts/total 仅统计未归档任务，' +
        '归档数量单独以 archivedCount 返回）。对应 UI 的 Project/Repo selector。',
      inputSchema: {},
    },
    wrap(engine, handlers.boardList),
  );

  server.registerTool(
    'board_create',
    {
      title: 'board_create',
      description:
        '注册已有本地 Git 仓库为新看板（多仓库管理入口）。校验仓库工作区/根目录/基线分支；' +
        '尚无提交的仓库也可注册，基线使用当前未提交分支；创建任务 worktree 前才需要首次提交。' +
        '同一仓库（子目录/符号链接/worktree 视角）重复注册幂等返回已有看板。' +
        'Agent 工作流：board_list → 确认目标 boardId → 任务操作。',
      inputSchema: {
        repo: z.string().min(1).describe('本地 Git 仓库绝对路径（worktree/子目录会归位到主仓库）'),
        name: z.string().min(1).optional().describe('看板名称，省略时使用仓库目录名'),
        baseBranch: z.string().min(1).optional().describe('基线分支，默认 main；须为已存在的本地分支或空仓库当前未提交分支（当前分支非 main 时须显式指定）'),
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
      description: '创建任务（归属于指定看板）。默认 P2 / backlog / human。对应 UI 的 New Task。',
      inputSchema: {
        title: z.string().min(1).describe('任务标题（必填）'),
        boardId: boardIdSchema,
        description: z.string().optional().describe('任务描述（Markdown，可选）'),
        priority: prioritySchema.optional().describe('优先级，默认 P2'),
        status: statusSchema.optional().describe('初始状态，默认 backlog'),
      },
    },
    wrap(engine, handlers.taskCreate),
  );

  server.registerTool(
    'task_update',
    {
      title: 'task_update',
      description:
        '编辑任务字段（标题/描述/优先级）。boardId 仅作归属校验，不是可修改字段。' +
        '旧 execution 子补丁仅保留输入兼容，任何无关联执行写入均返回 EXECUTION_REPORT_REQUIRED；' +
        '真实执行状态与活动摘要必须通过 task_execution_report 关联请求和原生绑定回报。',
      inputSchema: {
        id: idSchema,
        boardId: boardIdSchema,
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        priority: prioritySchema.optional(),
        execution: z
          .object({
            state: executionStateSchema.optional().describe('旧执行状态字段（写入被拒绝，请用 task_execution_report）'),
            activity: z.string().max(200).optional().describe('旧活动摘要字段（写入被拒绝）'),
          })
          .strict()
          .optional(),
      },
    },
    wrap(engine, handlers.taskUpdate),
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

  server.registerTool(
    'task_assign',
    {
      title: 'task_assign',
      description:
        '只指派任务给 human 或 agent，不创建 session、原生聊天、分支或 worktree，不改变真实执行回执。' +
        '启动/续接必须由已验证原生工具的接收 Agent 按 task_execution_* 契约处理；改派 human 不是停止执行。',
      inputSchema: {
        id: idSchema,
        assignee: assigneeSchema.describe('human | agent'),
        boardId: boardIdSchema,
      },
    },
    wrap(engine, handlers.taskAssign),
  );

  server.registerTool(
    'task_execution_request',
    {
      title: 'task_execution_request',
      description:
        '记录用户明确要求的原生执行请求，并在同一事务内标记负责人为 agent；不调用执行器、不创建聊天/工作区。' +
        'start 仅用于尚未绑定任务；reply/continue/retry 复用原绑定，reply 须携带完整非空消息。' +
        'blocked 仅允许 continue：保留已知会话/工作区，先核对宿主状态和阻塞原因再继续；' +
        '没有真实创建结果时先用恢复核对取回原结果，禁止重新创建。' +
        'model 可在 start 时指定新会话模型，后续动作禁止覆盖原会话模型。' +
        'hostId/receiverThreadId 仅为可选初始路由提示，可全部省略，由接收 Agent 在认领时核对真实身份。' +
        '相同请求幂等重放或合并未确认请求；created=false 时不得再次投递。' +
        '新请求仅为 starting，未知结果不得自动重试创建。',
      inputSchema: z.object({
        ...executionTargetSchema,
        action: z.enum(['start', 'reply', 'continue', 'retry']),
        workspaceMode: z.enum(['project', 'worktree', 'existing']),
        hostId: hostIdSchema.optional().describe('可选的初始宿主路由提示，认领后不可改写'),
        receiverThreadId: threadIdSchema.optional().describe('可选的初始接收聊天路由提示，禁止占位标识'),
        message: z.string().max(20000).optional().describe('完整用户消息；reply 时核心校验非空，禁止用活动摘要替代'),
        model: z.string().trim().min(1).max(EXECUTION_MODEL_MAX_LENGTH).regex(EXECUTION_MODEL_PATTERN).optional()
          .describe('仅 start 可选：创建会话的模型 ID，省略时使用宿主默认模型'),
      }).strict(),
    },
    wrap(engine, handlers.taskExecutionRequest),
  );

  server.registerTool(
    'task_execution_recovery_request',
    {
      title: 'task_execution_recovery_request',
      description:
        '用户显式发起一条宿主核对/恢复消息前记录 checkId 与当前请求快照，不直接取消或重置执行。' +
        'purpose=status 可核对当前运行中、等待或终态，只允许审计与目标补回执，禁止解除请求；省略时保持等待恢复语义。' +
        '同用途未超时 pending 核对合并不重复投递，不同用途的在途检查不可互相覆盖；实际线程状态由接收 Agent 使用原生工具核对后回报。',
      inputSchema: z.object({ ...executionReceiptSchema, checkId: identifierSchema, purpose: z.enum(['status', 'recovery']).optional() }).strict(),
    },
    wrap(engine, handlers.taskExecutionRecoveryRequest),
  );

  server.registerTool(
    'task_execution_recover',
    {
      title: 'task_execution_recover',
      description:
        '接收恢复核对消息的 Agent 使用原生工具读取相关线程后回报 busy/unknown/resumed/stopped，UI 不得直接 reset。' +
        'purpose=status 的核对只记审计，不改变执行状态，不能报告 stopped；实际执行变化须由真实目标用 task_execution_report 回写。' +
        'stopped 须提供新鲜真实观测、确认旧操作结束且匹配核对快照；当前核对 Agent 活跃时只可明确证明其上一操作已结束。' +
        '不是停止 Codex，不删除聊天/工作区；确认结束才解除等待，已有创建结果后续必须复用，禁止重建。',
      inputSchema: z.object({
        ...executionReceiptSchema,
        checkId: identifierSchema,
        checkerThreadId: threadIdSchema,
        hostId: hostIdSchema,
        outcome: z.enum(['busy', 'unknown', 'resumed', 'stopped']),
        message: z.string().trim().min(1).max(200),
        confirmedStopped: z.literal(true).optional(),
        observations: z.array(z.object({
          threadId: threadIdSchema, hostId: hostIdSchema,
          state: z.enum(['active', 'idle', 'waiting', 'unknown']),
          observedAt: z.string().datetime(),
          priorOperationEnded: z.boolean().optional(),
        }).strict()).max(4),
      }).strict(),
    },
    wrap(engine, handlers.taskExecutionRecover),
  );

  server.registerTool(
    'task_execution_delivery',
    {
      title: 'task_execution_delivery',
      description:
        '记录消息 delivered、结果未知 uncertain、明确拒绝 rejected 或绑定前阻塞 blocked，不代表 Agent 已启动或停止。' +
        '拒绝必须有非空 error；认领后的接收 Agent 拒绝须匹配 claimId 且尚无创建结果。' +
        'blocked 必须由匹配 claimId 的认领者提供非空 error；已知会话先用 created 保存，阻塞保留其真实标识及工作区。' +
        '超时/创建结果未知须保持待确认，禁止伪记拒绝或 failed；面板迟到状态不覆盖认领、绑定或运行回执。',
      inputSchema: z.object({
        ...executionReceiptSchema,
        status: z.enum(['delivered', 'uncertain', 'rejected', 'blocked']),
        error: z.string().max(200).optional().describe('最多 200 字符，rejected/blocked 必须非空；blocked 保存阻塞原因'),
        claimId: claimIdSchema.optional().describe('认领者报告 uncertain/rejected/blocked 时必须匹配原认领；blocked 必填'),
      }).strict(),
    },
    wrap(engine, handlers.taskExecutionDelivery),
  );

  server.registerTool(
    'task_execution_claim',
    {
      title: 'task_execution_claim',
      description:
        '接收 Agent 核对真实 hostId/receiverThreadId 后原子认领请求，两字段必须同时提供。' +
        '无初始路由时必须提供真实接收者；旧请求可沿用原路由。相同 claimId 幂等且不能替换接收者。' +
        '其他认领者返回 EXECUTION_CONFLICT；明确拒绝后必须由用户请求新一轮。' +
        '不得超时抢占、再次创建聊天；结果未知时先核对已持久化映射。',
      inputSchema: z.object({
        ...executionReceiptSchema,
        claimId: claimIdSchema,
        hostId: hostIdSchema.optional(),
        receiverThreadId: threadIdSchema.optional().describe('核对后的真实接收 Agent 聊天，必须与 hostId 成对提供'),
      }).strict(),
    },
    wrap(engine, handlers.taskExecutionClaim),
  );

  server.registerTool(
    'task_execution_bind',
    {
      title: 'task_execution_bind',
      description:
        '持久化经原生工具实际返回并核对的聊天/工作区结果：先 phase=created 立即保存，再 phase=bound 引用相同结果。' +
        'created 锁内校验就绪标识、绝对路径和不可替换规则，立即保存结果；bound 再只读验证 Git 根、仓库身份和工作区模式。' +
        '旧工作区必须原样复用；不创建或重置分支/worktree。' +
        '绑定不是 running；拒绝 sess-*、创建中占位值及不匹配的关联。',
      inputSchema: z.object({
        ...executionReceiptSchema,
        claimId: claimIdSchema,
        phase: z.enum(['created', 'bound']),
        threadId: threadIdSchema,
        hostId: hostIdSchema,
        workspacePath: z.string().min(1).describe('原生工具实际返回的绝对目录；created 先保存，bound 验证自身是正确 Git 工作区根'),
        workspaceOwner: z.enum(['codex', 'tasklane', 'user']),
        branch: identifierSchema.optional().describe('实际检出的分支（可选，提供时必须与工作区一致）'),
      }).strict(),
    },
    wrap(engine, handlers.taskExecutionBind),
  );

  server.registerTool(
    'task_execution_report',
    {
      title: 'task_execution_report',
      description:
        '由执行 Agent 关联当前 requestId/runId 和真实 hostId/threadId 回报 running/waiting/blocked/failed/completed。' +
        'blocked 必须提供非空 activity 说明阻塞原因并保留会话绑定；不是停止证明，用户 continue 前须重新核对原会话状态。' +
        'reportId 幂等，旧代次回执不可覆盖当前执行，终态不可回退；completed 必须已有真实开始回执。' +
        '本轮首次有效 running 回执将 Ready 任务原子移至 Doing；后续 running 不覆盖手动流转，其他阶段仍通过 task_move 推进。这些校验不证明调用者身份。',
      inputSchema: z.object({
        ...executionReceiptSchema,
        threadId: threadIdSchema,
        hostId: hostIdSchema,
        reportId: identifierSchema.describe('本次回执幂等标识'),
        state: z.enum(['running', 'waiting', 'blocked', 'failed', 'completed']),
        activity: z.string().max(200).optional().describe('活动短摘要，最多 200 字符；blocked 必须提供非空阻塞原因；不是完整回复或进程监控'),
      }).strict(),
    },
    wrap(engine, handlers.taskExecutionReport),
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
    },
    wrap(engine, handlers.taskArchiveDone),
  );
}
