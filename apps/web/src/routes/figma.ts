/**
 * Figma OAuth integration — allows users to connect their Figma account
 * and import design files as references for the prompt-to-app pipeline.
 *
 * Routes:
 *   GET  /api/figma/auth       — Redirect to Figma OAuth authorization
 *   GET  /api/figma/callback   — OAuth callback, exchange code for token
 *   GET  /api/figma/status     — Check if user has Figma connected
 *   POST /api/figma/disconnect — Revoke and remove Figma connection
 *   GET  /api/figma/files      — List user's recent Figma files
 *   POST /api/figma/import     — Import a Figma file as design reference
 *   GET  /api/figma/file/:key  — Get full file data from Figma API
 */
import { Hono } from 'hono';
import { BicameralError } from '@bicameral/shared/errors';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';

export const figmaRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

const FIGMA_AUTH_URL = 'https://www.figma.com/oauth';
const FIGMA_TOKEN_URL = 'https://www.figma.com/api/oauth/token';
const FIGMA_API_BASE = 'https://api.figma.com/v1';

// Required scopes for design import
const FIGMA_SCOPES = [
  'file_content:read',
  'file_metadata:read',
  'current_user:read',
].join(' ');

/**
 * GET /api/figma/auth — Redirects to Figma OAuth authorization page.
 * User must be authenticated to prevent CSRF.
 */
figmaRoutes.get('/auth', async (c) => {
  const userId = c.get('userId');

  const clientId = c.env.FIGMA_CLIENT_ID;
  if (!clientId) {
    throw new BicameralError(
      'Figma integration not configured',
      'INTEGRATION_NOT_CONFIGURED',
      503
    );
  }

  const redirectUri = `https://discomplemented.com/api/figma/callback`;
  const state = `${userId}:${crypto.randomUUID()}`;

  // Store state in KV for CSRF protection (10 min TTL)
  await c.env.CONFIG_KV.put(`figma_oauth_state:${state}`, userId, {
    expirationTtl: 600,
  });

  const authUrl = `${FIGMA_AUTH_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(FIGMA_SCOPES)}&state=${encodeURIComponent(state)}&response_type=code`;

  return c.redirect(authUrl);
});

/**
 * GET /api/figma/callback — OAuth callback. Exchanges code for token,
 * stores it in D1, redirects to the generation view.
 */
/**
 * Public OAuth callback handler — called from index.ts before auth middleware.
 * Resolves user from the OAuth state stored in KV (CSRF protection).
 */
export async function handleFigmaCallback(c: { env: Env; req: { query: (name: string) => string | undefined }; redirect: (url: string) => Response }): Promise<Response> {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    return c.redirect(`/generate?figma_error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return c.redirect('/generate?figma_error=missing_params');
  }

  // Verify state from KV (CSRF protection)
  const userId = await c.env.CONFIG_KV.get(`figma_oauth_state:${state}`);
  if (!userId) {
    return c.redirect('/generate?figma_error=invalid_state');
  }
  await c.env.CONFIG_KV.delete(`figma_oauth_state:${state}`);

  // Exchange code for token
  const tokenResponse = await fetch(FIGMA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: c.env.FIGMA_CLIENT_ID,
      client_secret: c.env.FIGMA_CLIENT_SECRET,
      redirect_uri: 'https://discomplemented.com/api/figma/callback',
      code,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenResponse.ok) {
    console.error('Figma token exchange failed:', await tokenResponse.text());
    return c.redirect('/generate?figma_error=token_exchange_failed');
  }

  const tokens = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  // Fetch user info from Figma
  const userResponse = await fetch(`${FIGMA_API_BASE}/me`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  let figmaUser: {
    id: string;
    email: string;
    handle: string;
    name: string;
  } | null = null;

  if (userResponse.ok) {
    figmaUser = (await userResponse.json()) as any;
  }

  // Store integration in D1
  const integrationId = crypto.randomUUID();
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  await c.env.DB.prepare(
    'UPDATE figma_integrations SET is_active = 0 WHERE user_id = ?'
  ).bind(userId).run();

  await c.env.DB.prepare(
    `INSERT INTO figma_integrations (id, user_id, figma_user_id, figma_user_name, figma_user_handle, figma_email, access_token, refresh_token, token_expires_at, scopes, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).bind(
    integrationId,
    userId,
    figmaUser?.id ?? null,
    figmaUser?.name ?? null,
    figmaUser?.handle ?? null,
    figmaUser?.email ?? null,
    tokens.access_token,
    tokens.refresh_token ?? null,
    expiresAt,
    FIGMA_SCOPES
  ).run();

  return c.redirect('/generate?figma_connected=true');
}

/**
 * GET /api/figma/status — Check if user has Figma connected.
 */
figmaRoutes.get('/status', async (c) => {
  const userId = c.get('userId');

  const integration = await c.env.DB.prepare(
    'SELECT figma_user_name, figma_user_handle, figma_email, created_date FROM figma_integrations WHERE user_id = ? AND is_active = 1'
  ).bind(userId).first();

  if (!integration) {
    return c.json({ connected: false });
  }

  return c.json({
    connected: true,
    user: {
      name: integration.figma_user_name,
      handle: integration.figma_user_handle,
      email: integration.figma_email,
    },
    connectedAt: integration.created_date,
  });
});

/**
 * POST /api/figma/disconnect — Revoke and remove Figma connection.
 */
figmaRoutes.post('/disconnect', async (c) => {
  const userId = c.get('userId');

  const integration = await c.env.DB.prepare(
    'SELECT access_token FROM figma_integrations WHERE user_id = ? AND is_active = 1'
  ).bind(userId).first<{ access_token: string }>();

  if (!integration) {
    return c.json({ disconnected: true });
  }

  // Revoke token at Figma
  try {
    await fetch(`${FIGMA_API_BASE}/oauth/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${integration.access_token}` },
    });
  } catch {
    // Best effort — deactivate locally regardless
  }

  await c.env.DB.prepare(
    'UPDATE figma_integrations SET is_active = 0 WHERE user_id = ?'
  ).bind(userId).run();

  return c.json({ disconnected: true });
});

