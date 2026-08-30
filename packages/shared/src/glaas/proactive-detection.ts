import { EVOLVED_GENOME } from './ns3-system-instruction';

export interface UserHealthScore {
  user_id: string;
  overall_score: number;
  engagement_score: number;
  feature_adoption_score: number;
  support_sentiment_score: number;
  payment_health_score: number;
  vdr_score: number;
  risk_level: 'healthy' | 'at-risk' | 'critical';
  detected_issues: string[];
  recommended_actions: string[];
  last_updated: string;
}

export function calculateHealthScore(params: {
  login_frequency_30d: number;
  login_frequency_baseline: number;
  core_feature_usage_30d: number;
  core_feature_usage_baseline: number;
  support_sentiment_score: number;
  failed_payments_30d: number;
  vdr: number;
}): UserHealthScore {
  const issues: string[] = [];
  const actions: string[] = [];

  const engagement_ratio =
    params.login_frequency_baseline > 0
      ? params.login_frequency_30d / params.login_frequency_baseline
      : 1;
  const engagement_score = Math.min(1, Math.max(0, engagement_ratio));
  if (engagement_score < 0.5) {
    issues.push(
      `Login frequency dropped ${Math.round((1 - engagement_ratio) * 100)}%`
    );
    actions.push('Send re-engagement email');
  }

  const feature_ratio =
    params.core_feature_usage_baseline > 0
      ? params.core_feature_usage_30d / params.core_feature_usage_baseline
      : 1;
  const feature_adoption_score = Math.min(1, Math.max(0, feature_ratio));
  if (feature_adoption_score < 0.4) {
    issues.push('Core feature usage below baseline');
    actions.push('Trigger interactive tutorial');
  }

  const support_sentiment_score = params.support_sentiment_score;
  if (support_sentiment_score < 0.3) {
    issues.push('Negative sentiment in support');
    actions.push('Escalate to customer success');
  }

  const payment_health_score =
    params.failed_payments_30d === 0
      ? 1
      : Math.max(0, 1 - params.failed_payments_30d * 0.2);
  if (params.failed_payments_30d > 0) {
    issues.push(`${params.failed_payments_30d} failed payment(s)`);
    actions.push('Send payment notification');
  }

  // P2: VDR thresholds from v6 honest Monte Carlo (NOT aspirational 70%)
  // 50% = rollback threshold (critically low)
  // 67.7% = honest simulated baseline (below target)
  const vdr_score = Math.min(1, params.vdr / 100);
  if (params.vdr < 50) {
    issues.push(
      `VDR critically low at ${params.vdr.toFixed(1)}% (below rollback threshold)`
    );
    actions.push('Auto-credit injection per EICCA');
  } else if (params.vdr < 67.7) {
    issues.push(`VDR below simulated baseline at ${params.vdr.toFixed(1)}%`);
    actions.push('Draft personalized outreach');
  }

  const overall_score =
    engagement_score * 0.3 +
    feature_adoption_score * 0.2 +
    support_sentiment_score * 0.15 +
    payment_health_score * 0.1 +
    vdr_score * 0.25;

  let risk_level: 'healthy' | 'at-risk' | 'critical';
  if (overall_score >= EVOLVED_GENOME.early_warning_threshold)
    risk_level = 'healthy';
  else if (overall_score >= EVOLVED_GENOME.early_warning_threshold * 0.7)
    risk_level = 'at-risk';
  else risk_level = 'critical';

  return {
    user_id: '',
    overall_score: Math.round(overall_score * 100) / 100,
    engagement_score: Math.round(engagement_score * 100) / 100,
    feature_adoption_score: Math.round(feature_adoption_score * 100) / 100,
    support_sentiment_score: Math.round(support_sentiment_score * 100) / 100,
    payment_health_score: Math.round(payment_health_score * 100) / 100,
    vdr_score: Math.round(vdr_score * 100) / 100,
    risk_level,
    detected_issues: issues,
    recommended_actions: actions,
    last_updated: new Date().toISOString(),
  };
}

export function getInterventionAction(
  risk_level: 'healthy' | 'at-risk' | 'critical'
): {
  action: string;
  auto_execute: boolean;
  notify_user: boolean;
  inject_credits: number;
} {
  switch (risk_level) {
    case 'critical':
      return {
        action: 'auto-credit-injection',
        auto_execute: true,
        notify_user: true,
        inject_credits: 50,
      };
    case 'at-risk':
      return {
        action: 'draft-outreach',
        auto_execute: false,
        notify_user: false,
        inject_credits: 0,
      };
    default:
      return {
        action: 'none',
        auto_execute: false,
        notify_user: false,
        inject_credits: 0,
      };
  }
}

