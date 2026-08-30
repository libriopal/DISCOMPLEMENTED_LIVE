/**
 * Breakpoint preview — renders the current app inside iframes sized to each
 * breakpoint from design/03-design-system-tokens.html ("06 — Breakpoints").
 */
const BREAKPOINTS = [
  { id: 'sm', label: 'Mobile', width: 375 },
  { id: 'md', label: 'Tablet', width: 768 },
  { id: 'lg', label: 'Desktop', width: 1024 },
  { id: 'xl', label: 'Large', width: 1440 },
];

export function ResponsiveView() {
  return (
    <div
      style={{
        padding: 'var(--space-8) var(--space-6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-6)',
      }}
    >
      <h1 style={{ fontSize: 32 }}>Responsive Preview</h1>
      <div
        style={{
          display: 'flex',
          gap: 'var(--space-6)',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
        }}
      >
        {BREAKPOINTS.map((bp) => (
          <div
            key={bp.id}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
            }}
          >
            <div
              style={{
                fontSize: 13,
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {bp.label} · {bp.width}px
            </div>
            <div
              style={{
                width: Math.min(bp.width, 420),
                height: 600,
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-lg)',
                overflow: 'hidden',
              }}
            >
              <iframe
                src="/"
                title={`${bp.label} preview`}
                style={{
                  width: bp.width,
                  height: 900,
                  border: 'none',
                  transform: `scale(${Math.min(bp.width, 420) / bp.width})`,
                  transformOrigin: 'top left',
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
