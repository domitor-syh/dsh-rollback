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
| 原位截断 | 用 **`user/message` 承载的表层 `replace`**（内置 `/compact` 同款官方原语）就地替换模型上下文，**回退当场即生效**，保持同一 session id |
| 三种触发入口 | 模型工具 `rollback`、人工命令 `/rollback`、Web 端每条已完成回复的「回退」按钮 |
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

1. **Web 按钮**：每条已完成 AI 回复下方、与「赞/踩」并排的动作条里出现 ↩「回退」按钮 → 弹出受影响文件列表 → 确认回退。
2. **人工命令**：输入框键入
   - `/rollback list` — 列出可回退到的轮次
   - `/rollback preview <n>` — 预览回退到第 n 轮前会影响的文件（不执行）
   - `/rollback <n>` — 回退到第 n 轮发起之前
3. **模型工具**：AI 可自主调用 `rollback`（传 `turn` + 可选 `preview: true`）。

## 界面预览

1. **回退按钮**：每条已完成 AI 回复下方动作条里的 ↩ 按钮（与「赞/踩」并排）。

   ![回退按钮](./docs/images/rollback-button.png)

2. **回退弹窗与文件修改提示**：点击 ↩ 后弹出确认框，逐条列出受影响文件及其动作——修改过的写回原内容、新建的删除（无法恢复的单独标「跳过」）。

   ![回退弹窗与文件修改提示](./docs/images/rollback-dialog.png)

3. **被回退的消息从对话流中隐藏**：确认后被回退的消息立刻隐藏（界面上不渲染分隔线）；被回退那一轮的用户文本 / 图片自动回到输入框，方便接着改。

4. **回退首条消息的界面**：回退到第一条消息之前时，对话区显示「已回退到对话发起前」欢迎页。

   ![回退首条消息的界面](./docs/images/rollback-hero.png)

## 架构

| 文件 | 职责 |
| --- | --- |
| `src/core/` | 纯逻辑（无 DSH 依赖）：检查点模型、捕获合并、回退规划、截断规划、滑动窗口、会话折叠，全部单测覆盖 |
| `src/service.ts` | Host 侧执行：`tools/result` 捕获写/改的前置内容 + `session/event` 折叠轮次；执行恢复/删除/截断 |
| `src/index.ts` | 插件体（Host 半侧）：注册 `rollback` 工具与 `/rollback` 命令 |
| `src/client/index.ts` | 浏览器半侧：官方 `assistant-actions` 槽的「回退」按钮 + 受影响文件对话框 + 本地化，经已出厂 `commands` Remote 触发宿主 |

关键实现点：

