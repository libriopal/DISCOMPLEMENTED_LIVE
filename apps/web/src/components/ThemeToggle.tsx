/**
 * ThemeToggle — theme picker for the Discomplement design system.
 *
 * The list of themes is not written here. It comes from `tokens/source.json`
 * via `tokens/build.cjs`, which emits both the `[data-theme='...']` CSS blocks
 * and the `themes` metadata below. Adding a theme is a data change plus a
 * rebuild; this component needs no edit.
 *
 * Three states, not two: explicit light, explicit dark, and System — see the
 * note on `SYSTEM` below for why the last one is resolved in JS rather than
 * left to the cascade. What persists is the preference; what is stamped on
 * <html> is always a concrete theme id.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  themes,
  defaultThemeId,
  isThemeId,
  type ThemeId,
} from '../lib/generated-tokens.js';

const STORAGE_KEY = 'bicameral-theme';

/**
 * The third state.
 *
 * A picker offering only explicit themes is a one-way door: a reader who tries
 * dark once can never get back to "whatever my machine says", and their choice
 * then silently outlives every future OS switch. This is stored as a preference
 * distinct from the theme it currently resolves to.
 *
 * It is NOT implemented by removing `data-theme` and letting
 * `prefers-color-scheme` decide in CSS, which is the usual shape. It cannot be
 * here: `generated-tokens.css` assigns the bare `:root` the dark app tokens
 * (`[data-theme='dark'], :root { ... }`) while `dual-theme.css` assigns the bare
 * `:root` the light parchment palette, so an unstamped document renders light
 * surfaces with dark-theme component tokens. Resolving in JS and stamping a
 * concrete id keeps the two sheets in agreement, and the media-query listener
 * below is what keeps "system" actually meaning system.
 */
const SYSTEM = 'system' as const;
type Preference = ThemeId | typeof SYSTEM;

function isPreference(value: unknown): value is Preference {
  return value === SYSTEM || isThemeId(value);
}

/** Which concrete theme the system preference means right now. */
function resolveSystemTheme(): ThemeId {
  if (typeof window !== 'undefined') {
    if (window.matchMedia?.('(prefers-color-scheme: light)').matches) {
      const light = themes.find((t) => t.scheme === 'light');
      if (light) return light.id;
    }
  }
  return defaultThemeId;
}

function getInitialPreference(): Preference {
  if (typeof window === 'undefined') return SYSTEM;

  // localStorage throws in some privacy modes; a theme is not worth a crash.
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isPreference(stored)) return stored;
  } catch {
    /* fall through to the system preference */
  }

  // Absent has always meant "follow the system" - `theme-init.js` reads it the
  // same way. The stored key predates the picker, when it only ever held
  // 'dark' or 'light'; those are still valid ids, so an existing visitor's
  // choice survives the upgrade untouched.
  return SYSTEM;
}

