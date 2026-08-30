/**
 * Account Flagger — three-strike abuse enforcement.
 *
 * When a malicious intent tripwire fires, this system:
 * 1. Records the flag in D1
 * 2. Increments the user's strike count
 * 3. Applies the appropriate action (warn/suspend/ban)
 * 4. Reports severe violations to law enforcement
 *
 * Integration with Monte Carlo:
 * - Banned accounts get VDR = 0% (banned personas in Monte Carlo)
 * - Flagged accounts are tracked for behavioral analysis
 */

import type { MaliciousPattern } from '../tripwires/malicious-intent.js';

export type AccountStatus = 'active' | 'warned' | 'suspended' | 'banned';

export interface AccountFlag {
  userId: string;
  severity: 'warning' | 'suspension' | 'ban';
  reason: string;
  patternId: string;
  category: string;
  timestamp: number;
  strikeCount: number;
  status: AccountStatus;
}

export interface FlagResult {
  denied: boolean;
  flagged: boolean;
  reported: boolean;
  newStatus: AccountStatus;
  strikeCount: number;
  message: string;
}

/**
 * Process a malicious pattern detection.
 * This is called when scanPromptRegex returns a match.
 */
export function processMaliciousDetection(
  userId: string,
  pattern: MaliciousPattern,
  currentStrikeCount: number
): FlagResult {
  const isSevere = pattern.action === 'deny+flag+report';
  const isCritical = pattern.severity === 'critical';

  // Severe violations: immediate ban, no strikes
  if (isSevere) {
    return {
      denied: true,
      flagged: true,
      reported: true,
      newStatus: 'banned',
      strikeCount: currentStrikeCount + 1,
      message: `Account banned: ${pattern.description}. This violation has been reported to the appropriate authorities.`,
    };
  }

  // Critical violations: three-strike policy
  const newStrikeCount = currentStrikeCount + 1;
  let newStatus: AccountStatus;
  let message: string;

  if (newStrikeCount >= 3) {
    newStatus = 'banned';
    message = `Account permanently banned after ${newStrikeCount} violations. Pattern: ${pattern.description}`;
  } else if (newStrikeCount === 2) {
    newStatus = 'suspended';
    message = `Account suspended for 7 days (strike ${newStrikeCount}/3). Pattern: ${pattern.description}`;
  } else {
    newStatus = 'warned';
    message = `Warning (strike ${newStrikeCount}/3): ${pattern.description}. Further violations will result in suspension or ban.`;
  }

  return {
    denied: true,
    flagged: true,
    reported: false,
    newStatus,
    strikeCount: newStrikeCount,
    message,
  };
}

/**
 * D1 migration for account flags table.
 */
export const ACCOUNT_FLAGS_MIGRATION = `
CREATE TABLE IF NOT EXISTS account_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  pattern_id TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  description TEXT,
  strike_count INTEGER DEFAULT 1,
  status TEXT DEFAULT 'warned',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_account_flags_user ON account_flags(user_id);
CREATE INDEX IF NOT EXISTS idx_account_flags_status ON account_flags(status);
`;

/**
 * NCMEC reporting info for CSAM violations.
 * Per 18 U.S.C. § 2258A, electronic service providers must report
 * apparent CSAM to NCMEC CyberTipline.
 */
/**
 * CSAM GAG ORDER (18 U.S.C. § 2258A(d)):
 * Providers are STRICTLY PROHIBITED from notifying the user or any
 * third party that a CSAM report has been submitted to NCMEC.
 * Do NOT include any mention of the report in the user-facing message.
 * The user-facing message should only say "Account banned for violation of Acceptable Use Policy."
 */
export const NCMEC_REPORTING = {
  url: 'https://report.cybertip.org',
  phone: '1-800-843-5678',
  // In production: POST to NCMEC CyberTipline API
};

/**
 * Counter-Notice Process (17 U.S.C. § 512(g))
 *
 * Users who receive a strike may submit a counter-notification to dispute the flag.
 * Counter-notifications must include:
 * 1. Identification of the removed content
 * 2. Statement of good-faith belief that the flag was mistaken
 * 3. User's contact info
 * 4. Consent to local federal court jurisdiction
 * 5. Physical or electronic signature
 *
 * Email: counter-notice@discomplemented.com
 * Response: 10-14 business days. If no lawsuit is filed, the strike is removed.
 */
export const COUNTER_NOTICE_INFO = {
  email: 'counter-notice@discomplemented.com',
  responseDays: 14,
  process:
    'Submit counter-notification with the 5 required elements above. If no copyright lawsuit is filed within 14 business days, the strike is removed and content restored.',
};
