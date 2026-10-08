// Global keyboard shortcuts. Typing inside inputs is suppressed by
// default so Delete/undo never fire while editing a number.

import { Subscription } from 'foldkit'

import { Message } from './message'
import type { Model } from './model'

export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  keys: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Subscription.keyBindings<Message>({
          bindings: [
            { keys: 'Delete', mapEvent: () => Message.PressedDelete() },
            { keys: 'Backspace', mapEvent: () => Message.PressedDelete() },
            { keys: 'Escape', mapEvent: () => Message.CancelledPending() },
            { keys: 'Mod+C', mapEvent: () => Message.PressedCopy() },
            { keys: 'Mod+V', mapEvent: () => Message.PressedPaste() },
            { keys: 'Mod+Z', mapEvent: () => Message.PressedUndo() },
            { keys: 'Mod+Shift+Z', mapEvent: () => Message.PressedRedo() },
            { keys: 'Mod+Y', mapEvent: () => Message.PressedRedo() },
          ],
        }),
    },
  ),
}))
