/**
 * @bicameral/admin-stub — Open-source fallback for @bicameral/admin
 *
 * This package mirrors the exports of @bicameral/admin but throws
 * "admin module required" for all operations. It lets the public repo
 * build and run in a degraded mode for open-source contributors who
 * don't have access to the private admin package.
 *
 * When the full private monorepo is used (internal development),
 * package.json aliases @bicameral/admin to packages/admin/ and
 * this stub is never loaded.
 *
 * When the public repo is released (git filter-repo strips packages/admin/),
 * this stub is the only admin implementation available. External
 * contributors can implement these interfaces for their own deployment.
 */

export {
  stripeWebhookHandler,
  createSubscription,
  cancelSubscription,
  getSubscription,
  deductCredits,
  checkCredits,
  resetCredits,
  checkTierAccess,
  getModelForTier,
} from './billing/index.js';

export {
  approvalGate,
  aiAuditor,
  verifyEvidence,
  researchFreeze,
  enforceAutonomyLevel,
} from './governance/index.js';

export {
  banUser,
  suspendUser,
  promoteUser,
  moderateProject,
  overrideDeploy,
} from './admin-ops/index.js';
