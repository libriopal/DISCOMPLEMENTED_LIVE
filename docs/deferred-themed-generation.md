# Deferred: themed generation (D3) and theme licensing

**Status:** deferred by the owner on 2026-08-25, to be picked up in a separate
session. Nothing in this document has been implemented. It exists so the next
session starts from measured facts rather than re-deriving them.

The visual overhaul it belongs to was split into three parts. D1 (apply the
visual system across every platform surface) and D2 (multi-theme for the
platform) were approved and are being built now. D3 is this document.

## What D3 would be

Letting a user choose a theme or design scheme for **the apps they generate**,
not just for the Discomplement UI they generate them in.

## Why it is not a theming change

The platform's own theming is in good shape and genuinely cheap to extend:
`tokens/source.json` -> `tokens/build.cjs` -> `generated-tokens.css` +
`generated-tokens.ts`, with `theme.css` as a semantic alias layer keyed on
`[data-theme]`. Components consume the aliases. A new platform theme is a new
`[data-theme='...']` block.

None of that reaches generated apps. Measured on 2026-08-25:

- Generated apps are arbitrary in-memory files bundled by `esbuild-wasm`
  (`apps/web/src/lib/multi-file-bundler.ts`) and rendered in a **sandboxed
  iframe** (`apps/web/src/components/PreviewFrame.tsx`).
- There is **no shared styling contract** between the platform and what it
  generates. The generated app ships whatever CSS the model happened to write.
- Platform CSS custom properties do **not** inherit across the iframe boundary.
  A theme has to be injected into the bundle or the iframe document
  deliberately; nothing inherits for free.
- No per-project theme field exists. `ThemeToggle.tsx` persists a single global
  choice to `localStorage` under `bicameral-theme`. `routes/preferences.ts` and
  `lib/preference-learning.ts` carry no theme field at all.

So D3 is three pieces of work, and the largest lives in the generation
pipeline rather than in the design system:

1. A stylesheet contract that generated code targets, replacing ad-hoc
   per-generation CSS. **This is the bulk of it.**
2. Injecting the selected theme across the iframe sandbox boundary.
3. New schema to persist a theme per project.

## The licensing question, which is the actual blocker

A theme shipped **into a user's app** is something the user then redistributes
in their own product. That is a different legal posture from a theme applied to
Discomplement's own UI, and it needs an answer before D3 ships.

**The repository is licensed AGPL-3.0** (see `LICENSE`). AGPL is strongly
copyleft and network-triggered. Before D3 ships, someone has to answer, with
advice that is not a coding agent's:

- If theme assets live in this AGPL repository and are emitted into a user's
  generated app, what is the license status of that app? Is the theme a
  derivative-work vector into customer code?
- Does the answer change if theme assets are held in a separately licensed
  package (permissive, or dual-licensed) rather than inside the AGPL tree?
- What grant do users actually receive for the theme their app ships with?
  A user who sells an app built on a Discomplement theme should not be the
  first person to discover this is undefined.

Note that this cuts against the "copyrightable" goal rather than with it: an
asset is only an asset if its license lets it be one.

## Authorship constraint, carried forward

Anything that ships as a user-selectable theme must be authored fresh. Nothing
derived from a captured competitor page may enter something users redistribute.
Copyright protects original expression; layout conventions and feature sets are
not it, and closely tracking a competitor's visual treatment is the one path
that creates real exposure. The corpus informs _which problems to solve_. It is
never the source of protectable expression.

## Related

- `docs/glaas-lattice-evidence.md` — the corpus the visual work is grounded in.
- `design/03-design-system-tokens.html` — the existing design system record.
- `tokens/source.json` — single source of truth for platform tokens.
