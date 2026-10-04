## [2026-10-03 22:54 +0800] | 任务：重构 README 并归位开发文档

### 执行上下文

- **Agent ID**：`zcode`
- **Base Model**：`GLM-5.3`
- **Runtime**：ZCode 桌面（macOS darwin 25.6.0 arm64）
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main`（仓库尚无任何提交，全部文件处于暂存/工作区状态）
- **关联计划**：无

### 用户诉求

> 修改 README.md：
> 1. `## 目录结构` 及以后的内容不应在 README 里，AGENTS.md 里已经存在了。
> 2. `### 原生执行闭环`、`## 关键设计决策与宿主能力` 也不应该在 README 里，属于 AGENTS.md 的。
> 3. git（GitHub 远端）已添加，增加 Codex 插件的安装使用方法和更新方法。
> 4. 最后补充仓库协议。
> 追加（截图指认）：README 顶部的 `open_tasklane` 说明段与 `Codex Host` 架构树这一块也不应该在 README 中。

### 变更概览

**影响范围**：`README.md`、`AGENTS.md`（纯文档改动）。

**主要操作**：

- **README.md 重构**：删除架构树、`open_tasklane` 宿主说明段、`目录结构`、`原生执行闭环`、`关键设计决策与宿主能力`、`里程碑状态`、`已知限制` 等开发向章节；新增「安装 Codex 插件」（marketplace add / install + 项目/全局打开方式）与「更新插件」（marketplace upgrade + 重装 + 会话与数据迁移注意事项）章节；快速开始改名「快速开始（源码开发）」并指向安装节；文末新增「许可证」章节（MIT，与 `plugins/tasklane/plugin.json` 声明一致）。
- **AGENTS.md 归位**：`项目结构与模块组织` 下新增「整体架构」（原 README 架构树 + `open_tasklane` 宿主说明，措辞改为仓库视角）；新增「原生执行闭环与宿主能力边界」章节（原 README 两个章节内容合并，交付边界去除会话级表述）；文末新增「里程碑状态与已知限制」；更新文档索引行以反映 README 新定位。

### 设计动机

README 定位收敛为面向使用者的文档（是什么、装插件、跑服务、工具契约、协议），开发与验收细节归 AGENTS.md，避免两处重复维护。安装/更新命令采用 Codex 插件 marketplace CLI（`codex plugin marketplace add / install / upgrade`），安装标识 `tasklane@tasklane` 与根目录 `.claude-plugin/marketplace.json` 的市场名/插件名一致，远端使用已添加的 GitHub 仓库 `aceHubert/tasklane-mcp-extension`。许可证章节沿用插件清单已声明的 MIT，未引入新决定。里程碑与已知限制按「关键决定、验证结果和未完成事项必须留档」要求移入 AGENTS.md 而非直接删除。

### 验证结果

- 命令与结果：校验 README 引用的相对路径（`extension/README.md`、`docs/native-execution-contract.md`、`.claude-plugin/marketplace.json`、`mcp/src/register.ts`、`scripts/git-verify.mjs`）与 `package.json` scripts（`build:plugin`、`verify:plugin` 等 12 个）均存在，通过。应用测试未执行（纯文档改动，按仓库指南不必运行）。
- 手工验证及环境：`codex plugin marketplace add/install/upgrade` 命令句式依据 Codex 插件公开文档与多方资料交叉确认，未在本机实测（当前环境无 Codex CLI）。
- 未覆盖场景：Codex 宿主内实际执行上述安装/更新命令的效果；`codex plugin` 各子命令在不同宿主版本间的差异。

### 变更统计

> 仓库尚无提交且 README 任务前已有未暂存改动，故使用任务前快照对比：README 与任务前工作区全文对比；AGENTS.md 与暂存区版本（`git show :AGENTS.md`，任务前无未暂存改动）对比。均使用 `git diff --no-index --numstat/--shortstat`，排除历史记录自身。

- **统计口径**：仅统计本次任务实际修改的 2 个文件，历史记录文件不计入。
- **变更文件数**：2
- **新增行数**：+129
- **删除行数**：-110

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `README.md` | 35 | 109 |
| `AGENTS.md` | 94 | 1 |

### 修改文件

- `README.md`
- `AGENTS.md`
- `docs/histories/2026-10/20261003-2254-readme-restructure.md`（本记录，不计入统计）

### 后续事项

- 仓库根目录尚无独立 `LICENSE` 文本文件，README 已声明 MIT；如需对外发布建议补齐标准 MIT 文本。
- Codex 插件安装/更新命令待在真实 Codex 宿主中实测一次并回填验收结果。
