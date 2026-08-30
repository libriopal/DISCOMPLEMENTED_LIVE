# Palette

The colour identity of discomplemented.com, in two themes, with the ratios that
were computed rather than estimated.

> **On this document's existence.** The wiring package says to _update_ > `palette.md`. There was no `palette.md` — not in `COMPaNiON`, not in
> `DISCOMPLEMENTED_ADMIN`, not anywhere under `discomplement/`. It is created here, and
> that is noted because "update the palette doc" and "there is no palette doc"
> are different situations and only one of them is a small job.
>
> The other reason to say it: a document is the weakest possible place to keep a
> contrast ratio. `apps/web/tokens/contrast-matrix.md` already existed, generated
> 2026-08-21 by a script that is not in this repository and does not run in CI,
> and nothing fails when a hex value drifts away from what it asserts. This file
> is prose about intent. **The enforcement is
> `apps/web/src/styles/contrast.test.ts`**, which reads `dual-theme.css` on every
> run and recomputes every pair. Where the two disagree, the test is right.

---

## The two themes

Both are defined in `apps/web/src/styles/dual-theme.css`.

**Parchment** (light, the default) is the base44 prototype's identity — warm
off-white grounds, ink-on-paper text, a teal accent, a gold structural line, a
terracotta signal. Four of its tokens failed WCAG AA and are corrected below.

**Void** (dark) is derived from the design corpus in
`libriopal/magentadice-cyancode/data` — 1116 images, a 400-image pixel sample.
The hues are _measured_, not chosen: gold clusters 24–33° (centre 30°), cyan
192–207° (centre ~200°), magenta 300–319°, and the grounds cluster on black with
a consistent blue shift (`#000000` / `#080810` / `#000008` / `#101010`), never
neutral grey.

### The role structure is identical in both

| Role                                               | What it is for                                    |
| -------------------------------------------------- | ------------------------------------------------- |
| `ground` / `ground-2` / `ground-3` / `ground-deep` | surfaces, in bands                                |
| `ink` / `ink-muted` / `ink-faint`                  | text                                              |
| `contour`                                          | accent — everyday interactive, the primary button |
| `benchmark`                                        | structure — rules, borders, badges                |
| `checkpoint`                                       | **signal** — at most twice per surface            |
| `on-signal`                                        | the label that sits on a filled signal            |
| `line` / `line-strong`                             | hairlines, as alpha over the ground               |

That structure is the part that is a system. One divergence is deliberate: the
**signal hue differs between themes** — terracotta (13°) on parchment, magenta
(310°) on void. Neither survives the other's ground; magenta on parchment is
garish and terracotta on void is muddy. The role is constant, the hue is not.

### A naming correction

The kit ships these tokens as `--sur-parchment`, `--sur-parchment-2`, and so on.
They are renamed **`--sur-ground*`**. In the dark theme `--sur-parchment` holds
`#08080f`, and a token named for a colour it does not hold is the kind of thing
that reads fine until someone trusts the name.

---

## Parchment (light)

### Surfaces

| Token               | Value     |
| ------------------- | --------- |
| `--sur-ground`      | `#f5efe4` |
| `--sur-ground-2`    | `#efe7d6` |
| `--sur-ground-3`    | `#e8dec9` |
| `--sur-ground-deep` | `#e0d4bc` |

**Three grounds, not one.** This is the fact the audit missed and it is the
reason half the corrections below are two deep — see _What the audit got wrong_.

### Text and roles

| Token              | Value     | On ground / -2 / -3 |
| ------------------ | --------- | ------------------- |
| `--sur-ink`        | `#232a25` | 12.84 (AAA)         |
| `--sur-ink-muted`  | `#5d6358` | 5.41 (AA)           |
| `--sur-ink-faint`  | `#656359` | 5.27 / 4.90 / 4.52  |
| `--sur-contour`    | `#296d68` | 5.27 / 4.90 / 4.52  |
| `--sur-benchmark`  | `#7d5d1c` | 5.31 / 4.94 / 4.55  |
| `--sur-checkpoint` | `#9e4a34` | 5.27 / 4.90 / 4.51  |

Hover and active states keep the original brighter colours, which is what
"keep the brighter value" means — the pairing makes each correction reversible
at a glance:

| Token                     | Value     | On ground |
| ------------------------- | --------- | --------- |
| `--sur-contour-bright`    | `#2f7d77` | 4.25      |
| `--sur-benchmark-bright`  | `#9a7322` | 3.78      |
| `--sur-checkpoint-bright` | `#bf5a3f` | 3.86      |

All three clear 3:1, which is the applicable threshold: they are never body
text.

Supporting values: `--sur-thread` `#c98a4e`, `--sur-thread-soft`
`rgba(201,138,78,.4)`, `--sur-line` `rgba(28,38,34,.14)`, `--sur-line-strong`
`rgba(28,38,34,.3)`, `--sur-on-signal` `#f5efe4`, `--lattice-opacity` `.1`.

## Void (dark)

