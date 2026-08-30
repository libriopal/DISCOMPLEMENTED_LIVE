# Design Reference Files

These HTML files are the **canonical visual design reference** for Bicameral's UI. They were created as high-fidelity design specs and serve as the "foundational look to build from." Claude Code and the Designer agent should reference these files when building frontend components, views, and the Memory Lattice visualization.

> **Non-destructive:** These files are reference-only. Do not modify them. Read them for design tokens, component specs, layout patterns, and interaction models, then implement in React 19 + Three.js.

---

## File Index

| # | File | What It Contains | Used By |
|---|------|------------------|---------|
| 01 | `01-ia-screen-inventory.html` | 62 total screens catalogued, 24 MVP screens identified, screen taxonomy by functional area | Phase 5 (which views to build), Designer agent (component list) |
| 02 | `02-user-flows.html` | End-to-end user journeys: onboarding, project creation, pipeline execution, blueprint review, deployment | Phase 5 (navigation logic), Designer agent (flow validation) |
| 03 | `03-design-system-tokens.html` | Color palette (Indigo semantic / Violet implementation / Pink bridge), typography (Inter / Space Grotesk / Fira Code), spacing scale, border radius, shadows, animation timing | Phase 5 (`tokens.css`), Designer agent (visual consistency), all components |
| 04 | `04-component-library.html` | Component specs: buttons, inputs, cards, modals, navigation, data tables, code editors, lattice controls, chat widgets, pipeline progress indicators | Phase 5 (component implementation), Phase 5b (Coder agent component generation) |
| 05 | `05-memory-lattice-interaction.html` | 3D interaction model: camera controls, node selection, hemisphere labels (semantic/implementation), zoom levels, bridge connections, real-time update animations | Phase 5 (LatticeView), LatticeManager DO, lattice enrichment |
| 06 | `06-hifi-responsive-layouts.html` | Responsive breakpoints (mobile/tablet/desktop), layout grids, sidebar collapse behavior, pipeline progress bar responsive behavior, lattice viewport sizing | Phase 5 (ResponsiveView), all views |
| 07 | `07-astroapp-concept.html` | Original concept mockup with full theme spectrums: Scorpio Dark (#0A070A base, scarlet/crimson/amethyst accents) and Libra Light (#FAFAF9 base, serenity/balance/harmony accents) | Phase 5 (overall look-and-feel, theme implementation) |

---

## How To Use These Files

### For Claude Code (Phase 5 — Frontend Shell):
1. Read `03-design-system-tokens.html` FIRST — extract the CSS custom properties and create `apps/web/src/styles/tokens.css`
2. Read `01-ia-screen-inventory.html` — determine which 24 MVP screens to build (Phase 5 scope)
3. Read `04-component-library.html` — build reusable components matching these specs
4. Read `06-hifi-responsive-layouts.html` — implement responsive breakpoints and layout grids
5. Read `07-astroapp-concept.html` — implement the Scorpio Dark / Libra Light theme system

### For the Designer Agent (Step 3 — Blueprint Generation):
1. Read `01-ia-screen-inventory.html` — understand the full screen taxonomy to estimate component count
2. Read `04-component-library.html` — reference existing component patterns when designing the blueprint's component tree
3. Read `02-user-flows.html` — validate that the blueprint supports all required user flows
4. Read `03-design-system-tokens.html` — include design tokens in the blueprint's deploy config

### For the Coder Agent (Step 4 — Code Generation):
1. Reference `04-component-library.html` — generate React components matching the documented specs
2. Reference `03-design-system-tokens.html` — use the correct CSS custom properties
3. Reference `06-hifi-responsive-layouts.html` — implement responsive layouts per the breakpoints documented

### For the Memory Lattice (Phase 5 — LatticeView):
1. Read `05-memory-lattice-interaction.html` — implement the exact interaction model documented:
   - Camera controls (orbit, pan, zoom)
   - Node selection (click → inspector panel)
   - Hemisphere labels (semantic = top, implementation = bottom)
   - Bridge connections (InstancedMesh between hemispheres)
   - Real-time update animations (node appear, edge draw, confidence glow)

---

## Design Token Summary (from `03-design-system-tokens.html`)

### Color Spectrum
The design uses a three-color spectrum representing the pipeline's cognitive layers:
- **Indigo** — Semantic layer (architecture, research, planning)
- **Violet** — Implementation layer (code, components, deployment)
- **Pink** — Bridge layer (connections between semantic and implementation)

### Theme System (from `07-astroapp-concept.html`)
- **Scorpio Dark** — `#0A070A` background, scarlet `#E61934` / crimson `#9B111E` / amethyst `#6F35A2` accents
- **Libra Light** — `#FAFAF9` background, serenity `#5B84` / balance / harmony accents

### Typography
- **Inter** — Body text, UI labels (400, 500 weights)
- **Space Grotesk** — Headings, display text (400, 500 weights)
- **Fira Code** — Code, technical labels, monospace data (400, 500 weights)
