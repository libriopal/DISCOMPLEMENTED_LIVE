/** EICCA — Emergency credit contracts + repayment webhook. */
import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { AuthVariables } from '../lib/require-auth.js';
import { BicameralError } from '@bicameral/shared/errors';
import {
  offerContract,
  consentContract,
  cancelContract,
  getContract,
  listContracts,
  processRepayment,
} from '../lib/eicca.js';

// Webhook routes — mounted BEFORE requireAuth in index.ts.
// Uses x-eicca-webhook-secret header for auth, not session.
export const eiccaWebhookRoutes = new Hono<{ Bindings: Env }>();

eiccaWebhookRoutes.post('/', async (c) => {
  const secret = c.req.header('x-eicca-webhook-secret');
  if (!secret)
    throw new BicameralError('Missing webhook secret', 'AUTH_ERROR', 403);

  const expected = c.env.EICCA_WEBHOOK_SECRET;
  const encoder = new TextEncoder();
  const a = encoder.encode(secret);
  const b = encoder.encode(expected);
  if (a.length !== b.length)
    throw new BicameralError('Invalid webhook secret', 'AUTH_ERROR', 403);

  // Constant-time comparison (Web Crypto lacks timingSafeEqual)
  let valid = a.length === b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) valid = false;
  }
  if (!valid)
    throw new BicameralError('Invalid webhook secret', 'AUTH_ERROR', 403);

  const body = await c.req.json();
  const { contractId, revenueBase, sharePercent, periodStart, periodEnd } =
    body;

  await processRepayment(
    c.env.DB,
    contractId,
    revenueBase,
    sharePercent,
    periodStart,
    periodEnd
  );
  return c.json({ status: 'ok' });
});

// User-facing routes — mounted AFTER requireAuth in index.ts.
export const eiccaRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

eiccaRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const contracts = await listContracts(c.env.DB, userId);
  return c.json({ contracts });
});

eiccaRoutes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const contract = await getContract(c.env.DB, c.req.param('id'));
  if (!contract)
    throw new BicameralError('Contract not found', 'NOT_FOUND', 404);
  if (contract.user_id !== userId)
    throw new BicameralError('Not your contract', 'AUTH_ERROR', 403);
  return c.json({ contract });
});

eiccaRoutes.post('/:id/consent', async (c) => {
  const userId = c.get('userId');
  const ip = c.req.header('cf-connecting-ip') || 'unknown';
  const sessionToken = c.req.header('cookie') || 'unknown';
  const contract = await consentContract(
    c.env.DB,
    c.req.param('id'),
    userId,
    ip,
    sessionToken
  );
  return c.json({ contract });
});

eiccaRoutes.post('/:id/cancel', async (c) => {
  const userId = c.get('userId');
  await cancelContract(c.env.DB, c.req.param('id'), userId);
  return c.json({ status: 'cancelled' });
});