export function ThemeToggle() {
  const [preference, setPreference] =
    useState<Preference>(getInitialPreference);
  const [systemTheme, setSystemTheme] = useState<ThemeId>(resolveSystemTheme);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const theme: ThemeId = preference === SYSTEM ? systemTheme : preference;

  // Track the OS while the reader is on "System". Without this, "system" would
  // mean "whatever the system said when the page loaded", which is the same
  // stale-once-resolved behaviour the third state exists to fix.
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: light)');
    if (!query) return;
    const onChange = () => setSystemTheme(resolveSystemTheme());
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;

    // Transition class for a smooth swap; removed once the animation is done so
    // it never interferes with unrelated style changes.
    root.classList.add('theme-transition');
    root.setAttribute('data-theme', theme);

    try {
      // The PREFERENCE is persisted, not the resolved theme. Writing 'dark'
      // here because the OS is currently dark would silently convert a system
      // follower into an explicit chooser on their next visit.
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      /* the theme still applies for this session */
    }

    const timer = setTimeout(() => {
      root.classList.remove('theme-transition');
    }, 400);

    return () => clearTimeout(timer);
  }, [theme, preference]);

  // Dismiss on outside click or Escape.
  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node))
        setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        // Return focus to the trigger so keyboard users are not dropped at the
        // top of the document.
        containerRef.current?.querySelector('button')?.focus();
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  // Move focus into the menu when it opens, so it is operable without a mouse.
  useEffect(() => {
    if (!isOpen) return;
    const checked = menuRef.current?.querySelector<HTMLButtonElement>(
      '[aria-checked="true"]'
    );
    (checked ?? menuRef.current?.querySelector('button'))?.focus();
  }, [isOpen]);

  // Roving arrow-key navigation within the menu.
  const onMenuKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();

    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []
    );
    if (items.length === 0) return;

    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = (index + delta + items.length) % items.length;
    items[next]?.focus();
  }, []);

  const resolved = themes.find((t) => t.id === theme) ?? themes[0];
  const active =
    preference === SYSTEM
      ? { ...resolved, label: `System (${resolved.label})` }
      : resolved;

  // The picker's rows: the explicit themes, plus System. Its swatch previews
  // whatever it currently resolves to, so the row shows what choosing it does.
  const options: {
    id: Preference;
    label: string;
    swatch: (typeof resolved)['swatch'];
  }[] = [
    ...themes.map((t) => ({
      id: t.id as Preference,
      label: t.label,
      swatch: t.swatch,
    })),
    { id: SYSTEM, label: 'System', swatch: resolved.swatch },
  ];

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setIsOpen((open) => !open)}
        className="theme-toggle"
        aria-label={`Theme: ${active.label}. Change theme`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title={`${active.label} theme — click to change`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-default)',
          background: 'var(--surface-raised)',
          cursor: 'pointer',
          transition: 'all var(--duration-normal) var(--ease-standard)',
        }}
      >
        {/* The icon tracks the active theme's scheme, not its identity — the
            label carries identity, so the icon stays a legible light/dark cue. */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          style={{
            color: 'var(--color-accent)',
            transition: 'color var(--duration-normal) var(--ease-standard)',
          }}
        >
          {active.scheme === 'dark' ? (
            <>
              <circle cx="12" cy="12" r="4" fill="currentColor" />
              <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="12" y1="2" x2="12" y2="4" />
                <line x1="12" y1="20" x2="12" y2="22" />
                <line x1="4.93" y1="4.93" x2="6.34" y2="6.34" />
                <line x1="17.66" y1="17.66" x2="19.07" y2="19.07" />
                <line x1="2" y1="12" x2="4" y2="12" />
                <line x1="20" y1="12" x2="22" y2="12" />
                <line x1="4.93" y1="19.07" x2="6.34" y2="17.66" />
                <line x1="17.66" y1="6.34" x2="19.07" y2="4.93" />
              </g>
            </>
          ) : (
            <path
              d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
              fill="currentColor"
            />
          )}
        </svg>
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Theme"
          onKeyDown={onMenuKeyDown}
          style={{
            position: 'absolute',
            top: 'calc(100% + var(--space-2))',
            right: 0,
            minWidth: 176,
            padding: 'var(--space-1)',
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)',
            zIndex: 100,
          }}
        >
          {options.map((option) => {
            const isActive = option.id === preference;
            return (
              <button
                key={option.id}
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => {
                  setPreference(option.id);
                  setIsOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  width: '100%',
                  padding: 'var(--space-2) var(--space-3)',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  background: isActive ? 'var(--surface-hover)' : 'transparent',
                  color: 'var(--text-primary)',
                  font: 'inherit',
                  fontSize: 'var(--text-caption)',
                  textAlign: 'left',
                  cursor: 'pointer',
                  transition:
                    'background var(--duration-fast) var(--ease-standard)',
                }}
              >
                {/* Swatch colours are resolved at build time, so each row
                    previews its own palette rather than the active one. */}
                <span
                  aria-hidden="true"
                  style={{
                    flex: 'none',
                    width: 16,
                    height: 16,
                    borderRadius: 'var(--radius-full)',
                    background: option.swatch.surfaceBase,
                    border: `1px solid ${option.swatch.colorAccent}`,
                    boxShadow: `inset 0 -6px 0 -2px ${option.swatch.colorAccent}`,
                  }}
                />
                <span style={{ flex: 1 }}>{option.label}</span>
                {isActive && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                    style={{ flex: 'none', color: 'var(--color-accent)' }}
                  >
                    <path
                      d="M20 6L9 17l-5-5"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