// v7: Real-time sentiment analysis (upgrade from support-tickets only)
// This is one of the mutations needed to reach the poetic equation.
export interface RealTimeSentimentSignal {
  user_id: string;
  signal_type:
    | 'message_tone'
    | 'interaction_pattern'
    | 'response_latency'
    | 'error_frequency';
  sentiment_score: number; // 0 = very negative, 1 = very positive
  confidence: number; // 0-1
  timestamp: string;
  source: 'chat' | 'ui_interaction' | 'api_usage' | 'support_ticket';
  metadata: Record<string, unknown>;
}

export function analyzeRealTimeSentiment(params: {
  user_id: string;
  message_length: number;
  contains_negative_words: boolean;
  contains_positive_words: boolean;
  response_time_ms: number;
  error_count_session: number;
  repeated_requests: number;
  session_duration_min: number;
}): RealTimeSentimentSignal {
  let sentiment = 0.5; // neutral baseline
  const signals: string[] = [];

  // Message tone analysis
  if (params.contains_negative_words) sentiment -= 0.2;
  if (params.contains_positive_words) sentiment += 0.15;
  if (params.message_length > 500) sentiment -= 0.05; // long messages = frustration

  // Interaction pattern
  if (params.repeated_requests > 3) {
    sentiment -= 0.15;
    signals.push('repeated_requests');
  }
  if (params.error_count_session > 2) {
    sentiment -= 0.2;
    signals.push('high_error_rate');
  }
  if (params.session_duration_min > 30 && params.error_count_session === 0) {
    sentiment += 0.1; // long productive session
  }

  // Response latency frustration
  if (params.response_time_ms > 5000) sentiment -= 0.15;

  sentiment = Math.max(0, Math.min(1, sentiment));

  return {
    user_id: params.user_id,
    signal_type: signals.length > 0 ? 'interaction_pattern' : 'message_tone',
    sentiment_score: Math.round(sentiment * 100) / 100,
    confidence: Math.min(1, 0.5 + signals.length * 0.15),
    timestamp: new Date().toISOString(),
    source: 'chat',
    metadata: { signals },
  };
}

// v7: Hybrid churn prediction (upgrade from heuristic-only)
// Combines heuristic rules with ML anomaly detection for the poetic equation.
export interface ChurnPrediction {
  user_id: string;
  churn_probability: number; // 0-1
  prediction_model: 'heuristic' | 'ml' | 'hybrid';
  contributing_factors: string[];
  recommended_intervention: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  time_to_churn_days: number | null; // estimated days until churn
}

export function predictChurnHybrid(params: {
  health_score: UserHealthScore;
  sentiment_trend: number[]; // last N sentiment scores
  vdr_trend: number[]; // last N VDR values
  days_since_last_login: number;
  credit_balance: number;
  subscription_age_days: number;
}): ChurnPrediction {
  const factors: string[] = [];
  let heuristic_score = 0;
  let ml_score = 0;

  // === HEURISTIC COMPONENT ===
  if (params.health_score.risk_level === 'critical') {
    heuristic_score += 0.3;
    factors.push('critical_health_score');
  } else if (params.health_score.risk_level === 'at-risk') {
    heuristic_score += 0.15;
    factors.push('at_risk_health_score');
  }

  if (params.days_since_last_login > 14) {
    heuristic_score += 0.2;
    factors.push(`inactive_${params.days_since_last_login}d`);
  } else if (params.days_since_last_login > 7) {
    heuristic_score += 0.1;
    factors.push(`inactive_${params.days_since_last_login}d`);
  }

  if (params.credit_balance < 10) {
    heuristic_score += 0.15;
    factors.push('low_credit_balance');
  }

  // === ML COMPONENT (simulated) ===
  // Trend analysis: declining sentiment or VDR = higher churn risk
  if (params.sentiment_trend.length >= 3) {
    const recent = params.sentiment_trend.slice(-3);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (avg < 0.3) {
      ml_score += 0.25;
      factors.push('declining_sentiment_trend');
    } else if (avg < 0.5) {
      ml_score += 0.1;
      factors.push('negative_sentiment_trend');
    }
  }

  if (params.vdr_trend.length >= 3) {
    const recent = params.vdr_trend.slice(-3);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (avg < 50) {
      ml_score += 0.2;
      factors.push('critical_vdr_trend');
    } else if (avg < 67.7) {
      ml_score += 0.1;
      factors.push('below_baseline_vdr_trend');
    }
  }

  // Subscription age: new users churn faster
  if (params.subscription_age_days < 30) {
    ml_score += 0.1;
    factors.push('new_subscription_risk');
  }

  // === HYBRID FUSION ===
  const churn_probability = Math.min(1, (heuristic_score + ml_score) / 2);

  let urgency: 'low' | 'medium' | 'high' | 'critical';
  if (churn_probability >= 0.7) urgency = 'critical';
  else if (churn_probability >= 0.5) urgency = 'high';
  else if (churn_probability >= 0.3) urgency = 'medium';
  else urgency = 'low';

  let intervention = 'none';
  if (urgency === 'critical') intervention = 'auto-credit-injection';
  else if (urgency === 'high') intervention = 'auto-credit';
  else if (urgency === 'medium') intervention = 'draft-outreach';
  else intervention = 'monitor';

  // Estimate time to churn
  let time_to_churn: number | null = null;
  if (churn_probability > 0.3) {
    time_to_churn = Math.max(1, Math.round(30 * (1 - churn_probability)));
  }

  return {
    user_id: params.health_score.user_id || '',
    churn_probability: Math.round(churn_probability * 100) / 100,
    prediction_model: 'hybrid',
    contributing_factors: factors,
    recommended_intervention: intervention,
    urgency,
    time_to_churn_days: time_to_churn,
  };
}

