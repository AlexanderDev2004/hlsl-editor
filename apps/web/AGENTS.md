# Agent Development Notes

This is a Foldkit app. Read [`FOLDKIT.md`](./FOLDKIT.md) before writing any code in this project. It covers the architecture, the APIs, and the conventions the project is built on.

Foldkit owns `FOLDKIT.md` and replaces it whole on upgrade. This file is yours. Anything you want an agent to know about this project goes below, where an upgrade won't touch it.

`FOLDKIT.md` reads the line below to decide whether it has already offered to vendor the Foldkit source. Leave it in place.

subtree_prompted: false

## Project Notes

HLSL graph editor (MVP 1). Pure domain lives in workspace packages
(`@hlsl-editor/*`) with zero Foldkit imports; `src/editor/*` is the only
Foldkit layer. Key gotchas verified against installed deps (foldkit 0.166.0,
effect 4.0.0): Effect 4 Schema takes tuples (`Schema.Union([...])`) and
positional Record (`Schema.Record(k, v)`); error catching is `Effect.catch`
(not `catchAll`); Model absence uses `Schema.Option`; `h.empty` is a value,
not a function; pointer coordinates come from `OnPointerDown/Move/Up`;
global keys go through `Subscription.keyBindings`. App code uses
`modifyFields` (nested for sub-records), never spread in updaters.
