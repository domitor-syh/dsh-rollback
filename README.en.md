<div align="center">

# dsh-rollback · TRAE-style rollback plugin

<img src="./docs/page-display.jpeg" alt="dsh-rollback interface" width="100%">

[中文](./README.md) · English

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com) [![listed plugins](https://img.shields.io/endpoint?url=https://awesome-dsh-plugin.com/count.json)](https://awesome-dsh-plugin.com) [![npm](https://img.shields.io/npm/v/@domitor-syh/dsh-rollback)](https://www.npmjs.com/package/@domitor-syh/dsh-rollback) [![downloads](https://img.shields.io/npm/dt/@domitor-syh/dsh-rollback)](https://www.npmjs.com/package/@domitor-syh/dsh-rollback) [![MIT License](https://img.shields.io/badge/license-MIT-green)](./LICENSE) [![CI](https://img.shields.io/github/actions/workflow/status/domitor-syh/dsh-rollback/test.yml?branch=main)](https://github.com/domitor-syh/dsh-rollback/actions/workflows/test.yml)

</div>

Turn-based rollback for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web client: restore tracked file changes and withdraw the corresponding model-visible conversation while keeping the same session.

## Features

- **Turn-based rollback**: choose from the latest 10 retained checkpoints using a button or `/rollback`.
- **Files and conversation together**: restore previous content, recover deleted files and undo file creation; files with equal initial and final states are left untouched.
- **Confirm before execution**: review affected files and external-change warnings in the dialog.
- **Draft restoration**: the confirmation flow attempts to put the original message and recoverable attachments back into the composer.
- **Recovery progress retained**: retry after failure or attempt compensation of file operations.

## Install

**Web** (`dsh web`):

```sh
dsh plugin --profile web add @domitor-syh/dsh-rollback
```

**Desktop** (the official channel) — enter the package name **`@domitor-syh/dsh-rollback`** where plugins are installed, or use the equivalent command:

```sh
dsh plugin --profile desktop add @domitor-syh/dsh-rollback
```

After installing: restart `dsh web` and refresh the page on the web side, restart the desktop app on the desktop side. When running DSH from source, prefix the commands with `pnpm`.

The current target is **DSH 0.2.1-rc.2**. The declared compatibility range remains `>=0.1.5-rc.2 <0.2.0-0 || >=0.2.0-rc.2 <0.3.0-0`; older versions have not been revalidated for this adaptation.

0.5.1 fixes relative file paths capturing a same-named file in the original directory after the session working directory changes. Rollback continues to use the target path recorded when the file was changed.

## Usage

There are three ways to use the plugin:

1. **Rollback button**: click **Rollback** on an ended turn → review affected files → confirm rollback.
2. **`/rollback`**: enter `/rollback` without arguments → open the turn picker → choose a target turn → review affected files and confirm rollback.
3. **`/rollback` + Space**: type `/rollback` and press Space → open the subcommand menu → select a command or arguments → press Enter to execute. Selecting a menu item only completes arguments; it does not execute immediately. `preview` opens a turn submenu; press Esc to return.

| Command | Purpose |
| --- | --- |
| `/rollback` | Choose a turn and open the confirmation dialog |
| `/rollback latest` | Directly roll back the latest checkpoint |
| `/rollback <n>` | Directly roll back to before turn n |
| `/rollback list` | List available turns |
| `/rollback preview <n>` | Preview affected files |
| `/rollback retry` | Continue an unfinished recovery |
| `/rollback abort` | Attempt file compensation before conversation withdrawal is committed |
| `/rollback rescues` | List file rescue points without restoring them |
| `/rollback state` | Show the current rollback state |
| `/rollback diagnose` | Show diagnostics |

**`latest` and numeric commands execute directly without a confirmation dialog.** Use the interface or `preview` to inspect changes first.

Rollback is unavailable while a turn is running. It covers tracked files with restore evidence, not a full workspace backup; external-change warnings mean that related content may be overwritten. After recovery fails, follow the instructions for `retry` or `abort`: an error does not mean file operations were automatically undone. Abort is unavailable once conversation withdrawal is committed. Rollback does not erase original session logs.

When a tool reports a file path different from the captured target, that operation leaves a persistent recovery gap. For example, a gap in turn 5 still allows rollback from normally retained checkpoints at turn 6 or later; rollback starting at turn 5 or earlier is rejected in both preview and execution, with the gap and later available start turns shown. The restriction survives restart; rollback cannot skip the gap, restore only part of the range, or withdraw only the conversation. Failure to write or read recovery records can still block a wider range of rollbacks.

## Development

The build toolchain requires Node `^22.18.0 || >=24.11.0`.

```sh
pnpm --config.verify-deps-before-run=false install --ignore-scripts
pnpm --config.verify-deps-before-run=false typecheck
pnpm --config.verify-deps-before-run=false test
pnpm --config.verify-deps-before-run=false check:readmes
pnpm --config.verify-deps-before-run=false build
```

DSH 0.2.1 retired the invariant service, so the plugin no longer depends on `@deepseek-ai/dsh-invariants`. The public `./invariant` entry remains as a deprecated no-op; existing configurations can still load it or remove the entry. The host version range is declared through top-level `engines.dsh`; older hosts without `workingDirectory` retain the original directory fallback.

Install the build artifacts into the target profile, then restart DSH and refresh the page. See the [changelog](./CHANGELOG.md) for version history.

## License

[MIT](./LICENSE)
