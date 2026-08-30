/**
 * @bicameral/shared — Typed error classes
 * Consistent error taxonomy across the monorepo
 */

export class BicameralError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'BicameralError';
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }
}

export class AuthError extends BicameralError {
  constructor(message = 'Unauthorized', code = 'AUTH_ERROR', details?: Record<string, unknown>) {
    super(message, code, 401, details);
    this.name = 'AuthError';
  }
}

export class CreditsError extends BicameralError {
  constructor(message = 'Insufficient credits', details?: Record<string, unknown>) {
    super(message, 'INSUFFICIENT_CREDITS', 402, details);
    this.name = 'CreditsError';
  }
}

export class TierError extends BicameralError {
  constructor(message = 'Tier level insufficient', details?: Record<string, unknown>) {
    super(message, 'TIER_INSUFFICIENT', 403, details);
    this.name = 'TierError';
  }
}

export class RateLimitError extends BicameralError {
  constructor(message = 'Rate limit exceeded', details?: Record<string, unknown>) {
    super(message, 'RATE_LIMITED', 429, details);
    this.name = 'RateLimitError';
  }
}

export class CohereError extends BicameralError {
  constructor(message = 'Cohere API error', code = 'COHERE_ERROR', statusCode = 502, details?: Record<string, unknown>) {
    super(message, code, statusCode, details);
    this.name = 'CohereError';
  }
}

export class GenerationError extends BicameralError {
  constructor(message = 'Generation failed', code = 'GENERATION_ERROR', details?: Record<string, unknown>) {
    super(message, code, 500, details);
    this.name = 'GenerationError';
  }
}

export class LatticeError extends BicameralError {
  constructor(message = 'Lattice operation failed', code = 'LATTICE_ERROR', details?: Record<string, unknown>) {
    super(message, code, 500, details);
    this.name = 'LatticeError';
  }
}

export class GovernanceError extends BicameralError {
  constructor(message = 'Governance violation', code = 'GOVERNANCE_ERROR', statusCode = 403, details?: Record<string, unknown>) {
    super(message, code, statusCode, details);
    this.name = 'GovernanceError';
  }
}

export class ResearchError extends BicameralError {
  constructor(message = 'Research operation failed', code = 'RESEARCH_ERROR', details?: Record<string, unknown>) {
    super(message, code, 500, details);
    this.name = 'ResearchError';
  }
}

export class ValidationError extends BicameralError {
  constructor(message = 'Validation failed', code = 'VALIDATION_ERROR', statusCode = 400, details?: Record<string, unknown>) {
    super(message, code, statusCode, details);
    this.name = 'ValidationError';
  }
}
