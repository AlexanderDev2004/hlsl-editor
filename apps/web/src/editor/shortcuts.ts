// Pure shortcut catalog: the commands the editor exposes, their default
// bindings, platform-aware display formatting, and the translation between a
// raw keyboard event and a Foldkit binding string. No Foldkit imports.

import { Option, Predicate } from 'effect'

export type ShortcutPlatform = 'windows' | 'macos'

export const SHORTCUT_PLATFORMS: ReadonlyArray<ShortcutPlatform> = [
  'windows',
  'macos',
]

export interface ShortcutCommand {
  readonly id: string
  readonly label: string
  readonly category: string
  readonly defaultBinding: string
}

// The command catalog. One binding per command; a command may be unbound by
// clearing its binding. Aliases (Backspace, Mod+Y) are separate commands so
// rebinding one never silently drops the other.
export const SHORTCUT_COMMANDS: ReadonlyArray<ShortcutCommand> = [
  {
    id: 'delete',
    label: 'Delete selection',
    category: 'Editing',
    defaultBinding: 'Delete',
  },
  {
    id: 'deleteAlt',
    label: 'Delete selection (Backspace)',
    category: 'Editing',
    defaultBinding: 'Backspace',
  },
  {
    id: 'copy',
    label: 'Copy selection',
    category: 'Editing',
    defaultBinding: 'Mod+C',
  },
  {
    id: 'paste',
    label: 'Paste',
    category: 'Editing',
    defaultBinding: 'Mod+V',
  },
  {
    id: 'group',
    label: 'Group selection',
    category: 'Grouping',
    defaultBinding: 'Mod+G',
  },
  {
    id: 'ungroup',
    label: 'Ungroup selection',
    category: 'Grouping',
    defaultBinding: 'Mod+Shift+G',
  },
  {
    id: 'undo',
    label: 'Undo',
    category: 'History',
    defaultBinding: 'Mod+Z',
  },
  {
    id: 'redo',
    label: 'Redo',
    category: 'History',
    defaultBinding: 'Mod+Shift+Z',
  },
  {
    id: 'redoAlt',
    label: 'Redo (alternate)',
    category: 'History',
    defaultBinding: 'Mod+Y',
  },
  {
    id: 'settings',
    label: 'Open settings',
    category: 'View',
    defaultBinding: 'Mod+,',
  },
]

export const SHORTCUT_CATEGORIES: ReadonlyArray<string> =
  SHORTCUT_COMMANDS.reduce<ReadonlyArray<string>>(
    (categories, command) =>
      categories.includes(command.category)
        ? categories
        : [...categories, command.category],
    [],
  )

export const DEFAULT_KEYMAP: Record<string, string> = Object.fromEntries(
  SHORTCUT_COMMANDS.map(command => [command.id, command.defaultBinding]),
)

export function commandById(id: string): ShortcutCommand | undefined {
  return SHORTCUT_COMMANDS.find(command => command.id === id)
}

export function bindingFor(
  keymap: Record<string, string>,
  command: ShortcutCommand,
): string {
  return keymap[command.id] ?? command.defaultBinding
}

// The command whose binding already owns `binding`, ignoring `exceptId`.
// Comparison is canonical so `Mod+c` and `Mod+C` collide as they should.
export function bindingOwner(
  keymap: Record<string, string>,
  binding: string,
  exceptId: string,
): string | null {
  const target = canonicalBinding(binding)
  const entry = Object.entries(keymap).find(
    ([id, value]) => id !== exceptId && canonicalBinding(value) === target,
  )
  return entry === undefined ? null : entry[0]
}

// Foldkit matches key tokens case-insensitively, so two bindings that differ
// only in the case of their key token are the same shortcut. Canonicalising
// makes conflict detection agree with matching.
export function canonicalBinding(binding: string): string {
  return binding
    .split('+')
    .map(token => (BINDING_MODIFIERS.has(token) ? token : token.toLowerCase()))
    .join('+')
}

export function bindingsEqual(left: string, right: string): boolean {
  return canonicalBinding(left) === canonicalBinding(right)
}

// DISPLAY

const BINDING_MODIFIERS: ReadonlySet<string> = new Set([
  'Mod',
  'Control',
  'Meta',
  'Alt',
  'Shift',
])

const MAC_MODIFIER_SYMBOLS: Record<string, string> = {
  Mod: '⌘',
  Meta: '⌘',
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧',
}

const WINDOWS_MODIFIER_LABELS: Record<string, string> = {
  Mod: 'Ctrl',
  Meta: 'Win',
  Control: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
}

const MAC_MODIFIER_RANK: Record<string, number> = {
  Control: 0,
  Alt: 1,
  Shift: 2,
  Mod: 3,
  Meta: 3,
}

const WINDOWS_MODIFIER_RANK: Record<string, number> = {
  Mod: 0,
  Meta: 1,
  Control: 2,
  Alt: 3,
  Shift: 4,
}

const KEY_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Escape: 'Esc',
  Space: 'Space',
  Plus: 'Plus',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Del',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
}

