/**
 * Icons for the four pipeline steps, plus the two boundary-list markers.
 *
 * One drawing system throughout: a 24×24 grid, 1.5px strokes, round caps and
 * joins, no fills except where a node is deliberately solid. They inherit
 * `currentColor` so a card sets the colour once and the icon follows — which
 * is what keeps magenta scarce without every icon needing to know the rule.
 *
 * Each icon depicts what the step actually does rather than a generic glyph:
 * a prompt caret for Describe, a lattice query for Research, a gate with a
 * held bar for Review, an edge node for Deploy. The review icon is the only
 * closed form in the set, because it is the only step that stops.
 */

interface IconProps {
  readonly size?: number;
  readonly className?: string;
}

const base = (size: number) =>
  ({
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': true,
  }) satisfies Record<string, unknown>;

/** 01 — Describe: a prompt caret over an input rule. */
export function IconDescribe({ size = 22, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 7.5 L7.5 11 L4 14.5" />
      <path d="M10.5 15.5 H20" />
      <path d="M4 20 H20" opacity="0.4" />
    </svg>
  );
}

/** 02 — Research & design: a query fanning out across lattice nodes. */
export function IconResearch({ size = 22, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="5" cy="12" r="2" />
      <circle cx="19" cy="5.5" r="1.75" />
      <circle cx="19" cy="12" r="1.75" />
      <circle cx="19" cy="18.5" r="1.75" />
      <path d="M7 11.2 L17.2 6.2" opacity="0.6" />
      <path d="M7 12 H17.2" opacity="0.6" />
      <path d="M7 12.8 L17.2 17.8" opacity="0.6" />
    </svg>
  );
}

/** 03 — You review: a gate, closed. The only closed form in the set. */
export function IconReview({ size = 22, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 19 V9.5 a8 8 0 0 1 16 0 V19" />
      <path d="M2.5 19 H21.5" />
      <path d="M8.5 19 V13.5 h7 V19" opacity="0.55" />
      <circle cx="12" cy="10" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 04 — Code & deploy: a build committed out to an edge node. */
export function IconDeploy({ size = 22, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8.5 6.5 L4 12 L8.5 17.5" />
      <path d="M15.5 6.5 L20 12 L15.5 17.5" opacity="0.45" />
      <path d="M13.5 4.5 L10.5 19.5" />
    </svg>
  );
}

/** Boundary marker — something the product does well today. */
export function IconStrong({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4.5 12.5 L9.5 17.5 L19.5 6.5" />
    </svg>
  );
}

/** Boundary marker — something still moving. Deliberately open, not a cross:
    these are honest limits, not failures. */
export function IconEvolving({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 15 C 8 7, 16 21, 20 12" />
    </svg>
  );
}

export const STEP_ICONS = [
  IconDescribe,
  IconResearch,
  IconReview,
  IconDeploy,
] as const;
