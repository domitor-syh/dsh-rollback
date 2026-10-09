import * as React from 'react'
import { turnsOf } from '../core/rollback-guard.ts'
import { isBareClaimedRollback, rollbackCompletion, ROLLBACK_SUBCOMMANDS, type ClaimedInput, type RollbackSubcommand } from './command-completion.ts'

interface Props {
  sessionId: string
  useInput: <T>(selector: (input: ClaimedInput) => T) => T
  inputActions: { insertText(text: string, span: { start: number; end: number; draftRev: number }): boolean }
  list(): Promise<string>
  t(key: string): string
}

export function RollbackCommandMenu(props: Props): React.ReactElement | null {
  const input = props.useInput(state => state)
  const bare = isBareClaimedRollback(input)
  const argument = input.draft.slice('/rollback'.length).trimStart()
  const filter = argument.split(/\s+/)[0]?.toLowerCase() ?? ''
  const [open, setOpen] = React.useState(false)
  const [preview, setPreview] = React.useState(false)
  const [turns, setTurns] = React.useState<number[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [selected, setSelected] = React.useState(0)
  const [turnIndex, setTurnIndex] = React.useState(0)
  const previous = React.useRef(false)
  const root = React.useRef<HTMLDivElement>(null)
  const current = React.useRef(input)
  current.current = input
  const matches = ROLLBACK_SUBCOMMANDS.filter(command => !filter || command.startsWith(filter))
  React.useEffect(() => {
    previous.current = false
    setOpen(false); setPreview(false); setError('')
  }, [props.sessionId])
  React.useEffect(() => {
    if (bare && !previous.current) { setOpen(true); setPreview(false); setSelected(0); setError('') }
    if (!bare) { setOpen(false); setPreview(false) }
    previous.current = bare
  }, [bare, props.sessionId])
  React.useEffect(() => {
    if (open && !preview && matches.length === 0) setOpen(false)
    if (selected >= matches.length) setSelected(0)
  }, [open, preview, matches.length, selected])
  React.useEffect(() => {
    if (!open || !preview) return
    let valid = true
    setLoading(true); setError(''); setTurns([])
    props.list().then(text => { if (valid) { setTurns((turnsOf(text) ?? []).slice().reverse()); setTurnIndex(0) } })
      .catch(() => { if (valid) setError(props.t('picker.loadError')) })
      .finally(() => { if (valid) setLoading(false) })
    return () => { valid = false }
  }, [open, preview, props.sessionId])
  const choose = (command: RollbackSubcommand, turn?: number) => {
    if (command === 'preview' && turn === undefined) { setPreview(true); return }
    const completion = rollbackCompletion(current.current, command, turn)
    if (completion === null || !props.inputActions.insertText(completion.text, completion.span)) { setError(props.t('picker.changed')); return }
    setOpen(false); setPreview(false)
  }
  React.useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return
      if (!['Escape', 'ArrowUp', 'ArrowDown', 'Enter', 'Tab'].includes(event.key)) return
      const host = root.current?.closest('[data-composer-card]') ?? root.current
      if (!host?.contains(event.target as Node)) return
      event.preventDefault(); event.stopImmediatePropagation()
      if (event.key === 'Escape') { if (preview) setPreview(false); else setOpen(false); return }
      if (event.key === 'Tab') { setOpen(false); return }
      const count = preview ? turns.length : matches.length
      if (!count) return
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const delta = event.key === 'ArrowUp' ? -1 : 1
        if (preview) setTurnIndex(i => (i + delta + count) % count)
        else setSelected(i => (i + delta + count) % count)
      } else if (preview) choose('preview', turns[turnIndex])
      else choose(matches[selected]!)
    }
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', outside, true)
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', outside, true) }
  }, [open, preview, turns, matches, selected, turnIndex])
  if (!open || !bare) return null
  const row = (label: string, detail: string, active: boolean, click: () => void) => React.createElement('button', {
    key: label, type: 'button', className: 'rbk-completion-row', 'aria-selected': active,
    onPointerDown: (e: React.PointerEvent) => e.preventDefault(), onClick: click,
  }, React.createElement('strong', null, label), React.createElement('small', null, detail))
  return React.createElement('div', { ref: root, className: 'rbk-completion', role: 'dialog', 'aria-label': props.t('picker.commands') },
    React.createElement('div', { className: 'rbk-completion-heading' }, props.t('picker.enterHint')),
    React.createElement('div', { className: 'rbk-completion-columns' },
      React.createElement('div', { role: 'listbox', 'aria-label': props.t('picker.commands') },
        ...matches.map((command, i) => row(command, props.t(`picker.${command}`), preview ? command === 'preview' : selected === i, () => { setSelected(i); choose(command) }))),
      preview ? React.createElement('div', { role: 'listbox', 'aria-label': props.t('picker.preview') },
        React.createElement('div', { className: 'rbk-completion-heading' }, props.t('picker.previewBack')),
        loading ? props.t('dialog.analyzing') : turns.length ? turns.map((turn, i) => row(`preview ${turn}`, '', i === turnIndex, () => choose('preview', turn))) : props.t('picker.empty')) : null),
    error ? React.createElement('div', { role: 'alert', className: 'rbk-completion-heading' }, error) : null)
}
