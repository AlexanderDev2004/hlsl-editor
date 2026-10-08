// One-shot side effects. Definitions live beside the update that
// returns them; every failure is caught into a failure Message.

import { Effect, Option, Schema } from 'effect'
import { Command } from 'foldkit'
import { readAsText, select } from 'foldkit/file'

import { Message } from './message'
import { SETTINGS_KEY, STORAGE_KEY } from './model'

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') {
      return null
    }
    return localStorage
  } catch {
    return null
  }
}

export const PersistGraph = Command.define('PersistGraph', {
  args: { json: Schema.String },
  messages: [Message.CompletedPersistGraph, Message.FailedPersistGraph],
  execute: ({ json }) =>
    Effect.sync(() => {
      const store = storage()
      if (store === null) {
        return Message.FailedPersistGraph({
          reason: 'Browser storage is unavailable.',
        })
      }
      store.setItem(STORAGE_KEY, json)
      return Message.CompletedPersistGraph()
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(Message.FailedPersistGraph({ reason: String(error) })),
      ),
    ),
})

export const LoadGraph = Command.define('LoadGraph', {
  messages: [
    Message.CompletedLoadGraph,
    Message.CompletedLoadEmpty,
    Message.FailedLoadGraph,
  ],
  execute: Effect.sync(() => {
    const store = storage()
    if (store === null) {
      return Message.CompletedLoadEmpty()
    }
    const json = store.getItem(STORAGE_KEY)
    if (json === null || json === '') {
      return Message.CompletedLoadEmpty()
    }
    return Message.CompletedLoadGraph({ json })
  }).pipe(
    Effect.catch(error =>
      Effect.succeed(Message.FailedLoadGraph({ reason: String(error) })),
    ),
  ),
})

export const LoadSettings = Command.define('LoadSettings', {
  messages: [
    Message.CompletedLoadSettings,
    Message.CompletedLoadSettingsEmpty,
    Message.FailedLoadSettings,
  ],
  execute: Effect.sync(() => {
    const store = storage()
    if (store === null) {
      return Message.CompletedLoadSettingsEmpty()
    }
    const json = store.getItem(SETTINGS_KEY)
    if (json === null || json === '') {
      return Message.CompletedLoadSettingsEmpty()
    }
    return Message.CompletedLoadSettings({ json })
  }).pipe(
    Effect.catch(error =>
      Effect.succeed(Message.FailedLoadSettings({ reason: String(error) })),
    ),
  ),
})

export const PersistSettings = Command.define('PersistSettings', {
  args: { json: Schema.String },
  messages: [Message.CompletedPersistSettings, Message.FailedPersistSettings],
  execute: ({ json }) =>
    Effect.sync(() => {
      const store = storage()
      if (store === null) {
        return Message.FailedPersistSettings({
          reason: 'Browser storage is unavailable.',
        })
      }
      store.setItem(SETTINGS_KEY, json)
      return Message.CompletedPersistSettings()
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedPersistSettings({ reason: String(error) }),
        ),
      ),
    ),
})

export const DownloadJson = Command.define('DownloadJson', {
  args: { json: Schema.String, filename: Schema.String },
  messages: [Message.CompletedExport],
  execute: ({ json, filename }) =>
    Effect.sync(() => {
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      return Message.CompletedExport()
    }).pipe(Effect.catch(() => Effect.succeed(Message.CompletedExport()))),
})

export const PickImportFile = Command.define('PickImportFile', {
  messages: [
    Message.CompletedImportFile,
    Message.CancelledImportFile,
    Message.FailedImportFile,
  ],
  execute: Effect.flatMap(
    select(['application/json', '.json']),
    (opt: Option.Option<File>): ImportResult => {
      if (!Option.isSome(opt)) {
        return Effect.succeed(Message.CancelledImportFile())
      }
      return readAsText(opt.value).pipe(
        Effect.map(text => Message.CompletedImportFile({ text })),
        Effect.catch(error =>
          Effect.succeed(Message.FailedImportFile({ reason: String(error) })),
        ),
      )
    },
  ).pipe(
    Effect.catch(error =>
      Effect.succeed(Message.FailedImportFile({ reason: String(error) })),
    ),
  ),
})

type ImportResult = Effect.Effect<
  | ReturnType<typeof Message.CompletedImportFile>
  | ReturnType<typeof Message.CancelledImportFile>
  | ReturnType<typeof Message.FailedImportFile>
>

export const CopyHlsl = Command.define('CopyHlsl', {
  args: { code: Schema.String },
  messages: [Message.CompletedCopyHlsl, Message.FailedCopyHlsl],
  execute: ({ code }) =>
    Effect.promise(() => navigator.clipboard.writeText(code)).pipe(
      Effect.map(() => Message.CompletedCopyHlsl()),
      Effect.catch(error =>
        Effect.succeed(Message.FailedCopyHlsl({ reason: String(error) })),
      ),
    ),
})