function labelForKey(key: string): string {
  const known = KEY_LABELS[key]
  if (known !== undefined) {
    return known
  }
  if (key.length === 1) {
    return key.toUpperCase()
  }
  return key
}

// Renders a Foldkit binding string for a display platform: `⌘⇧G` on macOS,
// `Ctrl+Shift+G` on Windows. `Mod` resolves to the platform's primary
// modifier; the stored binding stays platform-neutral.
export function formatShortcut(
  binding: string,
  platform: ShortcutPlatform,
): string {
  if (binding === '') {
    return 'Unbound'
  }
  const tokens = binding.split('+')
  const modifiers = tokens.filter(token => BINDING_MODIFIERS.has(token))
  const keys = tokens.filter(token => !BINDING_MODIFIERS.has(token))
  const keyLabel = keys.length > 0 ? labelForKey(keys.join('+')) : ''
  const rank = platform === 'macos' ? MAC_MODIFIER_RANK : WINDOWS_MODIFIER_RANK
  const ordered = [...modifiers].sort(
    (left, right) => (rank[left] ?? 99) - (rank[right] ?? 99),
  )
  const labels = ordered.map(token =>
    platform === 'macos'
      ? (MAC_MODIFIER_SYMBOLS[token] ?? token)
      : (WINDOWS_MODIFIER_LABELS[token] ?? token),
  )
  return platform === 'macos'
    ? [...labels, keyLabel].join('')
    : [...labels, keyLabel].join('+')
}

// RECORDING

const IGNORED_KEYS: ReadonlySet<string> = new Set([
  'alt',
  'altgraph',
  'capslock',
  'control',
  'fn',
  'fnlock',
  'hyper',
  'meta',
  'numlock',
  'os',
  'scrolllock',
  'shift',
  'super',
  'symbol',
  'symbollock',
  'dead',
  'unidentified',
  'process',
])

export interface RecordedKeyEvent {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

function keyToken(key: string): string {
  if (key === ' ') {
    return 'Space'
  }
  if (key === '+') {
    return 'Plus'
  }
  return key
}

// Turns a keyboard event into a Foldkit binding string. The platform's
// primary modifier (Meta on Apple, Control elsewhere) is stored as `Mod`, so
// the binding keeps working on the other platform. Returns None for a
// modifier-only or unidentified key, which leaves recording active.
export function bindingFromKeyEvent(
  event: RecordedKeyEvent,
  isApple: boolean,
): Option.Option<string> {
  if (event.key === '' || IGNORED_KEYS.has(event.key.toLowerCase())) {
    return Option.none()
  }
  const tokens: Array<string> = []
  if (isApple ? event.metaKey : event.ctrlKey) {
    tokens.push('Mod')
  }
  if (isApple ? event.ctrlKey : event.metaKey) {
    tokens.push(isApple ? 'Control' : 'Meta')
  }
  if (event.altKey) {
    tokens.push('Alt')
  }
  if (event.shiftKey) {
    tokens.push('Shift')
  }
  tokens.push(keyToken(event.key))
  return Option.some(tokens.join('+'))
}

// A binding string the keyBindings grammar accepts: an optional set of known
// modifiers followed by exactly one key. The empty string means unbound.
export function isValidBinding(binding: string): boolean {
  if (binding === '') {
    return true
  }
  const tokens = binding.split('+')
  if (tokens.some(token => token === '')) {
    return false
  }
  const keys = tokens.filter(token => !BINDING_MODIFIERS.has(token))
  return keys.length === 1
}

// PERSISTENCE

export interface ShortcutSettings {
  readonly platform: ShortcutPlatform
  readonly keymap: Record<string, string>
}

export function isShortcutPlatform(value: unknown): value is ShortcutPlatform {
  return value === 'windows' || value === 'macos'
}

export function serializeShortcutSettings(settings: ShortcutSettings): string {
  return JSON.stringify({
    version: 1,
    platform: settings.platform,
    keymap: settings.keymap,
  })
}

// Rebuilds a keymap from stored data, falling back to defaults for missing or
// unusable entries. Guarantees unique bindings so the keyBindings stream never
// rejects the table; a duplicate becomes unbound rather than crashing.
export function parseShortcutSettings(raw: unknown): ShortcutSettings | null {
  if (!Predicate.isObject(raw)) {
    return null
  }
  if (!('platform' in raw) || !('keymap' in raw)) {
    return null
  }
  if (!isShortcutPlatform(raw.platform)) {
    return null
  }
  if (!Predicate.isObject(raw.keymap)) {
    return null
  }
  const stored = new Map(
    Object.entries(raw.keymap).filter((entry): entry is [string, string] =>
      Predicate.isString(entry[1]),
    ),
  )
  const keymap = SHORTCUT_COMMANDS.reduce<Record<string, string>>(
    (acc, command) => {
      const candidate = stored.get(command.id) ?? command.defaultBinding
      const alreadyUsed = Object.values(acc).some(existing =>
        bindingsEqual(existing, candidate),
      )
      const usable =
        candidate !== '' && isValidBinding(candidate) && !alreadyUsed
      return { ...acc, [command.id]: usable ? candidate : '' }
    },
    {},
  )
  return { platform: raw.platform, keymap }
}
