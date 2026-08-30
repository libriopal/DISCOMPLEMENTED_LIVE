/**
 * The Discomplement mark.
 *
 * A lattice node: four outer vertices joined through a centre, drawn as gold
 * filigree with the active node picked out. It is the product's own metaphor
 * rather than an abstract logo — the memory lattice is a Vectorize index of
 * connected nodes, and "neural lattice" is among the most frequent phrases in
 * the design corpus — 256 occurrences across 1116 prompts, behind only
 * "skeletal gold" (357), "electric magenta" (268) and "void black" (263).
 *
 * Hand-authored geometry, not a traced image: every coordinate is on an
 * 8-point grid derived from a 32×32 viewBox, so it stays crisp at favicon
 * sizes and scales without hinting.
 *
 * Colour comes from CSS custom properties with literal fallbacks, so the mark
 * themes with the page and still renders correctly in an <img> or an email
 * where no stylesheet applies.
 */

export interface LatticeMarkProps {
  readonly size?: number;
  /** Decorative marks are hidden from assistive tech; a titled one is not. */
  readonly title?: string;
  readonly className?: string;
}

export function LatticeMark({ size = 28, title, className }: LatticeMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role={title === undefined ? 'presentation' : 'img'}
      aria-hidden={title === undefined ? true : undefined}
      aria-label={title}
    >
      {title !== undefined && <title>{title}</title>}

      {/* Filigree: the connective structure. Gold, thin, never the focus. */}
      <g
        stroke="var(--mkt-gold, #d8a83c)"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.75"
      >
        <path d="M16 4 L26 10 L26 22 L16 28 L6 22 L6 10 Z" />
        <path d="M16 4 L16 28" opacity="0.45" />
        <path d="M6 10 L26 22" opacity="0.45" />
        <path d="M26 10 L6 22" opacity="0.45" />
      </g>

      {/* Outer nodes — cyan, the everyday state. */}
      <g fill="var(--mkt-cyan, #3ac9d4)">
        <circle cx="16" cy="4" r="1.9" />
        <circle cx="26" cy="10" r="1.9" />
        <circle cx="26" cy="22" r="1.9" />
        <circle cx="16" cy="28" r="1.9" />
        <circle cx="6" cy="22" r="1.9" />
        <circle cx="6" cy="10" r="1.9" />
      </g>

      {/* The centre is the one magenta element: the scarcest colour in the
          corpus marking the point where everything resolves. */}
      <circle cx="16" cy="16" r="3.4" fill="var(--mkt-magenta, #e451c0)" />
      <circle
        cx="16"
        cy="16"
        r="5.6"
        stroke="var(--mkt-magenta, #e451c0)"
        strokeWidth="1"
        opacity="0.35"
      />
    </svg>
  );
}

/** Mark plus wordmark, for the nav and the footer. */
export function LatticeWordmark({
  size = 26,
  className,
}: {
  readonly size?: number;
  readonly className?: string;
}) {
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}
    >
      <LatticeMark size={size} />
      <span className="mkt-nav__brand">Discomplement</span>
    </span>
  );
}
