<div align="center">

# dsh-rollback · TRAE 式「回退」插件

<img src="./docs/page-display.jpeg" alt="dsh-rollback 界面预览" width="100%">

中文 · [English](./README.en.md)

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com) [![listed plugins](https://img.shields.io/endpoint?url=https://awesome-dsh-plugin.com/count.json)](https://awesome-dsh-plugin.com) [![npm](https://img.shields.io/npm/v/@domitor-syh/dsh-rollback)](https://www.npmjs.com/package/@domitor-syh/dsh-rollback) [![downloads](https://img.shields.io/npm/dt/@domitor-syh/dsh-rollback)](https://www.npmjs.com/package/@domitor-syh/dsh-rollback) [![MIT License](https://img.shields.io/badge/license-MIT-green)](./LICENSE) [![CI](https://img.shields.io/github/actions/workflow/status/domitor-syh/dsh-rollback/test.yml?branch=main)](https://github.com/domitor-syh/dsh-rollback/actions/workflows/test.yml)

</div>

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web 端提供按轮次回退：恢复已跟踪的文件变更，同时撤回对应的模型可见对话，继续使用原会话。

## 功能

- **按轮次回退**：选择最近保留的 10 轮检查点，通过按钮或 `/rollback` 发起。
- **文件与对话同步恢复**：恢复旧内容、找回删除的文件、撤销新建；首尾状态相同的文件不做操作。
- **确认后执行**：弹窗展示受影响文件及外部修改警告。
- **草稿回填**：通过确认弹窗回退后，尝试将原消息和可恢复附件放回输入框。
- **恢复进度保留**：失败后可重试或尝试补偿文件操作。

## 安装

**Web 端**（`dsh web`）：

```sh
dsh plugin --profile web add @domitor-syh/dsh-rollback
```

**桌面端**（官方渠道）——在插件的安装处填入包名 **`@domitor-syh/dsh-rollback`**，或使用等价命令：

```sh
dsh plugin --profile desktop add @domitor-syh/dsh-rollback
```

安装后：Web 端重启 `dsh web` 并刷新页面；桌面端重启桌面应用。从 DSH 源码运行时，在上述命令前加 `pnpm`。

当前适配目标为 **DSH 0.2.0-rc.2**。声明的兼容范围为 `>=0.1.5-rc.2 <0.2.0-0 || >=0.2.0-rc.2 <0.3.0-0`，其他构建需确认兼容性。

## 使用

提供三种使用方式：

1. **回退按钮**：点击已结束轮次中的「回退」按钮 → 查看受影响文件 → 确认回退。
2. **`/rollback`**：输入不带参数的 `/rollback` → 打开轮次选择弹窗 → 选择目标轮次 → 查看受影响文件并确认回退。
3. **`/rollback` + Space（空格）**：手动输入 `/rollback` 后按空格 → 打开子命令菜单 → 选择命令或参数 → 按回车执行。选择菜单项只补全参数，不立即执行；`preview` 会打开轮次子菜单，按 Esc 可返回。

| 命令 | 用途 |
| --- | --- |
| `/rollback` | 选择轮次并打开确认弹窗 |
| `/rollback latest` | 直接回退最近的检查点 |
| `/rollback <n>` | 直接回退到第 n 轮之前 |
| `/rollback list` | 查看可回退轮次 |
| `/rollback preview <n>` | 预览受影响文件 |
| `/rollback retry` | 继续未完成的恢复 |
| `/rollback abort` | 对话尚未提交撤回时，尝试补偿文件操作 |
| `/rollback rescues` | 查看文件救援点，不自动恢复 |
| `/rollback state` | 查看当前回退状态 |
| `/rollback diagnose` | 查看诊断信息 |

**`latest` 和数字命令直接执行，不显示确认弹窗。** 如需先检查，请使用界面入口或 `preview`。

运行中不能回退。回退只处理具备恢复依据的已跟踪文件，不是整个工作区备份；外部修改警告提示相关内容可能被覆盖。恢复失败后先按提示使用 `retry` 或 `abort`，报错不代表文件操作已自动撤销；对话撤回提交后不能再 `abort`。回退不会删除原始会话日志。

## 开发

构建工具链要求 Node `^22.18.0 || >=24.11.0`。

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm check:readmes
pnpm build
```

修改后需将构建产物安装到目标 profile，再重启 DSH 并刷新页面。版本变更见 [更新日志](./CHANGELOG.md)。

## 许可证

[MIT](./LICENSE)
