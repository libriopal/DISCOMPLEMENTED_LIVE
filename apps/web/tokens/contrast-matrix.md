# Discomplement Token Contrast Matrix

**Generated:** 2026-08-21
**Standard:** WCAG 2.2 AA
**Method:** Computed via sRGB → relative luminance → contrast ratio formula
**Verification tool:** Python script, verified against WebAIM contrast checker

## Anchor Colors (brand identity)

| Anchor | Hex | On White | On Dark (#050507) | AA Body (4.5:1) | AA Large (3:1) |
|---|---|---|---|---|---|
| Magenta | #FF00FF | 3.14:1 | 6.25:1 | ❌ on white | ✓ on white; ✓ on dark |
| Cyan | #00FFFF | 1.25:1 | 15.64:1 | ❌ on white | ❌ on white; ✓ on dark |

**Rule:** Anchors appear at full saturation only in logo, on dark backgrounds, and in glow/accent treatments. Never as body text on light surfaces.

## Magenta Ramp (Semantic Layer)

| Shade | Hex | On White | On Dark | AA Body W | AA Body D | Usage |
|---|---|---|---|---|---|---|
| 100 | #ffe6f5 | 1.17:1 | 16.71:1 | ✗ | ✓ | Dark surface tint |
| 200 | #ffc8e6 | 1.43:1 | 13.69:1 | ✗ | ✓ | Dark surface accent |
| 300 | #ff96c8 | 2.01:1 | 9.76:1 | ✗ | ✓ | Dark surface emphasis |
| 400 | #eb64aa | 3.03:1 | 6.48:1 | Large only | ✓ | AA large both themes |
| 500 | #c8328c | 4.89:1 | 4.01:1 | ✓ | Large only | Primary accent (dark) |
| 600 | #a51e6e | 6.98:1 | 2.81:1 | ✓ | ✗ | Primary accent (light) |
| 700 | #7d1455 | 9.98:1 | 1.96:1 | ✓ | ✗ | Body text on light |
| 800 | #550f3c | 13.82:1 | 1.42:1 | ✓ | ✗ | Headings on light |
| 900 | #320a23 | 17.45:1 | 1.12:1 | ✓ | ✗ | Near-black plum |

## Cyan Ramp (Code Layer)

| Shade | Hex | On White | On Dark | AA Body W | AA Body D | Usage |
|---|---|---|---|---|---|---|
| 100 | #dcfaff | 1.10:1 | 17.90:1 | ✗ | ✓ | Dark surface tint |
| 200 | #b9f0ff | 1.24:1 | 15.85:1 | ✗ | ✓ | Dark surface accent |
| 300 | #8cdcf5 | 1.54:1 | 12.77:1 | ✗ | ✓ | Dark surface emphasis |
| 400 | #5ac3e6 | 2.02:1 | 9.70:1 | ✗ | ✓ | Dark surface accent |
| 500 | #28a0d2 | 2.98:1 | 6.58:1 | Large only | ✓ | AA large on dark |
| 600 | #0078a5 | 4.96:1 | 3.95:1 | ✓ | Large only | Primary code accent |
| 700 | #005a82 | 7.54:1 | 2.60:1 | ✓ | ✗ | Body text on light |
| 800 | #003c64 | 11.47:1 | 1.71:1 | ✓ | ✗ | Headings on light |
| 900 | #002346 | 15.80:1 | 1.24:1 | ✓ | ✗ | Near-black teal |

## Theme Assignment Summary

### Dark Theme (primary, default)
| Token | Resolves to | Shade | Contrast on dark |
|---|---|---|---|
| --color-accent | --semantic-400 | #eb64aa | 6.48:1 ✓ |
| --hemisphere-left | --semantic-400 | #eb64aa | 6.48:1 ✓ |
| --hemisphere-right | --code-400 | #5ac3e6 | 9.70:1 ✓ |
| --button-bg | --semantic-500 | #c8328c | 4.01:1 (large) |
| --input-border-focus | --semantic-400 | #eb64aa | 6.48:1 ✓ |
| --chat-bubble-user | --semantic-500 | #c8328c | 4.01:1 (large) |

### Light Theme
| Token | Resolves to | Shade | Contrast on light |
|---|---|---|---|
| --color-accent | --semantic-600 | #a51e6e | 6.98:1 ✓ |
| --hemisphere-left | --semantic-600 | #a51e6e | 6.98:1 ✓ |
| --hemisphere-right | --code-600 | #0078a5 | 4.96:1 ✓ |
| --button-bg | --semantic-600 | #a51e6e | 6.98:1 ✓ |
| --input-border-focus | --semantic-600 | #a51e6e | 6.98:1 ✓ |
| --chat-bubble-user | --semantic-500 | #c8328c | 4.89:1 ✓ |

## Semantic Binding Rules

1. **Magenta (semantic)** → intent, natural language, prompts, reasoning traces, agent dialogue, ambiguity states
2. **Cyan (code)** → artefacts, generated code, file trees, diffs, build logs, deterministic output
3. **Bridge** → corpus callosum gradient at prompt→artefact transitions
4. **Neutral** → chrome, structure, containers (majority of page)

## Constraints

1. Saturated magenta adjacent to saturated cyan causes chromatic vibration — always separate with neutral or desaturated step
2. Never encode meaning by hue alone — pair with icon, label, or position (deuteranopia safety)
3. Cap total saturated-accent coverage at ~10% of viewport area