/**
 * GET /api/figma/files — List user's recent Figma files.
 */
figmaRoutes.get('/files', async (c) => {
  const userId = c.get('userId');

  const integration = await c.env.DB.prepare(
    'SELECT access_token FROM figma_integrations WHERE user_id = ? AND is_active = 1'
  ).bind(userId).first<{ access_token: string }>();

  if (!integration) {
    throw new BicameralError(
      'Figma not connected',
      'FIGMA_NOT_CONNECTED',
      401
    );
  }

  const response = await fetch(`${FIGMA_API_BASE}/me/files`, {
    headers: { Authorization: `Bearer ${integration.access_token}` },
  });

  if (!response.ok) {
    throw new BicameralError(
      'Failed to fetch Figma files',
      'FIGMA_API_ERROR',
      response.status
    );
  }

  const data = await response.json();
  return c.json(data);
});

/**
 * GET /api/figma/file/:key — Get full file data from Figma API.
 * Used by the pipeline to extract design tokens, layout, and component structure.
 */
figmaRoutes.get('/file/:key', async (c) => {
  const userId = c.get('userId');
  const fileKey = c.req.param('key');
  const nodeId = c.req.query('node_id');

  const integration = await c.env.DB.prepare(
    'SELECT access_token FROM figma_integrations WHERE user_id = ? AND is_active = 1'
  ).bind(userId).first<{ access_token: string }>();

  if (!integration) {
    throw new BicameralError(
      'Figma not connected',
      'FIGMA_NOT_CONNECTED',
      401
    );
  }

  const url = nodeId
    ? `${FIGMA_API_BASE}/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`
    : `${FIGMA_API_BASE}/files/${fileKey}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${integration.access_token}` },
  });

  if (!response.ok) {
    throw new BicameralError(
      'Failed to fetch Figma file',
      'FIGMA_API_ERROR',
      response.status
    );
  }

  const data = await response.json();
  return c.json(data);
});

/**
 * POST /api/figma/import — Import a Figma file as a design reference.
 * Stores the import metadata for use by the pipeline.
 */
figmaRoutes.post('/import', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{
    figma_file_key: string;
    figma_file_name?: string;
    figma_file_url?: string;
    node_id?: string;
    pipeline_run_id?: string;
  }>();

  if (!body.figma_file_key) {
    throw new BicameralError(
      'figma_file_key is required',
      'VALIDATION_ERROR',
      400
    );
  }

  const integration = await c.env.DB.prepare(
    'SELECT access_token FROM figma_integrations WHERE user_id = ? AND is_active = 1'
  ).bind(userId).first<{ access_token: string }>();

  if (!integration) {
    throw new BicameralError(
      'Figma not connected',
      'FIGMA_NOT_CONNECTED',
      401
    );
  }

  // Fetch file metadata from Figma to extract design info
  const fileUrl = body.node_id
    ? `${FIGMA_API_BASE}/files/${body.figma_file_key}/nodes?ids=${encodeURIComponent(body.node_id)}`
    : `${FIGMA_API_BASE}/files/${body.figma_file_key}`;

  const response = await fetch(fileUrl, {
    headers: { Authorization: `Bearer ${integration.access_token}` },
  });

  let importMetadata: string | null = null;
  if (response.ok) {
    const fileData = await response.json() as Record<string, any>;
    // Extract key design info: styles, components, layout structure
    importMetadata = JSON.stringify({
      fileKey: body.figma_file_key,
      fileName: fileData.name || body.figma_file_name,
      lastModified: fileData.lastModified,
      schemaVersion: fileData.schemaVersion,
      styles: fileData.styles || {},
      components: Object.keys(fileData.components || {}),
      document: fileData.document || (body.node_id ? fileData.nodes?.[0]?.document : null),
    });
  }

  const importId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO figma_imports (id, user_id, figma_file_key, figma_file_name, figma_file_url, node_id, import_metadata, pipeline_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    importId,
    userId,
    body.figma_file_key,
    body.figma_file_name ?? null,
    body.figma_file_url ?? null,
    body.node_id ?? null,
    importMetadata,
    body.pipeline_run_id ?? null
  ).run();

  return c.json({
    imported: true,
    import_id: importId,
    has_metadata: !!importMetadata,
  });
});
