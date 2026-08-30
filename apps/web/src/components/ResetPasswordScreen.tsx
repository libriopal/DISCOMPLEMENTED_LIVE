/**
 * Password reset landing page — the destination for the link Better Auth
 * emails via useAuth().requestPasswordReset (redirectTo: `${origin}/reset-password?token=...`).
 * There's no client-side router in this app (see App.tsx), so App.tsx does
 * simple path-detection and renders this in place of the normal view switch
 * when the path is /reset-password. Styled to match LoginScreen.tsx.
 */
import { useState, type CSSProperties, type FormEvent } from 'react';
import { useAuth } from '../hooks/useAuth.js';

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '12px 16px',
  borderRadius: 'var(--radius-lg)',
  border: '1px solid var(--border-default)',
  background: 'var(--surface-base)',
  color: 'var(--text-primary)',
  fontSize: 14,
  fontFamily: 'var(--font-body)',
};

const labelStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--text-primary)',
  display: 'block',
  paddingBottom: 8,
  textAlign: 'left',
};

export function ResetPasswordScreen() {
  const { resetPassword } = useAuth();
  const token = new URLSearchParams(window.location.search).get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!token) {
      setFormError(
        'This reset link is missing its token. Request a new one from the sign-in screen.'
      );
      return;
    }
    if (password !== confirmPassword) {
      setFormError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await resetPassword({ newPassword: password, token });
      if (result?.error) {
        setFormError(result.error.message ?? 'Could not reset password.');
      } else {
        setDone(true);
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
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        gap: 'var(--space-6)',
        padding: 'var(--space-6)',
        textAlign: 'center',
      }}
    >
      <img src="/logo.png" alt="Discomplement" width={48} height={44} />
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
      <h1 style={{ fontSize: 32, letterSpacing: -0.64, maxWidth: 480 }}>
        Set a new password
      </h1>

      <div
        style={{
          width: '100%',
          maxWidth: 380,
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-card)',
          padding: 'var(--space-6)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        {done ? (
          <>
            <p style={{ fontSize: 14, color: 'var(--success)' }}>
              Your password has been reset. You can sign in with it now.
            </p>
            <a
              href="/"
              style={{
                padding: '12px 24px',
                borderRadius: 'var(--radius-pill)',
                border: 'none',
                background: 'var(--color-accent)',
                color: 'var(--surface-base)',
                fontSize: 15,
                textDecoration: 'none',
              }}
            >
              Back to sign in
            </a>
          </>
        ) : (
          <form
            onSubmit={(e) => void handleSubmit(e)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-3)',
            }}
          >
            {!token && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--danger)',
                  textAlign: 'left',
                }}
              >
                This link is missing its reset token. Go back and request a new
                one from the sign-in screen.
              </div>
            )}
            <div>
              <label style={labelStyle} htmlFor="reset-password">
                New password
              </label>
              <input
                id="reset-password"
                type="password"
                required
                minLength={12}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 12 characters"
                style={inputStyle}
                autoComplete="new-password"
              />
            </div>
            <div>
              <label style={labelStyle} htmlFor="reset-password-confirm">
                Confirm new password
              </label>
              <input
                id="reset-password-confirm"
                type="password"
                required
                minLength={12}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Retype your new password"
                style={inputStyle}
                autoComplete="new-password"
              />
            </div>

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

            <button
              type="submit"
              disabled={submitting || !token}
              style={{
                padding: '12px 24px',
                borderRadius: 'var(--radius-pill)',
                border: 'none',
                background: 'var(--color-accent)',
                color: 'var(--surface-base)',
                fontSize: 15,
                cursor: submitting ? 'default' : 'pointer',
                opacity: submitting || !token ? 0.6 : 1,
                transition: 'opacity var(--dur-fast) var(--ease-standard)',
              }}
            >
              {submitting ? 'Working...' : 'Reset password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
