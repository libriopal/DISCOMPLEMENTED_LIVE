# Cookie & Session Notice — Bicameral (discomplement)

**DRAFT — not yet reviewed by a lawyer.** See `vault/vault_commercial_launch_plan.md` §4.

_Last drafted: 2026-08-11._

Bicameral uses one essential, functionally-required cookie: a session cookie set by our authentication system (Better Auth) when you sign in, used to keep you logged in across requests. This cookie is not optional — the Service cannot function without it, so we don't present a cookie-consent banner for it (consistent with guidance that strictly necessary cookies don't require opt-in consent under most cookie-law frameworks).

We do not currently use third-party advertising or cross-site tracking cookies. If that changes in the future, this notice will be updated and a consent mechanism will be added before any such cookies are set.

Session cookies are `HttpOnly` and `Secure` in production, and scoped to our domain only (`SameSite`). You can end your session at any time by logging out, which clears the cookie.