// v7: Gap closure engine — the poetic equation test
// Tests whether the system can detect and close its own value gaps.
export interface GapDetectionResult {
  gap_type:
    | 'vdr_drop'
    | 'sentiment_decline'
    | 'engagement_drop'
    | 'error_spike'
    | 'credit_exhaustion';
  severity: 'low' | 'medium' | 'high' | 'critical';
  detected: boolean;
  auto_resolved: boolean;
  resolution_action: string;
  user_notified: boolean;
  detected_before_user_awareness: boolean;
  timestamp: string;
}

export function detectAndCloseGap(params: {
  vdr_current: number;
  vdr_baseline: number;
  sentiment_current: number;
  sentiment_baseline: number;
  error_rate_current: number;
  error_rate_baseline: number;
  credit_balance: number;
  user_reported_issue: boolean;
}): GapDetectionResult {
  const gaps: {
    type: GapDetectionResult['gap_type'];
    severity: GapDetectionResult['severity'];
    detected: boolean;
  }[] = [];

  // VDR gap detection
  const vdr_drop = params.vdr_baseline - params.vdr_current;
  if (vdr_drop > 10) {
    gaps.push({
      type: 'vdr_drop',
      severity: vdr_drop > 20 ? 'critical' : 'high',
      detected: true,
    });
  }

  // Sentiment decline
  const sentiment_drop = params.sentiment_baseline - params.sentiment_current;
  if (sentiment_drop > 0.2) {
    gaps.push({
      type: 'sentiment_decline',
      severity: sentiment_drop > 0.4 ? 'high' : 'medium',
      detected: true,
    });
  }

  // Error spike
  if (params.error_rate_current > params.error_rate_baseline * 2) {
    gaps.push({
      type: 'error_spike',
      severity:
        params.error_rate_current > params.error_rate_baseline * 3
          ? 'high'
          : 'medium',
      detected: true,
    });
  }

  // Credit exhaustion
  if (params.credit_balance < 10) {
    gaps.push({
      type: 'credit_exhaustion',
      severity: 'critical',
      detected: true,
    });
  }

  if (gaps.length === 0) {
    return {
      gap_type: 'vdr_drop',
      severity: 'low',
      detected: false,
      auto_resolved: false,
      resolution_action: 'none',
      user_notified: false,
      detected_before_user_awareness: !params.user_reported_issue,
      timestamp: new Date().toISOString(),
    };
  }

  // Sort by severity — handle the worst gap first
  gaps.sort((a, b) => {
    const order = { critical: 4, high: 3, medium: 2, low: 1 };
    return order[b.severity] - order[a.severity];
  });

  const worst = gaps[0];
  const auto_resolved =
    worst.severity === 'critical' || worst.severity === 'high';
  const resolution_action =
    worst.type === 'credit_exhaustion'
      ? 'auto-credit-injection'
      : worst.type === 'vdr_drop'
        ? 'rollback-to-last-known-good'
        : worst.type === 'error_spike'
          ? 'auto-retry-with-guided-fix'
          : 'draft-personalized-outreach';

  return {
    gap_type: worst.type,
    severity: worst.severity,
    detected: true,
    auto_resolved,
    resolution_action,
    user_notified: worst.severity === 'critical',
    detected_before_user_awareness: !params.user_reported_issue,
    timestamp: new Date().toISOString(),
  };
}
