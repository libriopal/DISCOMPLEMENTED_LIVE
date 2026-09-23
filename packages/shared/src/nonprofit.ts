/**
 * The nonprofit grant.
 *
 * A GRANT, not a discount, and the distinction is the whole design. The evolved
 * genome carries both `nonprofit_discount: 94` and
 * `team_billing_model: 'nonprofit-free'`, and for a while the plan for this
 * feature carried both economics at once — a 94% discount AND a free grant AND
 * a third value of 59 sitting in the admin billing package. Three economics,
 * one buyer. A cross-vendor audit round caught it; this module is the decision.
 *
 * WHAT A BUYER EXPERIENCES: a qualifying nonprofit is provisioned at the team
 * tier and billed nothing. No discount is computed, applied, or displayed, and
 * no discount figure may reach a pricing surface — there is no price to
 * discount from.
 *
 * `nonprofit_discount` is a SIMULATOR PARAMETER. It was evolved by the
 * Butterfly runs to explore pricing topology; it is not a price and never was.
 * That is exactly why its disagreement with the admin package's 59 could sit
 * unnoticed for so long: no buyer ever saw either number.
 *
 * ELIGIBILITY IS A CHECKABLE RULE, not a coupon code. A 94%-off code with no
 * eligibility test is a code that leaks to everyone who wants it; a grant is
 * recorded per account, against evidence, reviewable and revocable.
 */

/** What a granted nonprofit account actually receives. */
export const NONPROFIT_GRANT = {
  /** The tier a granted account is provisioned at. */
  tier: 'nonprofit',
  /** What the account is billed. Zero, by design — see the module docstring. */
  billedUsdCents: 0,
  /** The tier whose limits this grant mirrors, so the two cannot drift. */
  mirrors: 'team',
} as const;

/** The forms of evidence a grant may be recorded against. */
export const ELIGIBILITY_EVIDENCE = [
  '501c3', // US tax-exempt determination letter
  'charity-commission', // UK/EW registered charity number
  'acnc', // Australian charities register
  'eu-npo', // EU member-state non-profit registration
  'other-documented', // anything else, with a note and a named reviewer
] as const;

export type EligibilityEvidence = (typeof ELIGIBILITY_EVIDENCE)[number];

export interface NonprofitGrant {
  accountId: string;
  evidence: EligibilityEvidence;
  /** Free text: registration number, jurisdiction, or why `other-documented`. */
  reference: string;
  /** Who approved it. A grant with no named approver is not a grant. */
  grantedBy: string;
  grantedAt: string;
  /** Set when withdrawn. A grant is revocable or it is not a grant. */
  revokedAt?: string;
  revokedReason?: string;
}

/**
 * Is this grant currently in force?
 *
 * Deliberately not "does a row exist". A revoked grant is a row that exists,
 * and billing an account at zero because a withdrawn grant was still on file
 * is the failure this function is shaped to prevent.
 */
export function grantIsActive(
  grant: NonprofitGrant | null | undefined
): boolean {
  if (!grant) return false;
  if (grant.revokedAt) return false;
  // A grant with no named approver is not attributable and does not count.
  return Boolean(grant.grantedBy && grant.grantedBy.trim());
}
