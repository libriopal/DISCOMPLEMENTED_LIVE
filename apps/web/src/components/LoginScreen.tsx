/**
 * Login screen — GitHub OAuth (original flow) plus email/username/password
 * sign-up and sign-in, added alongside it. See design/07-astroapp-concept.html
 * for the look-and-feel this approximates (dark hero, single accent CTA),
 * and design/04-component-library.html §02 "Inputs & Forms" for the input/
 * button shapes this reuses (16px radius inputs, pill-radius primary CTA,
 * --border-default / --color-accent tokens from styles/tokens.css).
 *
 * Consent gate (vault_commercial_launch_plan.md §4): neither flow previously
 * captured ToS/Privacy consent at all. Both now share one required,
 * unchecked-by-default checkbox above the CTAs — checking it is a
 * precondition for the GitHub redirect firing (useAuth.signInWithGitHub
 * throws if it isn't set) just as it is for email sign-up.
 */
import { useState, type CSSProperties, type FormEvent } from 'react';
import { useAuth } from '../hooks/useAuth.js';

const linkButtonStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  fontSize: 12,
  color: 'var(--text-secondary)',
  textDecoration: 'underline',
  cursor: 'pointer',
};

type Mode = 'signup' | 'signin';

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '12px 16px',
  borderRadius: 'var(--radius-lg)',
  border: '1px solid var(--border-default)',
  background: 'var(--surface-base)',
  color: 'var(--text-primary)',
  // 16px is a floor, not a preference. Mobile Safari zooms the page in when a
  // focused input is under 16px and does not zoom back out, so the first tap on
  // the sign-in form leaves the visitor on a page they have to pinch to escape.
  // Measured at 390x844: these were 14px and 43px tall.
  //
  // Fixed here rather than in `styles/dual-theme.css`, which carries the same
  // floor for every other input on the site: this is an inline style, and no
  // stylesheet rule can beat one without `!important`. The CSS floor was in
  // place and losing silently — which is the whole argument for measuring the
  // rendered page instead of reading the sheet.
  fontSize: 16,
  minHeight: 44,
  fontFamily: 'var(--font-body)',
};

const labelStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--text-primary)',
  display: 'block',
  paddingBottom: 8,
  textAlign: 'left',
};

