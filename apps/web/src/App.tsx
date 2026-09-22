/**
 * Root component — auth gate + sidebar-driven view switch across the
 * Phase 5 MVP views plus Value Assurance views (Value Panel, Glass Engine).
 */
import React, { useState, useEffect, lazy, Suspense } from 'react';
import { useAuth } from './hooks/useAuth.js';
import { LoginScreen } from './components/LoginScreen.js';
import { MarketingSite } from './components/marketing/MarketingSite.js';
import { ComplianceDashboard } from './components/ComplianceDashboard.js';
import { ResetPasswordScreen } from './components/ResetPasswordScreen.js';
import { LegalDocScreen } from './components/LegalDocScreen.js';
import { Sidebar, type ViewName } from './components/Sidebar.js';
import { FluxyChatWidget } from './components/FluxyChatWidget.js';
import { OnboardingFlow } from './components/OnboardingFlow.js';

// L1: Code-split each view into its own chunk — only loads when the user
// navigates to that view. Reduces initial bundle from ~910KB to ~200KB.
const GenerationView = lazy(() =>
  import('./views/GenerationView.js').then((m) => ({
    default: m.GenerationView,
  }))
);
const ProjectsView = lazy(() =>
  import('./views/ProjectsView.js').then((m) => ({ default: m.ProjectsView }))
);
const LatticeView = lazy(() =>
  import('./views/LatticeView.js').then((m) => ({ default: m.LatticeView }))
);
const TokensView = lazy(() =>
  import('./views/TokensView.js').then((m) => ({ default: m.TokensView }))
);
const UsageView = lazy(() =>
  import('./views/UsageView.js').then((m) => ({ default: m.UsageView }))
);
const BillingView = lazy(() =>
  import('./views/BillingView.js').then((m) => ({ default: m.BillingView }))
);
const ResponsiveView = lazy(() =>
  import('./views/ResponsiveView.js').then((m) => ({
    default: m.ResponsiveView,
  }))
);
const AdminView = lazy(() =>
  import('./views/AdminView.js').then((m) => ({ default: m.AdminView }))
);
const ValueView = lazy(() =>
  import('./views/ValueView.js').then((m) => ({ default: m.ValueView }))
);
const GlassEngineView = lazy(() =>
  import('./views/GlassEngineView.js').then((m) => ({
    default: m.GlassEngineView,
  }))
);

const VIEWS: Record<ViewName, React.ComponentType> = {
  generation: GenerationView,
  projects: ProjectsView,
  lattice: LatticeView,
  tokens: TokensView,
  usage: UsageView,
  billing: BillingView,
  value: ValueView,
  responsive: ResponsiveView,
  admin: AdminView,
  'glass-engine': GlassEngineView,
};

/** Path the marketing CTAs hand off to, so sign-in is linkable and bookmarkable. */
const SIGN_IN_PATH = '/signin';
const COMPLIANCE_PATH = '/compliance';

