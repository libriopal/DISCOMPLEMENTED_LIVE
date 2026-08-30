/**
 * Guided First-Time Onboarding — intent-based self-selection flow.
 *
 * Research-backed patterns (SaaS Onboarding UX Best Practices):
 * - Intent-based self-selection: Build/Import/Design paths
 * - Zero-config sandbox: pre-fill prompt based on intent
 * - Time-to-first-value < 30 seconds
 * - Progressive disclosure: show complexity only when needed
 *
 * NS1 + NS3: Track first-time user success rate and auto-offer help
 * if they're struggling (detected via user-events gap detection).
 */
import { useState } from 'react';

type Intent = 'build' | 'explore' | 'design';

const INTENT_OPTIONS: {
  id: Intent;
  label: string;
  description: string;
  examplePrompt: string;
  icon: string;
}[] = [
  {
    id: 'build',
    label: 'Build a new app',
    description:
      'Start from scratch with a prompt — describe what you want to build.',
    examplePrompt:
      'Build a todo app with React and TypeScript. Include add, delete, and mark-complete features.',
    icon: '🚀',
  },
  {
    id: 'explore',
    label: 'Explore examples',
    description: 'Not sure where to start? Try one of our example projects.',
    examplePrompt:
      'Build a weather dashboard with a clean, modern UI. Show current temperature, forecast, and a 7-day outlook.',
    icon: '🧪',
  },
  {
    id: 'design',
    label: 'Generate UI design',
    description:
      'Focus on design first — generate a beautiful UI component or page.',
    examplePrompt:
      'Create a pricing page with three tiers: Free, Pro ($29/mo), and Team ($99/mo). Use a dark theme with violet accents.',
    icon: '🎨',
  },
];

export function OnboardingFlow({
  onComplete,
}: {
  onComplete: (intent: Intent, examplePrompt: string) => void;
}) {
  const [step, setStep] = useState<'welcome' | 'select' | 'prompt'>('welcome');
  const [selectedIntent, setSelectedIntent] = useState<Intent | null>(null);

  // Track onboarding start
  if (step === 'welcome') {
    fetch('/api/user-events', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'onboarding_start' }),
    }).catch(() => {});
  }

  const handleSelect = (intent: Intent) => {
    setSelectedIntent(intent);
    setStep('prompt');
  };

  const handleComplete = () => {
    const option = INTENT_OPTIONS.find((o) => o.id === selectedIntent);
    if (option && selectedIntent) {
      fetch('/api/user-events', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'onboarding_complete',
          metadata: { intent: selectedIntent },
        }),
      }).catch(() => {});
      onComplete(selectedIntent, option.examplePrompt);
    }
  };

  if (step === 'welcome') {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.8)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
        }}
      >
        <div
          style={{
            maxWidth: 560,
            padding: 'var(--space-8)',
            textAlign: 'center',
            background: 'var(--surface-raised)',
            borderRadius: 16,
            border: '1px solid var(--border-default)',
          }}
        >
          <div style={{ fontSize: 48, marginBottom: 'var(--space-4)' }}>👋</div>
          <h2
            style={{
              fontSize: 24,
              fontWeight: 700,
              marginBottom: 'var(--space-3)',
            }}
          >
            Welcome to Discomplement
          </h2>
          <p
            style={{
              fontSize: 15,
              color: 'var(--text-secondary)',
              marginBottom: 'var(--space-6)',
            }}
          >
            Your autonomous dev team — from idea to deployed app. Let's get you
            to your first generation in under 30 seconds.
          </p>
          <button
            onClick={() => setStep('select')}
            style={{
              padding: '12px 32px',
              borderRadius: 8,
              border: 'none',
              cursor: 'pointer',
              background: 'var(--color-accent)',
              color: 'var(--neutral-0)',
              fontSize: 15,
              fontWeight: 600,
            }}
          >
            Get Started →
          </button>
        </div>
      </div>
    );
  }

  if (step === 'select') {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.8)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
        }}
      >
        <div
          style={{
            maxWidth: 720,
            padding: 'var(--space-8)',
            background: 'var(--surface-raised)',
            borderRadius: 16,
            border: '1px solid var(--border-default)',
          }}
        >
          <h2
            style={{
              fontSize: 20,
              fontWeight: 700,
              marginBottom: 'var(--space-2)',
              textAlign: 'center',
            }}
          >
            What do you want to build?
          </h2>
          <p
            style={{
              fontSize: 14,
              color: 'var(--text-secondary)',
              textAlign: 'center',
              marginBottom: 'var(--space-6)',
            }}
          >
            Choose a path and we'll set up your workspace automatically.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 'var(--space-4)',
            }}
          >
            {INTENT_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                onClick={() => handleSelect(opt.id)}
                style={{
                  padding: 'var(--space-6)',
                  borderRadius: 12,
                  cursor: 'pointer',
                  background: 'var(--surface-base)',
                  border: '1px solid var(--border-default)',
                  textAlign: 'center',
                  transition: 'border-color 0.2s',
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.borderColor = 'var(--color-accent)')
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.borderColor = 'var(--border-default)')
                }
              >
                <div style={{ fontSize: 32, marginBottom: 'var(--space-3)' }}>
                  {opt.icon}
                </div>
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 600,
                    marginBottom: 'var(--space-2)',
                  }}
                >
                  {opt.label}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {opt.description}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Prompt preview step
  const option = INTENT_OPTIONS.find((o) => o.id === selectedIntent);
  if (!option) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.8)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        style={{
          maxWidth: 600,
          padding: 'var(--space-8)',
          background: 'var(--surface-raised)',
          borderRadius: 16,
          border: '1px solid var(--border-default)',
        }}
      >
        <h2
          style={{
            fontSize: 20,
            fontWeight: 700,
            marginBottom: 'var(--space-3)',
          }}
        >
          {option.icon} {option.label}
        </h2>
        <p
          style={{
            fontSize: 14,
            color: 'var(--text-secondary)',
            marginBottom: 'var(--space-4)',
          }}
        >
          Here's a starting prompt — feel free to edit it or use it as-is:
        </p>
        <div
          style={{
            padding: 'var(--space-4)',
            borderRadius: 8,
            marginBottom: 'var(--space-6)',
            background: 'var(--surface-base)',
            border: '1px solid var(--border-default)',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 14,
            color: 'var(--text-muted)',
          }}
        >
          {option.examplePrompt}
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          <button
            onClick={() => setStep('select')}
            style={{
              padding: '10px 24px',
              borderRadius: 8,
              cursor: 'pointer',
              background: 'transparent',
              border: '1px solid var(--border-default)',
              color: 'var(--text-secondary)',
              fontSize: 14,
            }}
          >
            ← Back
          </button>
          <button
            onClick={handleComplete}
            style={{
              padding: '10px 32px',
              borderRadius: 8,
              cursor: 'pointer',
              background: 'var(--color-accent)',
              color: 'var(--neutral-0)',
              fontSize: 14,
              fontWeight: 600,
              border: 'none',
            }}
          >
            Start Building →
          </button>
        </div>
      </div>
    </div>
  );
}
