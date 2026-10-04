## [2026-10-04 22:36 +0800] | 任务：清理 extension/assets 未引用图标

### 执行上下文

- **Agent ID**：`zcode`
- **Base Model**：`GLM-5.3-Flash`
- **Runtime**：`ZCode CLI（macOS，darwin arm64）`
- **Git User**：`hubert <hubert@lejian.com>`
- **Branch**：`main（仓库尚无提交，全部文件为已暂存未提交状态）`
- **关联计划**：无

### 用户诉求

> 把 extension/assets 下的图标清一下，只保留使用的。canvas 下有备份。

### 变更概览

**影响范围**：`extension/assets/`。

**主要操作**：

- **删除 36 个未被引用的图标**：`liquid-glass-logo` 全套 10 个、`liquid-glass-logo-pure-black` 全套 10 个、`liquid-glass-logo-white` 全套 10 个、`kanban-liquid-glass-black-20261003.png`、`logo-20261003.png`、`logo-48/64/180/512.png`。
- **保留 5 个被引用的图标**：`logo-16/32/128/256.png`、`sidebar-icon.svg`。

### 设计动机

图标引用关系核对结果：

- `scripts/build-plugin.mjs` 组装插件包时固定复制 `logo-16/32/128/256.png` 与 `sidebar-icon.svg` 五个文件（缺失即报错）。
- `extension/plugin-src/plugin.json` 与 `.codex-plugin/plugin.json` 引用 `./assets/logo-256.png`（logo）与 `./assets/logo-32.png`（composerIcon），均由构建脚本从 `extension/assets/` 填充。
- `extension/src/plugin-server.mjs` 读取 `assets/sidebar-icon.svg` 作为 serverInfo.icons。
- UI 使用的液态玻璃 logo 在 `ui/src/assets/`、`ui/public/` 有自己的副本，不依赖 `extension/assets/`。

备份与重复核对：三个液态玻璃变体全套均在 `canvas/pages/liquid-glass-logo-*-20261003/assets/` 有同尺寸备份；`logo-20261003.png` 在 `canvas/pages/KjlNV1c5wW_75c9l57IRR/assets/` 有备份；`kanban-liquid-glass-black-20261003.png` 与 `liquid-glass-logo.png` 逐字节一致（cmp 通过），后者在 canvas 有备份；`logo-64/180.png`（favicon/touch icon 原件）与 `ui/public/` 下副本同源，UI 已自包含。回滚方式：从 `canvas/` 对应页面目录复制恢复。

### 验证结果

- `grep` 全仓库（排除 node_modules/dist/canvas）检索图标文件名：确认仅上述三处代码/清单引用保留清单内文件。
- `cmp extension/assets/kanban-liquid-glass-black-20261003.png extension/assets/liquid-glass-logo.png`：通过（逐字节一致）。
- `cmp extension/assets/liquid-glass-logo.png canvas/pages/liquid-glass-logo-20261003/assets/liquid-glass-logo.png`：通过（canvas 备份逐字节一致）。
- 删除后 `ls extension/assets/`：仅剩保留的 5 个文件。
- `pnpm build-plugin` 完整构建：未执行（脚本第 165-168 行仅做保留文件存在性检查，已人工确认五个文件齐全）。
- 未覆盖场景：未重新执行完整插件构建与 Codex 宿主加载验收。

### 变更统计

- **统计口径**：仓库尚无提交，被删 36 个文件均为“已暂存未提交”状态，工作区删除后入库净内容为零；二进制文件 numstat 无行数。
- **变更文件数**：36（全部为 PNG 删除）
- **新增行数**：+0
- **删除行数**：-0（二进制，净入库为零）

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `extension/assets/liquid-glass-logo*.png`（30 个，含 pure-black / white 变体） | bin | — |
| `extension/assets/kanban-liquid-glass-black-20261003.png` | bin | — |
| `extension/assets/logo-20261003.png`、`logo-48/64/180/512.png` | bin | — |

### 修改文件

- 删除：`extension/assets/` 下 36 个 PNG（清单见变更概览）。

### 后续事项

- 无。提交时这 36 个删除会与既有暂存的新增相抵，不影响入库内容。
