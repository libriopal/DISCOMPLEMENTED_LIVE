/**
 * React auth hook — wraps Better Auth's `useSession` with sign-in/sign-out
 * helpers for both supported flows: GitHub OAuth and email/password.
 *
 * Consent gate: neither Better Auth's social provider redirect nor its
 * emailAndPassword sign-up captures ToS/Privacy consent on its own (Better
 * Auth has no built-in consent field), so every entry point here requires
 * the caller to have already captured an affirmative, unchecked-by-default
 * checkbox — see components/LoginScreen.tsx, the only current call site.
 * `signInWithGitHub`/`signUpWithEmail` both throw if `agreedToTerms` isn't
 * true, so a future call site can't silently skip the gate.
 */
import { useCallback } from 'react';
import {
  authClient,
  signIn,
  signUp,
  signOut,
  requestPasswordReset as requestPasswordResetClient,
  resetPassword as resetPasswordClient,
  useSession,
} from '../lib/auth-client.js';

function assertConsent(agreedToTerms: boolean): void {
  if (!agreedToTerms) {
    throw new Error(
      'Cannot sign up/in without agreeing to the Terms of Service and Privacy Policy.'
    );
  }
}

export function useAuth() {
  const { data: session, isPending, error, refetch } = useSession();

  const signInWithGitHub = useCallback((agreedToTerms: boolean) => {
    assertConsent(agreedToTerms);
    return signIn.social({ provider: 'github', callbackURL: '/' });
  }, []);

  const signUpWithEmail = useCallback(
    (params: {
      email: string;
      password: string;
      name: string;
      agreedToTerms: boolean;
    }) => {
      assertConsent(params.agreedToTerms);
      return signUp.email({
        email: params.email,
        password: params.password,
        name: params.name,
        // Threaded through to the verification email's link (Better Auth
        // appends it as the /verify-email endpoint's redirect target) so a
        // clicked link lands back on a friendly notice instead of Better
        // Auth's raw API JSON response — see LoginScreen's `verified` check.
        // /signin, not /, since `/` is the marketing landing page now — the
        // verified notice belongs on the screen that has the sign-in form.
        callbackURL: `${window.location.origin}/signin?verified=true`,
      });
    },
    []
  );

  // Sign-in itself doesn't need a fresh consent capture — the account
  // already agreed at sign-up — so it takes no agreedToTerms param.
  const signInWithEmail = useCallback(
    async (params: { email: string; password: string }) => {
      const result = await signIn.email({
        email: params.email,
        password: params.password,
      });
      await refetch();
      return result;
    },
    [refetch]
  );

  const requestPasswordReset = useCallback((email: string) => {
    return requestPasswordResetClient({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    });
  }, []);

  // Consumed by ResetPasswordScreen — the token comes from the emailed
  // link's query string, not from an authenticated session.
  const resetPassword = useCallback(
    (params: { newPassword: string; token: string }) => {
      return resetPasswordClient(params);
    },
    []
  );

  const signOutUser = useCallback(async () => {
    await signOut();
    await refetch();
  }, [refetch]);

  return {
    user: session?.user ?? null,
    isAuthenticated: !!session?.user,
    isLoading: isPending,
    error,
    signInWithGitHub,
    signUpWithEmail,
    signInWithEmail,
    requestPasswordReset,
    resetPassword,
    signOut: signOutUser,
    client: authClient,
  };
}
