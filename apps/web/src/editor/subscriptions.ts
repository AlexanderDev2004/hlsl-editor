// Global keyboard shortcuts. The binding table is built from the Model's
// keymap so users can rebind commands in Settings. Typing inside inputs is
// suppressed by default so Delete/undo never fire while editing a number.
// While a shortcut is being recorded, every other binding is disabled and a
// dedicated listener captures the next key press.

import { Effect, Option, Schema, Stream } from 'effect'
import { Subscription } from 'foldkit'

import { Message } from './message'
import type { Model } from './model'
import { SHORTCUT_COMMANDS, bindingFor } from './shortcuts'

const SHORTCUT_MESSAGES: Record<string, () => Message> = {
  delete: () => Message.PressedDelete(),
  deleteAlt: () => Message.PressedDelete(),
  copy: () => Message.PressedCopy(),
  paste: () => Message.PressedPaste(),
  group: () => Message.PressedGroupSelection(),
  ungroup: () => Message.PressedUngroupSelection(),
  undo: () => Message.PressedUndo(),
  redo: () => Message.PressedRedo(),
  redoAlt: () => Message.PressedRedo(),
  settings: () => Message.PressedSettings(),
}

// Foldkit resolves `Mod` to Meta on Apple platforms and Control elsewhere;
// recording mirrors that choice so a binding stays portable.
function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
}

export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  keys: entry(
    {
      keymap: Schema.Record(Schema.String, Schema.String),
      isRecording: Schema.Boolean,
      isSettingsOpen: Schema.Boolean,
    },
    {
      modelToDependencies: model => ({
        keymap: model.keymap,
        isRecording: Option.isSome(model.recordingAction),
        isSettingsOpen: model.settingsOpen,
      }),
      dependenciesToStream: ({ keymap, isRecording, isSettingsOpen }) => {
        const shortcutBindings = SHORTCUT_COMMANDS.flatMap(command => {
          const binding = bindingFor(keymap, command)
          const mapEvent = SHORTCUT_MESSAGES[command.id]
          if (binding === '' || mapEvent === undefined) {
            return []
          }
          const isEnabled =
            command.id === 'settings'
              ? !isRecording
              : !isRecording && !isSettingsOpen
          return [{ keys: binding, isEnabled, mapEvent }]
        })
        const bindings: ReadonlyArray<Subscription.KeyBinding<Message>> = [
          ...shortcutBindings,
          {
            keys: 'Escape',
            isEnabled: !isRecording,
            mapEvent: () => Message.PressedEscape(),
          },
        ]
        return Stream.merge(
          Subscription.keyBindings<Message>({ bindings }),
          Stream.when(
            Subscription.fromEventFilterMapPreventDefault({
              target: window,
              type: 'keydown',
              filterMapEvent: (event): Option.Option<Message> => {
                if (
                  event.key === 'Escape' &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.altKey &&
                  !event.shiftKey
                ) {
                  return Option.some(Message.CancelledShortcutRecording())
                }
                return Option.some(
                  Message.CapturedShortcut({
                    key: event.key,
                    ctrlKey: event.ctrlKey,
                    metaKey: event.metaKey,
                    altKey: event.altKey,
                    shiftKey: event.shiftKey,
                    isApple: isApplePlatform(),
                  }),
                )
              },
            }),
            Effect.sync(() => isRecording),
          ),
        )
      },
    },
  ),
}))