| Token               | Value     | Hue | On ground   |
| ------------------- | --------- | --- | ----------- |
| `--sur-ground`      | `#08080f` | —   | —           |
| `--sur-ground-2`    | `#101018` | —   | —           |
| `--sur-ground-3`    | `#16161f` | —   | —           |
| `--sur-ground-deep` | `#040407` | —   | —           |
| `--sur-ink`         | `#f4f2ef` | —   | 17.87 (AAA) |
| `--sur-ink-muted`   | `#a9a6a0` | —   | 8.22 (AAA)  |
| `--sur-ink-faint`   | `#8f8d86` | —   | 6.01        |
| `--sur-contour`     | `#65b7e0` | 200 | 8.94 (AAA)  |
| `--sur-benchmark`   | `#d99a5b` | 30  | 8.29 (AAA)  |
| `--sur-checkpoint`  | `#e660cf` | 310 | 6.60        |

`--sur-on-signal` `#0b0b10`, `--sur-line` `rgba(244,242,239,.12)`,
`--sur-line-strong` `rgba(244,242,239,.26)`, `--lattice-opacity` `.055` (the
corpus is dense; the page is not — above ~0.09 the ambient field competes with
body text).

**The cyan moved.** The marketing surface shipped `#3ac9d4`, which is 184°. The
corpus renders its cyan at ~200°, and `#65b7e0` is the measured value. The
shipped one was not wrong by eye; it simply was not the corpus's.

---

## What the audit got wrong

The wiring package's contrast audit found four AA failures in the prototype and
gave a corrected value for each. Both of its conclusions needed correcting.

**1. Every parchment ratio was computed against the base ground only.** The
palette has three grounds. Three of the four "corrected" values still fail on
`--sur-ground-2` and `--sur-ground-3` — which are exactly the banded sections
that faint ink and secondary buttons sit on:

| Token              | Shipped          | Audit's fix      | on -2 | on -3 | Actual fix |
| ------------------ | ---------------- | ---------------- | ----- | ----- | ---------- |
| `--sur-ink-faint`  | `#8f8d80` (2.92) | `#706d5d` (4.55) | 4.23  | 3.90  | `#656359`  |
| `--sur-contour`    | `#2f7d77` (4.25) | `#2c7873` (4.54) | 4.22  | 3.89  | `#296d68`  |
| `--sur-benchmark`  | `#9a7322` (3.78) | `#8c671b` (4.51) | 4.19  | 3.86  | `#7d5d1c`  |
| `--sur-checkpoint` | `#bf5a3f` (3.86) | `#b15036` (4.51) | —     | —     | `#9e4a34`  |

Each replacement is darkened **along its own hue** until it clears 4.5:1 on the
deepest ground it can appear on, so the design reads identically. Hue drift is
under 3° in every case and is 8-bit rounding, not a choice (`--sur-ink-faint`
52° → 50°, `--sur-benchmark` 40.5° → 40.2°; `--sur-contour` 175° and
`--sur-checkpoint` 13° held exactly).

**2. It dropped the originals it said to keep.** The instruction was to keep the
brighter failing values as `*-bright` for hover and active. The kit's own sheet
instead kept the _prototype's_ separate `-bright` colours and dropped these
three, which lost the originals and left `--sur-benchmark-bright` at `#b08a2e` —
**2.81:1**, under even the 3:1 UI threshold, for the hover state of the colour
that draws structure. The `-bright` tokens now hold the originals.

Neither of these is a criticism of doing the audit; they are what a static audit
degrades into. All of it was found by making the check executable.

---

## The three theme states

Explicit light, explicit dark, and system default. Two implementation facts are
load-bearing:

**No colour is defined only inside a media query.** Each theme is written at
three sites — `:root` for parchment, `:root[data-theme='dark'], .theme-void` for
the explicit choice, and `@media (prefers-color-scheme: dark) :root:not([data-theme='light'])`
for the system preference. A token that exists only under `prefers-color-scheme`
is undefined for every reader who has explicitly chosen, and that failure is
silent. `contrast.test.ts` asserts the two dark definitions are equal token for
token, which is what keeps the duplication honest.

**"System" is resolved in JavaScript, not delegated to the cascade.** The usual
shape — remove `data-theme` and let the media query decide — does not work here.
`generated-tokens.css` assigns the bare `:root` the **dark** app tokens
(`[data-theme='dark'], :root { … }`) while `dual-theme.css` assigns the bare
`:root` the **light** parchment palette, so an unstamped document renders light
surfaces with dark component tokens. `public/theme-init.js` therefore resolves
the preference before React and always stamps a concrete id;
`ThemeToggle.tsx` persists the _preference_ (which may be the literal `system`)
and listens for `prefers-color-scheme` changes so System keeps meaning system
rather than "whatever the OS said at page load".

## Where these are used

`apps/web/src/styles/marketing.css` re-maps its own primitives onto the role
tokens (`--mkt-void: var(--sur-ground)` and so on), so the marketing surface
inherits both themes rather than carrying a second palette. That surface was
previously single-theme by deliberate choice; the constraint is retired, not
overridden, and parchment is now its default.

## Changing a colour

Edit `dual-theme.css` and run:

```bash
npx vitest run apps/web/src/styles/contrast.test.ts
```

It recomputes every pair from the file. A ratio written in a comment — or in
this document — is a claim; that test is the evidence.
