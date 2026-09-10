> 🌐 语言 / Language: **中文** · [English](./README.en.md)

# dsh-rollback · TRAE 式「回退」插件

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web 端提供一个 TRAE 式「回退到本轮对话发起前」的插件：按轮次建立检查点，一键把【工作区文件】和【模型上下文】同时回退到某一轮发起之前，保持同一会话 id。

## 是什么

`dsh-rollback` 忠实实现了 TRAE 回退功能的核心设计思想——**对话状态与文件状态对齐回滚**：

- 模型行为由「对话历史」和「工作区文件」共同决定，因此回退必须**同时**回滚两者，否则会出现幻觉延续或状态冲突。
- 回退 = 恢复该轮及之后触碰过的文件（修改→写回原内容，新建→删除）+ 原位截断对话历史（同一 session id，模型不再看到被截断的内容）。

## 功能特性

| 能力 | 说明 |
| --- | --- |
| 按轮次检查点 | 每轮发起前建立检查点，只记录该轮实际触碰的文件（Copy-before-Write 前置内容），非全量快照 |
| 10 轮滑动窗口 | 借鉴 TRAE「仅最近 10 轮」，超出窗口的检查点被丢弃 |
| 文件回退 | 修改过的文件写回本轮前内容；本轮新建的文件被删除；无法恢复的文件单独报告跳过 |
| 原位截断 | 用 `user/message` 表层 `replace`（compaction 同款机制）截断模型上下文，保持同一 session id |
| 三种触发入口 | 模型工具 `rollback`、人工命令 `/rollback`、Web 端每轮「回退」按钮 |
| 受影响文件列表 | Web 按钮弹出对话框，列出本轮及之后受影响文件及动作（恢复/删除/跳过），点击文件可在编辑器打开 |

## 快速上手

### 安装

```sh
dsh plugin --profile web add @domitor-syh/dsh-rollback
```

然后重启 `dsh web`。从源码运行 DSH 时：

```sh
pnpm dsh plugin --profile web add @domitor-syh/dsh-rollback
```

### 使用

1. **Web 按钮**：每条消息气泡右下角「复制」按钮旁出现 ↩「回退」按钮（转弯回复箭头图标，与复制按钮同尺寸）→ 弹出受影响文件列表 → 确认回退。
2. **人工命令**：输入框键入
   - `/rollback list` — 列出可回退到的轮次
   - `/rollback preview <n>` — 预览回退到第 n 轮前会影响的文件（不执行）
   - `/rollback <n>` — 回退到第 n 轮发起之前
3. **模型工具**：AI 可自主调用 `rollback`（传 `turn` + 可选 `preview: true`）。

## 界面预览

1. **回退按钮**：每条消息右下角、与「复制」同尺寸的 ↩ 按钮。

   ![回退按钮](./docs/images/rollback-button.png)

2. **回退弹窗与文件修改提示**：点击 ↩ 后弹出确认框，逐条列出受影响文件及其动作——修改过的写回原内容、新建的删除（无法恢复的单独标「跳过」）。

   ![回退弹窗与文件修改提示](./docs/images/rollback-dialog.png)

3. **回退分隔线与消息返回输入框**：确认后，被回退的消息从对话流中隐藏并渲染一条 ↩ 分隔线；被回退那一轮的用户文本 / 图片自动回到输入框，方便接着改。

   ![回退分隔线与消息返回输入框](./docs/images/rollback-divider-and-composer.png)

4. **回退首条消息的界面**：回退到第一条消息之前时，对话区显示「已回退到对话发起前」欢迎页。

   ![回退首条消息的界面](./docs/images/rollback-hero.png)

## 架构

| 文件 | 职责 |
| --- | --- |
| `src/core/` | 纯逻辑（无 DSH 依赖）：检查点模型、捕获合并、回退规划、滑动窗口、会话折叠，全部单测覆盖 |
| `src/service.ts` | Host 侧执行：`tools/result` 捕获写/改的前置内容 + `session/event` 折叠轮次；执行恢复/删除/截断 |
| `src/index.ts` | 插件体（Host 半侧）：注册 `rollback` 工具与 `/rollback` 命令 |
| `src/client/index.ts` | 浏览器半侧：轮次脚注「回退」按钮 + 受影响文件对话框，经已出厂 `commands` Remote 触发宿主 |

关键实现点：

- **前置内容捕获**：`write`/`edit` 工具的执行结果里已带 `before`/`after`，通过 `ctx.on('tools/result')` 取到完整前置内容（会话日志里只有 3 行上下文 diff，不足以还原文件——所以必须用 live 结果）。
- **原位截断**：对当前 `session.surface.nodes` 中「第 n 轮及之后」的连续节点，append 一个**空内容 `assistant/message`** 表层 `replace`（`surfaceOp: { op:'replace', start, end }` + `sourceEventSeqs` 覆盖所有被遮蔽节点）。空 assistant 派生为 null——模型下一次请求**完全不含**被回退内容，也不带任何标记；会话 id 不变。
- **客户端传输**：不引入自定义 Typert 构建，复用已出厂 `ctx.remote.commands.execute` 调 `/rollback …`。

## 已知限制（Known Limitations）

- **聊天记录仍显示已回退消息**：DSH 的人类聊天记录按 append-origin 事件渲染（与内置 compaction 的行为一致），表层 `replace` 只截断**模型上下文**。插件在 UI 层把被回退区间的消息直接隐藏（持久标记驱动，刷新/重启后保持），并渲染一条「↩ 已回退到本轮发起前」分隔线。
- **检查点为进程内存态**：随会话对象存于 in-memory（`WeakMap`），重启后丢失；重启后本轮内新触碰的文件可被重新捕获，但历史检查点不复原。
- **新建文件删除走本地文件系统**：文件系统抽象层没有删除原语，删除通过 `processPath` + Node `unlink` 完成，仅对本地后端可靠。
- **回退不可撤销**：执行即截断，与 TRAE 语义一致，不做 redo 链；对话框的受影响文件预览是该风险的补偿交互。
- **命令副作用不在回退范围**：`npm install`、写数据库、发请求等外部副作用无法回退（所有 checkpoint 方案的天然边界）。

## 开发

```sh
pnpm install    # 安装依赖（prepare 会先构建一次）
pnpm build      # 从 src/ 产出 lib/index.js、lib/invariant.js、lib/client.js
pnpm test       # 运行核心逻辑（src/core/）单测
pnpm typecheck  # 类型检查无 DSH 依赖的 core 与 tests
```

## 许可证

[MIT](./LICENSE)