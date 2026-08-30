/**
 * Frontend Better Auth client — talks to the `/api/auth/*` routes mounted
 * by routes/auth.ts. Used by hooks/useAuth.ts.
 */
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  baseURL: typeof window !== 'undefined' ? window.location.origin : undefined,
  basePath: '/api/auth',
});

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  getSession,
  requestPasswordReset,
  resetPassword,
} = authClient;