export function App() {
  const { isAuthenticated, isLoading } = useAuth();
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingPrompt, setOnboardingPrompt] = useState('');
  const [showSignIn, setShowSignIn] = useState(
    () => window.location.pathname === SIGN_IN_PATH
  );
  const [view, setView] = useState<ViewName>(
    window.location.pathname === '/billing' ? 'billing' : 'generation'
  );

  // Detect first-time users and show onboarding
  useEffect(() => {
    if (isAuthenticated) {
      fetch('/api/pipeline', { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : { runs: [] }))
        .then((data: unknown) => {
          const obj = data as Record<string, unknown>;
          const runs = Array.isArray(data)
            ? data
            : Array.isArray(obj?.runs)
              ? obj.runs
              : [];
          if (runs.length === 0) {
            setShowOnboarding(true);
          }
        })
        .catch(() => {});
    }
  }, [isAuthenticated]);

  if (window.location.pathname === '/reset-password') {
    return <ResetPasswordScreen />;
  }

  // /legal/* renders standalone legal docs (no auth required)
  if (window.location.pathname.startsWith('/legal/')) {
    const slug = window.location.pathname.slice('/legal/'.length);
    return <LegalDocScreen slug={slug} />;
  }

  // /dmca is a shortcut alias for /legal/dmca (the DMCA designated-agent page)
  if (window.location.pathname === '/dmca') {
    return <LegalDocScreen slug="dmca" />;
  }

  if (isLoading) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          gap: '16px',
          color: 'var(--text-secondary)',
          background: 'var(--surface-base)',
        }}
      >
        <div
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            border: '3px solid var(--border-subtle)',
            borderTopColor: 'var(--color-accent)',
            animation: 'spin 0.8s linear infinite',
          }}
        />
        <span style={{ fontSize: '14px' }}>Loading your workspace…</span>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    );
  }

  // Logged-out visitors land on the marketing site at `/`; the auth form now
  // lives at `/signin` (both CTAs and the nav link point there). Any other
  // path still falls through to LoginScreen, so a signed-out user following a
  // deep link (e.g. /billing) is asked to sign in rather than being bounced
  // to the landing page.
  // `/compliance` is public and deliberately outside the auth check, for both
  // signed-in and signed-out visitors. A compliance surface only the operator
  // can read is a compliance surface nobody can check, which is most of the
  // point of publishing one. It serves verdicts, denominators and vendor names
  // — never gate logic, planning documents or tripwire signatures.
  if (window.location.pathname === COMPLIANCE_PATH) {
    return <ComplianceDashboard />;
  }

  if (!isAuthenticated) {
    // The logged-out surface used to be LoginScreen alone — one headline and a
    // signup form, with no way to learn what the product does or costs without
    // first creating an account. The marketing site now sits in front of it.
    // LoginScreen itself is unchanged and remains the only place credentials
    // are collected; every CTA routes here.
    //
    // Two cases have to reach the form even though `showSignIn` is false,
    // because both arrive on a path the CTA never set:
    //
    //   - `?verified=true` is the email-verification landing, and LoginScreen
    //     renders the "Email verified — you can sign in now" notice from it.
    //     New links point at /signin, but links already sitting in inboxes
    //     point at `/`, so that case must not be shown the landing page.
    //   - Any other path is a deep link (e.g. /billing) followed while signed
    //     out. Asking for credentials is the useful answer there; bouncing to
    //     the landing page loses where the user was going.
    const justVerified =
      new URLSearchParams(window.location.search).get('verified') === 'true';
    if (showSignIn || justVerified || window.location.pathname !== '/') {
      return <LoginScreen />;
    }
    return (
      <MarketingSite
        onSignIn={() => {
          window.history.pushState(null, '', SIGN_IN_PATH);
          setShowSignIn(true);
        }}
      />
    );
  }

  const ActiveView = VIEWS[view];
  const viewProps =
    view === 'generation' && onboardingPrompt
      ? { initialPrompt: onboardingPrompt }
      : {};

  return (
    <div className="app-shell" style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar active={view} onSelect={setView} />
      <main className="app-main" style={{ flex: 1, overflowY: 'auto' }}>
        <Suspense
          fallback={
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '60vh',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              <div
                style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '50%',
                  border: '3px solid var(--border-subtle)',
                  borderTopColor: 'var(--color-accent)',
                  animation: 'spin 0.8s linear infinite',
                }}
              />
              <span
                style={{ fontSize: '13px', color: 'var(--text-secondary)' }}
              >
                Loading view…
              </span>
              <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
            </div>
          }
        >
          <ActiveView {...(viewProps as Record<string, unknown>)} />
        </Suspense>
      </main>
      {showOnboarding && (
        <OnboardingFlow
          onComplete={(_intent, prompt) => {
            setShowOnboarding(false);
            setOnboardingPrompt(prompt);
            setView('generation');
          }}
        />
      )}
      <FluxyChatWidget />
    </div>
  );
}