- **前置内容捕获**：`write`/`edit` 的执行结果里已带 `before`/`after`，用 `ctx.on('tools/result')` 取完整前置内容；`str_replace_editor` 的结果只有渲染文本，改由 `tools/pre-execute` 在调用前预读目标。
- **盘根写入兜底**：Windows 上文件工具无法操作盘符根目录**正下方**的文件——文件系统层写前会先 `mkdir` 父目录，而 `dirname('E:\\file.txt')` 是**带尾分隔符**的 `E:\`，Windows 对卷根 mkdir 返回 EPERM。插件包装 `ctx.fs.writeText` 与 `ctx.fs.editText`：**仅当原路抛出这一精确形状的错误时**，改用「同目录临时文件 + `rename`」落盘（不做 mkdir 预检）。`edit` 分支还逐字复刻了字面匹配语义（`FS_EDIT_NOT_FOUND` / `FS_AMBIGUOUS_EDIT` 的判定与文案）并保留原文件的**行尾风格**与权限位；只包装后端实际实现了的方法。其余错误、以及策略不允许的路径（fail closed）一律按原样抛出。文件系统层若不再预建目录，该分支自动失效。
- **空目录清理**：回退删掉它创建的文件后，把「**已被清空、且创建时间落在被回退时间段内**」的祖先目录一并删除（最深优先；把本次即将删除的子目录视为已不存在，所以整条新目录链会一起清掉）。创建时间用于区分两种情况：目录在第 3 轮创建、文件在第 5 轮创建时——回退到第 5 轮之前**只删文件、保留目录**，回退到第 3 轮之前**两者都删**。创建时间不可得、目录不可读、或仍有内容时一律保留（fail closed）。
- **写入偏好提示**：向模型注入一条常驻运行说明——经 shell 修改的文件无法回退，内容改动请用 `write`/`edit`。
- **原位截断**：对当前 `session.surface.nodes` 中「第 n 轮及之后」的连续节点，append 一条 **`user/message`** 表层 `replace`（`surfaceOp: { op:'replace', start, end }` + `sourceEventSeqs` 覆盖全部被遮蔽节点），就地替换这段历史；会话 id 不变。
  - 标记在 `/rollback` 执行时**当场**写入日志，被回退区间随即从模型历史中消失。
  - 标记内容是一段自动生成的检查点说明，并指示模型不要提及它；再次回退到同一点时，新标记的替换范围覆盖旧标记，只保留一条。
- **界面隐藏**：客户端按标记的替换起点，把被回退区间内的聊天座位隐藏（`display:none`）；隐藏由日志里的持久标记驱动，刷新/重启后保持。
- **欢迎页**：把整段对话回退掉之后，由 driver 往对话区注入宿主元素，再用 React portal 把欢迎页渲染进去。
- **客户端传输**：复用已出厂 `ctx.remote.commands.execute` 调 `/rollback …`。
- **回归测试**：`tests/truncation-plan.test.ts`（10）+ `tests/core.test.ts`（24）+ `tests/root-write.test.ts`（14）+ `tests/root-write-fallback.test.ts`（15）+ `tests/literal-edit.test.ts`（12）+ `tests/dir-cleanup.test.ts`（12）+ `tests/empty-dirs.test.ts`（5）。

## 已知限制（Known Limitations）

- **聊天轨迹仍保留已回退的消息**：DSH 的聊天轨迹按 append-origin 事件渲染，而日志本身 append-only、无法改写；表层 `replace` 只作用于**模型上下文**。插件在界面层把被回退区间隐藏（由日志里的持久标记驱动，刷新/重启后保持）。
- **模型会读到一行检查点文字**：轮次之间写不出"模型不可见"的标记（那需要一个已开启的 step），所以模型会读到那段检查点说明，约 60 token；说明里已明确要求模型把已有内容当作既定背景、继续后面的对话，并**不要在意、不要提及这个检查点**。
- **检查点为进程内存态 + 20 轮 sidecar**：折叠状态随会话对象存于内存（`WeakMap`）；重启后由 sidecar（`storages/dsh-rollback/checkpoints-v2/`）重建，保留最近 20 轮（`KEEP_TURNS`），更早的记录在加载时被剪枝。
- **新建文件删除与空目录清理走本地文件系统**：文件系统抽象层没有删除原语，删除通过 `processPath` + Node `unlink`、空目录清理通过 Node `rmdir` 完成，仅对本地后端可靠。
- **回退不可撤销**：执行即替换历史，不提供 redo 链。
- **经 shell 修改或删除的文件不在回退范围**：插件只从 `write`/`edit` 的结果里捕获文件改动；`pwsh`/`bash` 的副作用（重定向、`sed -i`、`Remove-Item`、`git`、`npm install` 写文件等）无论在工作区内还是外都无法回退。插件会注入提示引导模型改走文件工具，但无法强制。

## 开发

```sh
pnpm install        # 安装依赖（prepare 会先构建一次）
pnpm build          # 从 src/ 产出 lib/index.js、lib/invariant.js、lib/client.js
pnpm test           # 运行核心逻辑（src/core/）单测
pnpm typecheck      # tsc 检查 core + tests；scripts/typecheck-host.mjs 再检查
                    #   src/service.ts、src/index.ts、src/client/index.ts
                    #   （这三个文件 import 的 @deepseek-ai/* 不在本仓库安装，
                    #     故只忽略这些包造成的 TS2307/TS7006/TS7016，
                    #     其余一律视为真错误——含 TS2304「未定义标识符」）
pnpm deploy:profile # 打包并部署到 DSH profile（默认 web），随后需重启 DSH
```

> ⚠️ **改了代码必须 `pnpm deploy:profile`**：DSH 不是从本仓库加载插件，而是从 profile 的
> `node_modules` 加载 `file:` tarball 解出来的副本（见 `scripts/deploy-profile.mjs` 的说明）。
> 只跑 `pnpm build` 改的是本仓库的 `lib/`，**运行时毫无变化**。脚本会打包、更新 profile 引用的
> tarball、覆盖已解出的副本并校验字节一致，最后提醒重启 DSH 与刷新页面——而**重启必须由你手动做**：
> 宿主半侧在启动时载入，脚本无法替正在运行的进程换代码。

## 许可证

[MIT](./LICENSE)