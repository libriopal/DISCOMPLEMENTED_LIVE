/**
 * Ambient background: a sparse lattice of gold filigree.
 *
 * Deliberately close to invisible. The corpus is dense — cathedral naves,
 * exploding facets, storms of commit logs — and a marketing page that tried to
 * match that density would be unreadable. So the motif is quoted rather than
 * reproduced: a thin lattice at low opacity behind the hero, with the same
 * geometry as the brand mark, and a radial mask so it fades before it reaches
 * any text.
 *
 * Rendered as one inline SVG with a <pattern>, not an image: a few hundred
 * bytes, no network request, no raster to go soft on a high-DPI screen, and it
 * inherits the palette so it can never drift from the tokens.
 *
 * Hidden from assistive tech and dropped entirely under reduced-motion-safe
 * rendering is unnecessary — it does not animate. It is decoration with no
 * information in it, which is the point.
 */

export interface LatticeFieldProps {
  /** 0–1. Kept low; above ~0.09 it starts competing with body text. */
  readonly opacity?: number;
  readonly className?: string;
}

export function LatticeField({
  opacity = 0.055,
  className,
}: LatticeFieldProps) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio="xMidYMid slice"
      xmlns="http://www.w3.org/2000/svg"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        opacity,
      }}
    >
      <defs>
        {/* One lattice cell, tiled. The geometry matches LatticeMark so the
            background and the logo are visibly the same system. */}
        <pattern
          id="mkt-lattice"
          width="72"
          height="84"
          patternUnits="userSpaceOnUse"
          patternTransform="translate(0 0)"
        >
          <g
            stroke="var(--mkt-gold, #d8a83c)"
            strokeWidth="0.75"
            fill="none"
            strokeLinejoin="round"
          >
            <path d="M36 6 L66 24 L66 60 L36 78 L6 60 L6 24 Z" />
            <path d="M36 6 L36 78" opacity="0.5" />
            <path d="M6 24 L66 60" opacity="0.35" />
            <path d="M66 24 L6 60" opacity="0.35" />
          </g>
          <g fill="var(--mkt-cyan, #3ac9d4)" opacity="0.7">
            <circle cx="36" cy="6" r="1.4" />
            <circle cx="66" cy="24" r="1.4" />
            <circle cx="6" cy="24" r="1.4" />
          </g>
        </pattern>

        {/* Fades the field out before it reaches the headline. */}
        <radialGradient id="mkt-lattice-mask" cx="50%" cy="38%" r="72%">
          <stop offset="0%" stopColor="white" stopOpacity="0.9" />
          <stop offset="55%" stopColor="white" stopOpacity="0.35" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <mask id="mkt-lattice-fade">
          <rect width="100%" height="100%" fill="url(#mkt-lattice-mask)" />
        </mask>
      </defs>

      <rect
        width="100%"
        height="100%"
        fill="url(#mkt-lattice)"
        mask="url(#mkt-lattice-fade)"
      />
    </svg>
  );
}