export function LoginScreen() {
  const {
    signInWithGitHub,
    signUpWithEmail,
    signInWithEmail,
    requestPasswordReset,
    isLoading,
  } = useAuth();

  const [mode, setMode] = useState<Mode>('signup');
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [forgotPassword, setForgotPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(
    new URLSearchParams(window.location.search).get('verified') === 'true'
      ? 'Email verified — you can sign in now.'
      : null
  );

  const handleGitHub = () => {
    setFormError(null);
    try {
      // The consent checkbox only renders in signup mode — a signin-mode
      // GitHub click means an existing account that already agreed at
      // signup, so it doesn't need a fresh capture here.
      void signInWithGitHub(mode === 'signup' ? agreedToTerms : true);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Please agree to the terms first.'
      );
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setNotice(null);

    if (forgotPassword) {
      setSubmitting(true);
      try {
        await requestPasswordReset(email);
        setNotice('If that email has an account, a reset link is on its way.');
      } catch (err) {
        setFormError(
          err instanceof Error ? err.message : 'Something went wrong.'
        );
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (mode === 'signup' && password !== confirmPassword) {
      setFormError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'signup') {
        const result = await signUpWithEmail({
          email,
          password,
          name: name || email.split('@')[0],
          agreedToTerms,
        });
        if (result?.error) {
          setFormError(result.error.message ?? 'Sign up failed.');
        } else if (
          (result?.data as { emailDeliveryFailed?: boolean } | undefined)
            ?.emailDeliveryFailed
        ) {
          setNotice(
            "Account created, but we couldn't send your verification email right now. Contact support and we'll verify your account manually."
          );
        } else {
          setNotice(
            'Check your email to verify your account before signing in.'
          );
        }
      } else {
        const result = await signInWithEmail({ email, password });
        if (result?.error) {
          setFormError(result.error.message ?? 'Sign in failed.');
        }
      }
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Something went wrong.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100dvh',
        width: '100%',
        maxWidth: '100vw',
        boxSizing: 'border-box',
        gap: 'clamp(16px, 4vw, var(--space-6))',
        padding: 'clamp(16px, 5vw, var(--space-6))',
        textAlign: 'center',
        overflowX: 'hidden',
      }}
    >
      <img src="/logo.png" alt="Discomplement" width={64} height={58} />
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: 0.28,
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
        }}
      >
        Discomplement
      </div>
      <h1
        style={{
          fontSize: 'clamp(28px, 7vw, 48px)',
          lineHeight: 1.15,
          letterSpacing: -0.96,
          maxWidth: 640,
          width: '100%',
        }}
      >
        Your autonomous dev team, from idea to deployed app.
      </h1>
      <p
        style={{
          color: 'var(--text-secondary)',
          maxWidth: 480,
          width: '100%',
          fontSize: 'clamp(13px, 3.2vw, 16px)',
        }}
      >
        The researcher, designer, and coder agents do the thinking before any
        code gets written — and you approve the blueprint first.
      </p>

      <div
        style={{
          width: '100%',
          maxWidth: 380,
          boxSizing: 'border-box',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-card)',
          padding: 'clamp(16px, 4vw, var(--space-6))',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        <div
          style={{
            display: 'flex',
            borderRadius: 'var(--radius-pill)',
            border: '1px solid var(--border-default)',
            padding: 4,
          }}
        >
          {(['signup', 'signin'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setForgotPassword(false);
                setFormError(null);
                setNotice(null);
              }}
              style={{
                flex: 1,
                border: 'none',
                borderRadius: 'var(--radius-pill)',
                padding: '8px 0',
                fontSize: 13,
                cursor: 'pointer',
                background: mode === m ? 'var(--color-accent)' : 'transparent',
                color:
                  mode === m ? 'var(--surface-base)' : 'var(--text-secondary)',
                transition: 'background var(--dur-fast) var(--ease-standard)',
              }}
            >
              {m === 'signup' ? 'Sign up' : 'Sign in'}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => void handleSubmit(e)}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}
        >
          {mode === 'signup' && (
            <div>
              <label style={labelStyle} htmlFor="login-name">
                Name
              </label>
              <input
                id="login-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ada Lovelace"
                style={inputStyle}
                autoComplete="name"
              />
            </div>
          )}
          <div>
            <label style={labelStyle} htmlFor="login-email">
              Email
            </label>
            <input
              id="login-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              style={inputStyle}
              autoComplete="email"
            />
          </div>
          {!forgotPassword && (
            <div>
              <label style={labelStyle} htmlFor="login-password">
                Password
              </label>
              <input
                id="login-password"
                type="password"
                required
                minLength={mode === 'signup' ? 12 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  mode === 'signup' ? 'At least 12 characters' : 'Password'
                }
                style={inputStyle}
                autoComplete={
                  mode === 'signup' ? 'new-password' : 'current-password'
                }
              />
            </div>
          )}

          {mode === 'signup' && !forgotPassword && (
            <div>
              <label style={labelStyle} htmlFor="login-password-confirm">
                Confirm password
              </label>
              <input
                id="login-password-confirm"
                type="password"
                required
                minLength={12}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Retype your password"
                style={inputStyle}
                autoComplete="new-password"
              />
            </div>
          )}

          {mode === 'signin' && (
            <button
              type="button"
              style={{ ...linkButtonStyle, textAlign: 'left' }}
              onClick={() => {
                setForgotPassword((v) => !v);
                setFormError(null);
                setNotice(null);
              }}
            >
              {forgotPassword ? 'Back to sign in' : 'Forgot password?'}
            </button>
          )}

          {formError && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--danger)',
                textAlign: 'left',
              }}
            >
              {formError}
            </div>
          )}
          {notice && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--success)',
                textAlign: 'left',
              }}
            >
              {notice}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || (mode === 'signup' && !agreedToTerms)}
            style={{
              padding: '12px 24px',
              borderRadius: 'var(--radius-pill)',
              border: 'none',
              background: 'var(--color-accent)',
              color: 'var(--surface-base)',
              fontSize: 15,
              cursor: submitting ? 'default' : 'pointer',
              opacity:
                submitting || (mode === 'signup' && !agreedToTerms) ? 0.6 : 1,
              transition: 'opacity var(--dur-fast) var(--ease-standard)',
            }}
          >
            {submitting
              ? 'Working...'
              : forgotPassword
                ? 'Send reset link'
                : mode === 'signup'
                  ? 'Create account'
                  : 'Sign in'}
          </button>
        </form>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            color: 'var(--text-secondary)',
            fontSize: 12,
          }}
        >
          <div
            style={{ flex: 1, height: 1, background: 'var(--border-default)' }}
          />
          or
          <div
            style={{ flex: 1, height: 1, background: 'var(--border-default)' }}
          />
        </div>

        {mode === 'signup' && (
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              fontSize: 12,
              color: 'var(--text-secondary)',
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={agreedToTerms}
              onChange={(e) => setAgreedToTerms(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              I agree to the{' '}
              <a href="/legal/terms" target="_blank" rel="noreferrer">
                Terms of Service
              </a>{' '}
              and{' '}
              <a href="/legal/privacy" target="_blank" rel="noreferrer">
                Privacy Policy
              </a>{' '}
              — required for both email sign-up and continuing with GitHub.
            </span>
          </label>
        )}

        <button
          onClick={handleGitHub}
          disabled={isLoading || (mode === 'signup' && !agreedToTerms)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'var(--space-2)',
            padding: '12px 24px',
            borderRadius: 'var(--radius-pill)',
            border: '1px solid var(--border-default)',
            background: 'transparent',
            color: 'var(--text-primary)',
            fontSize: 15,
            cursor: isLoading ? 'default' : 'pointer',
            opacity:
              isLoading || (mode === 'signup' && !agreedToTerms) ? 0.6 : 1,
            transition: 'opacity var(--dur-fast) var(--ease-standard)',
          }}
        >
          {isLoading ? 'Loading...' : 'Continue with GitHub'}
        </button>
      </div>
    </main>
  );
}
