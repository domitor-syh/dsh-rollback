> 🌐 语言 / Language: [中文](./README.md) · **English**

# dsh-rollback · TRAE-style rollback plugin

A TRAE-style "roll back to before this turn" plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web client: it captures per-turn checkpoints and, with one click, rolls back **both workspace files and model context** to before a given turn while keeping the same session id.

## What it is

`dsh-rollback` faithfully implements the core idea behind TRAE's rollback — **rolling back conversation state and file state in lockstep**:

- Model behavior is driven by both the conversation history and the workspace files, so a rollback must roll back **both** at once; otherwise you get hallucination continuation or state conflicts.
- Rollback = restore the files touched in this turn and later (modified → write back the prior content, created → delete) + truncate the conversation history in place (same session id, so the model no longer sees the truncated content).

## Features

| Capability | Description |
| --- | --- |
| Per-turn checkpoints | A checkpoint is captured before each turn, recording only the files actually touched (Copy-before-Write prior content), not a full snapshot |
| 10-turn sliding window | Mirrors TRAE's "last 10 turns only"; checkpoints beyond the window are dropped |
| File rollback | Modified files are written back to their pre-turn content; files created this turn are deleted; unrestorable files are reported as skipped |
| In-place truncation | Truncates the model context via a `user/message` surface `replace` (the same mechanism compaction uses), keeping the same session id |
| Three entry points | The `rollback` model tool, the `/rollback` human command, and a per-turn Web rollback button |
| Affected-file list | The Web button opens a dialog listing the files affected by this and later turns and their actions (restore/delete/skip); clicking a file opens it in the editor |

## Getting started

### Install

```sh
dsh plugin --profile web add @domitor-syh/dsh-rollback
```

Then restart `dsh web`. When running DSH from source:

```sh
pnpm dsh plugin --profile web add @domitor-syh/dsh-rollback
```

### Usage

1. **Web button**: a ↩ rollback button (reply-arrow icon, same size as the Copy button) appears next to the Copy button in the corner of each message bubble → opens the affected-files list → confirm to roll back.
2. **Human command**: type in the composer:
   - `/rollback list` — list the turns you can roll back to
   - `/rollback preview <n>` — preview the files affected when rolling back to before turn n (no execution)
   - `/rollback <n>` — roll back to before turn n
3. **Model tool**: the AI can invoke `rollback` on its own (pass `turn` plus optional `preview: true`).

## Interface preview

1. **Rollback button**: a ↩ button, the same size as Copy, in the corner of each message.

   ![Rollback button](./docs/images/rollback-button.png)

2. **Rollback dialog & file-change notice**: clicking ↩ opens a confirmation dialog listing each affected file and its action — modified files are written back, created files are deleted (unrestorable ones are flagged "skip").

   ![Rollback dialog & file-change notice](./docs/images/rollback-dialog.png)

3. **Rollback divider & message returned to the composer**: after confirming, the rolled-back messages are hidden from the flow and a ↩ divider is rendered; the rolled-back turn's text/images return to the composer for further editing.

   ![Rollback divider & message returned to the composer](./docs/images/rollback-divider-and-composer.png)

4. **Rolling back the first message**: when rolling back to before the first message, the chat shows a "rolled back to the start of the conversation" welcome page.

   ![Rolling back the first message](./docs/images/rollback-hero.png)

## Architecture

| File | Responsibility |
| --- | --- |
| `src/core/` | Pure logic (no DSH dependencies): checkpoint model, capture/merge, rollback planning, sliding window, session folding — all unit-test-covered |
| `src/service.ts` | Host-side execution: captures pre-write content via `tools/result` + folds turns via `session/event`; performs restore/delete/truncate |
| `src/index.ts` | Plugin body (host half): registers the `rollback` tool and the `/rollback` command |
| `src/client/index.ts` | Browser half: the per-turn rollback button + affected-files dialog, reaching the host through the shipped `commands` Remote |

Key implementation points:

- **Pre-content capture**: `write`/`edit` tool results already carry `before`/`after`; the full prior content is taken through `ctx.on('tools/result')` (the session log only keeps 3-line context diffs, which can't reconstruct a file — so the live result is required).
- **In-place truncation**: for the consecutive nodes in `session.surface.nodes` from turn n onward, it appends an **empty-content `assistant/message`** surface `replace` (`surfaceOp: { op:'replace', start, end }` + `sourceEventSeqs` covering every shadowed node). The empty assistant derives to null — the model's next request contains **none** of the rolled-back content and carries no marker; the session id is unchanged.
- **Client transport**: no custom Typert build is introduced; it reuses the shipped `ctx.remote.commands.execute` to call `/rollback …`.

## Known limitations

- **The human chat log still shows rolled-back messages**: DSH's human chat log renders by append-origin events (the same as built-in compaction); a surface `replace` only truncates the **model context**. The plugin hides the rolled-back range at the UI layer (persistent marker driven, survives refresh/restart) and renders a "↩ rolled back to before this turn" divider.
- **Checkpoints are process-in-memory**: they live with the session object in memory (`WeakMap`) and are lost on restart; after a restart, files touched within the current turn can be re-captured, but historical checkpoints are not restored.
- **Created-file deletion goes through the local filesystem**: the filesystem abstraction has no delete primitive; deletion uses `processPath` + Node `unlink`, which is only reliable for the local backend.
- **Rollback is irreversible**: executing truncates, consistent with TRAE semantics, with no redo chain; the affected-files preview in the dialog compensates for this risk.
- **Command side effects are out of scope**: `npm install`, database writes, network requests, and other external side effects cannot be rolled back (the inherent boundary of every checkpoint approach).

## Development

```sh
pnpm install    # install deps (prepare also builds once)
pnpm build      # emit lib/index.js, lib/invariant.js, lib/client.js from src/
pnpm test       # run the dependency-free core unit tests
pnpm typecheck  # type-check core and tests
```

## License

[MIT](./LICENSE)