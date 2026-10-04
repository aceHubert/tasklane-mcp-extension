## [2026-10-03 18:10 +0800] | 任务：将 TaskLane 打开技能改为英文

### 执行上下文

- **Agent ID**：Codex
- **Base Model**：未知
- **Runtime**：Codex desktop，本地 macOS 工作区
- **Git User**：hubert <hubert@lejian.com>
- **Branch**：main（尚无有效 HEAD）
- **关联计划**：无

### 用户诉求

> 将 skills 以英文描述。

### 变更概览

**影响范围**：TaskLane 的 `open-tasklane` 技能源及插件包中的对应技能。

- 将 frontmatter 的 `description` 与正文操作指导全部翻译为英文。
- 保留技能名、MCP 工具名、参数示例和原操作边界，复制源文件同步插件包。

### 设计动机

按用户要求调整技能语言，保持原生 MCP 打开流程、项目传参、面板复用与失败处理规则。
本次不修改运行时代码或插件入口。

### 验证结果

- 源文件与插件包技能逐字节比较一致；frontmatter 名称与描述保留。
- `git diff --check`：通过。
- 应用构建、单元测试和原生宿主验收：未执行；本次仅改技能文本。

### 变更统计

- **统计口径**：两份技能均为未跟踪文件，与任务前快照逐文件执行
  `git diff --no-index --shortstat` 和 `--numstat`，排除已有变更及本历史记录。
- **变更文件数**：2
- **新增行数**：+14
- **删除行数**：-14

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `extension/plugin-src/skills/open-tasklane/SKILL.md` | 7 | 7 |
| `plugins/tasklane/skills/open-tasklane/SKILL.md` | 7 | 7 |

### 修改文件

- `extension/plugin-src/skills/open-tasklane/SKILL.md`
- `plugins/tasklane/skills/open-tasklane/SKILL.md`

### 后续事项

- 宿主需加载更新后的插件包才能使用英文技能；原生接入验收事项沿用前一任务记录。
