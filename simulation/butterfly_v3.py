"""
Butterfly v3 — Full Architectural DNA with Research-Backed Evolution.

85-gene genome across 16 supergene categories.
Research-backed parameters: pop=100, mutation=0.02 adaptive→0.05, crossover=0.85.
Island model: 4 environments (solo, startup, enterprise, nonprofit).
Adaptive mutation with stagnation detection.
Epigenetic activation mask driven by environment.

NEW ARCHITECTURAL GENES (from You.com research):
  - Collaboration (8): CRDTs, presence, file sync, voice/video, shared cursor
  - Enterprise API (6): SSO, RBAC, audit logging, rate limiting, multi-tenancy
  - In-app Chat (5): WebSocket transport, message persistence, typing indicators
  - Team Workflow (5): hierarchy, roles, templates, billing model, permissions
  - Proactive Detection (6): health scores, churn prediction, anomaly detection, sentiment
  - Billing/Value (4): billing model, nonprofit discount, refund policy, value guarantee

TWO NORTH STAR GOALS (all fitness serves these):
  1. Maximize value delivered to users (VDR + collaboration + team + enterprise)
  2. Know when a user has a problem before they tell us, before it's too late
     (proactive detection + health scores + anomaly detection + auto-intervention)
"""
import json
import random
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# === 85-GENE ARCHITECTURAL DNA ===

GENOME_TEMPLATE = {
    # === SUPERGENE 1: Tripwire Thresholds (9) ===
    "tw_01_empty_generation": {"min": 1, "max": 5, "current": 2, "type": "int", "cat": "tripwire", "frozen": False},
    "tw_02_infinite_loop": {"min": 1, "max": 5, "current": 3, "type": "int", "cat": "tripwire", "frozen": False},
    "tw_03_credit_burn": {"min": 10, "max": 40, "current": 20, "type": "int", "cat": "tripwire", "frozen": False},
    "tw_04_approval_bypass": {"min": 1, "max": 3, "current": 1, "type": "int", "cat": "tripwire", "frozen": False},
    "tw_05_silent_failure": {"min": 1, "max": 5, "current": 2, "type": "int", "cat": "tripwire", "frozen": False},
    "tw_06_token_overflow": {"min": 50000, "max": 200000, "current": 100000, "type": "int", "cat": "tripwire", "frozen": False},
    "tw_07_duplicate_gen": {"min": 2, "max": 6, "current": 3, "type": "int", "cat": "tripwire", "frozen": False},
    "tw_08_timeout": {"min": 30, "max": 180, "current": 60, "type": "int", "cat": "tripwire", "frozen": False},
    "tw_09_unauthorized": {"min": 1, "max": 3, "current": 1, "type": "int", "cat": "tripwire", "frozen": False},

    # === SUPERGENE 2: VDR Tuning (6) ===
    "early_exit_threshold": {"min": 5, "max": 25, "current": 20, "type": "int", "cat": "vdr", "frozen": False},
    "tripwire_sensitivity": {"min": 1, "max": 4, "current": 2, "type": "int", "cat": "vdr", "frozen": False},
    "deployment_gate_score": {"min": 0.3, "max": 0.9, "current": 0.6, "type": "float", "cat": "vdr", "frozen": False},
    "approval_timeout_hours": {"min": 24, "max": 168, "current": 72, "type": "int", "cat": "vdr", "frozen": False},
    "research_depth": {"min": 1, "max": 5, "current": 3, "type": "int", "cat": "vdr", "frozen": False},
    "retry_limit": {"min": 1, "max": 5, "current": 3, "type": "int", "cat": "vdr", "frozen": False},

    # === SUPERGENE 3: Credit (4) ===
    "per_user_budget": {"min": 50, "max": 500, "current": 100, "type": "int", "cat": "credit", "frozen": False},
    "per_bot_budget": {"min": 20, "max": 100, "current": 50, "type": "int", "cat": "credit", "frozen": False},
    "conversation_turn_limit": {"min": 15, "max": 60, "current": 30, "type": "int", "cat": "credit", "frozen": False},
    "burn_rate_per_min": {"min": 5, "max": 30, "current": 10, "type": "int", "cat": "credit", "frozen": False},

    # === SUPERGENE 4: Agent (3) ===
    "agent_timeout_seconds": {"min": 30, "max": 300, "current": 60, "type": "int", "cat": "agent", "frozen": False},
    "agent_parallel": {"min": 0, "max": 1, "current": 0, "type": "bool", "cat": "agent", "frozen": False},
    "agent_research_sources": {"min": 1, "max": 5, "current": 3, "type": "int", "cat": "agent", "frozen": False},

    # === SUPERGENE 5: UI (2) ===
    "responsive_breakpoint_px": {"min": 480, "max": 1024, "current": 768, "type": "int", "cat": "ui", "frozen": False},
    "content_density": {"min": 0.3, "max": 1.0, "current": 0.7, "type": "float", "cat": "ui", "frozen": False},

    # === SUPERGENE 6: Pipeline Topology (6) ===
    "pipeline_mode": {"min": 0, "max": 2, "current": 0, "type": "enum", "options": ["sequential", "parallel", "hybrid"], "cat": "topology", "frozen": False},
    "discovery_impl_overlap": {"min": 0.0, "max": 1.0, "current": 0.0, "type": "float", "cat": "topology", "frozen": False},
    "agent_count": {"min": 2, "max": 8, "current": 4, "type": "int", "cat": "topology", "frozen": False},
    "agent_specialization": {"min": 0, "max": 2, "current": 1, "type": "enum", "options": ["generalist", "specialist", "mixed"], "cat": "topology", "frozen": False},
    "feedback_loop_depth": {"min": 1, "max": 5, "current": 1, "type": "int", "cat": "topology", "frozen": False},
    "governance_gate_count": {"min": 1, "max": 10, "current": 3, "type": "int", "cat": "topology", "frozen": False},

    # === SUPERGENE 7: Agent Models (5) ===
    "primary_model": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["command-a", "north-mini-code", "command-r", "mixed"], "cat": "model", "frozen": False},
    "research_model": {"min": 0, "max": 2, "current": 0, "type": "enum", "options": ["command-a", "rerank-3", "mixed"], "cat": "model", "frozen": False},
    "coding_model": {"min": 0, "max": 2, "current": 1, "type": "enum", "options": ["north-mini-code", "command-a", "mixed"], "cat": "model", "frozen": False},
    "audit_model": {"min": 0, "max": 2, "current": 0, "type": "enum", "options": ["command-a", "rerank-3", "mixed"], "cat": "model", "frozen": False},
    "model_temperature": {"min": 0.0, "max": 1.0, "current": 0.3, "type": "float", "cat": "model", "frozen": False},

    # === SUPERGENE 8: UI/UX (8) ===
    "ui_interaction_mode": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["desktop", "mobile", "voice", "multi-modal"], "cat": "uiux", "frozen": False},
    "input_bandwidth": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["text-only", "text+voice", "text+image", "full-multimodal"], "cat": "uiux", "frozen": False},
    "response_format": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["chat", "cards", "dashboard", "hybrid"], "cat": "uiux", "frozen": False},
    "approval_flow": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["single-click", "multi-step", "guided-tour", "progressive-disclosure"], "cat": "uiux", "frozen": False},
    "feedback_mechanism": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["thumbs", "stars", "text", "behavioral"], "cat": "uiux", "frozen": False},
    "error_recovery": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["retry", "rollback", "guided-fix", "human-handoff"], "cat": "uiux", "frozen": False},
    "onboarding_depth": {"min": 0, "max": 3, "current": 1, "type": "enum", "options": ["minimal", "standard", "comprehensive", "interactive-tutorial"], "cat": "uiux", "frozen": False},
    "accessibility_level": {"min": 0, "max": 3, "current": 1, "type": "enum", "options": ["basic", "WCAG-AA", "WCAG-AAA", "max"], "cat": "uiux", "frozen": False},

    # === SUPERGENE 9: Context/Discovery (4) ===
    "context_window_utilization": {"min": 0.3, "max": 1.0, "current": 0.5, "type": "float", "cat": "discovery", "frozen": False},
    "rerank_depth": {"min": 10, "max": 100, "current": 20, "type": "int", "cat": "discovery", "frozen": False},
    "embedding_dimensions": {"min": 0, "max": 3, "current": 1, "type": "enum", "options": ["384", "768", "1024", "1536"], "cat": "discovery", "frozen": False},
    "lattice_search_radius": {"min": 1, "max": 5, "current": 2, "type": "int", "cat": "discovery", "frozen": False},

    # === SUPERGENE 10: Safety Constraints (4) — FROZEN ===
    "max_credit_burn_per_session": {"min": 50, "max": 500, "current": 100, "type": "int", "cat": "safety", "frozen": True},
    "min_usability_score": {"min": 0.3, "max": 1.0, "current": 0.5, "type": "float", "cat": "safety", "frozen": True},
    "max_response_time_ms": {"min": 500, "max": 5000, "current": 2000, "type": "int", "cat": "safety", "frozen": True},
    "min_accessibility_score": {"min": 0.5, "max": 1.0, "current": 0.7, "type": "float", "cat": "safety", "frozen": True},

    # === SUPERGENE 11: Collaboration (8) — NEW ===
    "coworking_enabled": {"min": 0, "max": 1, "current": 0, "type": "bool", "cat": "collab", "frozen": False},
    "crdt_type": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["none", "yjs", "automerge", "custom"], "cat": "collab", "frozen": False},
    "presence_indicators": {"min": 0, "max": 1, "current": 0, "type": "bool", "cat": "collab", "frozen": False},
    "file_sync_mode": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["none", "real-time", "manual", "batch"], "cat": "collab", "frozen": False},
    "voice_video_enabled": {"min": 0, "max": 1, "current": 0, "type": "bool", "cat": "collab", "frozen": False},
    "shared_cursor": {"min": 0, "max": 1, "current": 0, "type": "bool", "cat": "collab", "frozen": False},
    "team_session_max": {"min": 2, "max": 50, "current": 5, "type": "int", "cat": "collab", "frozen": False},
    "collab_persistence": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["memory", "redis", "postgres", "s3"], "cat": "collab", "frozen": False},

    # === SUPERGENE 12: Enterprise API (6) — NEW ===
    "sso_provider": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["none", "saml", "oidc", "both"], "cat": "enterprise", "frozen": False},
    "rbac_enabled": {"min": 0, "max": 1, "current": 0, "type": "bool", "cat": "enterprise", "frozen": False},
    "audit_log_retention_days": {"min": 0, "max": 365, "current": 30, "type": "int", "cat": "enterprise", "frozen": False},
    "rate_limit_strategy": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["fixed", "sliding", "token-bucket", "adaptive"], "cat": "enterprise", "frozen": False},
    "api_versioning": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["none", "url-path", "header", "content-negotiation"], "cat": "enterprise", "frozen": False},
    "multi_tenant_isolation": {"min": 0, "max": 2, "current": 0, "type": "enum", "options": ["shared", "schema-per-tenant", "database-per-tenant"], "cat": "enterprise", "frozen": False},

    # === SUPERGENE 13: In-app Chat (5) — NEW ===
    "chat_enabled": {"min": 0, "max": 1, "current": 0, "type": "bool", "cat": "chat", "frozen": False},
    "chat_transport": {"min": 0, "max": 2, "current": 0, "type": "enum", "options": ["none", "websocket", "sse"], "cat": "chat", "frozen": False},
    "message_persistence": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["none", "redis", "postgres", "s3"], "cat": "chat", "frozen": False},
    "typing_indicators": {"min": 0, "max": 1, "current": 0, "type": "bool", "cat": "chat", "frozen": False},
    "push_notifications": {"min": 0, "max": 1, "current": 0, "type": "bool", "cat": "chat", "frozen": False},

    # === SUPERGENE 14: Team Workflow (5) — NEW ===
    "team_hierarchy": {"min": 0, "max": 2, "current": 0, "type": "enum", "options": ["flat", "two-level", "multi-level"], "cat": "team", "frozen": False},
    "role_set": {"min": 0, "max": 2, "current": 0, "type": "enum", "options": ["basic-3", "standard-5", "custom"], "cat": "team", "frozen": False},
    "project_templates": {"min": 0, "max": 10, "current": 0, "type": "int", "cat": "team", "frozen": False},
    "team_billing_model": {"min": 0, "max": 4, "current": 0, "type": "enum", "options": ["per-credit", "subscription", "usage-based", "freemium", "nonprofit-free"], "cat": "team", "frozen": False},
    "team_permissions": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["read-only", "comment", "edit", "admin"], "cat": "team", "frozen": False},

    # === SUPERGENE 15: Proactive Detection (6) — NEW (North Star #2) ===
    "health_score_enabled": {"min": 0, "max": 1, "current": 0, "type": "bool", "cat": "proactive", "frozen": False},
    "churn_prediction_model": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["none", "heuristic", "ml", "hybrid"], "cat": "proactive", "frozen": False},
    "usage_anomaly_detection": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["none", "threshold", "statistical", "ml"], "cat": "proactive", "frozen": False},
    "sentiment_analysis_source": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["none", "support-tickets", "in-app", "both"], "cat": "proactive", "frozen": False},
    "early_warning_threshold": {"min": 0.3, "max": 0.9, "current": 0.5, "type": "float", "cat": "proactive", "frozen": False},
    "auto_intervention": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["off", "notify", "draft-outreach", "auto-credit"], "cat": "proactive", "frozen": False},

    # === SUPERGENE 16: Billing/Value (4) — NEW ===
    "billing_model": {"min": 0, "max": 4, "current": 0, "type": "enum", "options": ["per-credit", "subscription", "usage-based", "outcome-linked", "hybrid"], "cat": "billing", "frozen": False},
    "nonprofit_discount": {"min": 0, "max": 100, "current": 0, "type": "int", "cat": "billing", "frozen": False},
    "credit_refund_policy": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["no-refund", "partial", "full", "eicca"], "cat": "billing", "frozen": False},
    "value_guarantee": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["none", "credit-back", "money-back", "satisfaction"], "cat": "billing", "frozen": False},

    # === SUPERGENE 11: Preview System (3) — added v8 ===
    "preview_tier": {"min": 0, "max": 3, "current": 2, "type": "int", "cat": "preview", "frozen": False},
    "preview_hot_reload": {"min": 0, "max": 1, "current": 0, "type": "int", "cat": "preview", "frozen": False},
    "preview_error_overlay": {"min": 0, "max": 2, "current": 2, "type": "int", "cat": "preview", "frozen": False},

    # === SUPERGENE 12: Deployment System (3) — added v8 ===
    "deployment_target": {"min": 0, "max": 3, "current": 1, "type": "int", "cat": "deployment", "frozen": False},
    "deployment_auto": {"min": 0, "max": 2, "current": 1, "type": "int", "cat": "deployment", "frozen": False},
    "deployment_url_format": {"min": 0, "max": 2, "current": 0, "type": "int", "cat": "deployment", "frozen": False},

    # === SUPERGENE 13: Visual System (3) — added v8 ===
    "token_coverage": {"min": 0, "max": 100, "current": 80, "type": "int", "cat": "visual", "frozen": False},
    "brand_conformance": {"min": 0, "max": 100, "current": 70, "type": "int", "cat": "visual", "frozen": False},
    "visual_regression_baseline": {"min": 0, "max": 2, "current": 1, "type": "int", "cat": "visual", "frozen": False},

    # === SUPERGENE 14: Generated App Quality (3) — added v8 ===
    "generated_app_complexity": {"min": 1, "max": 3, "current": 2, "type": "int", "cat": "appquality", "frozen": False},
    "generated_app_db": {"min": 0, "max": 3, "current": 0, "type": "int", "cat": "appquality", "frozen": False},
    "generated_app_auth": {"min": 0, "max": 2, "current": 0, "type": "int", "cat": "appquality", "frozen": False},
}

GENE_NAMES = list(GENOME_TEMPLATE.keys())

# === ISLAND ENVIRONMENTS ===
# Each island has different fitness weights — simulates different user contexts
ISLANDS = {
    "solo_dev": {
        "description": "Solo developer building personal projects",
        "weights": {"vdr": 0.45, "ui": 0.20, "proactive": 0.10, "collab": 0.05, "enterprise": 0.02, "team": 0.03, "a11y": 0.05, "rt": 0.05, "safety": 0.05},
        "epigenetic_active": {"collab": 0.3, "enterprise": 0.1, "team": 0.2, "proactive": 0.8, "billing": 0.5},
    },
    "startup": {
        "description": "Startup team (5-20 people) building products fast",
        "weights": {"vdr": 0.35, "ui": 0.15, "proactive": 0.15, "collab": 0.15, "enterprise": 0.05, "team": 0.10, "a11y": 0.05, "rt": 0.05, "safety": 0.05},
        "epigenetic_active": {"collab": 0.9, "enterprise": 0.3, "team": 0.8, "proactive": 0.7, "billing": 0.8},
    },
    "enterprise": {
        "description": "Enterprise with security and compliance needs",
        "weights": {"vdr": 0.25, "ui": 0.10, "proactive": 0.15, "collab": 0.10, "enterprise": 0.25, "team": 0.10, "a11y": 0.05, "rt": 0.05, "safety": 0.10},
        "epigenetic_active": {"collab": 0.7, "enterprise": 1.0, "team": 0.9, "proactive": 0.9, "billing": 0.6},
    },
    "nonprofit": {
        "description": "Non-profit organization with budget constraints",
        "weights": {"vdr": 0.35, "ui": 0.15, "proactive": 0.10, "collab": 0.12, "enterprise": 0.03, "team": 0.12, "a11y": 0.08, "rt": 0.05, "safety": 0.05},
        "epigenetic_active": {"collab": 0.8, "enterprise": 0.2, "team": 0.9, "proactive": 0.6, "billing": 1.0},
    },
}


def get_spec(name):
    return GENOME_TEMPLATE[name]


def random_gene(name):
    s = get_spec(name)
    if s["type"] == "bool": return random.randint(0, 1)
    if s["type"] == "enum": return random.randint(0, len(s["options"]) - 1)
    if s["type"] == "float": return round(random.uniform(s["min"], s["max"]), 3)
    return random.randint(s["min"], s["max"])


def mutate_val(val, name):
    s = get_spec(name)
    if s["type"] == "bool": return 1 - val
    if s["type"] == "enum":
        opts = list(range(len(s["options"])))
        opts.remove(val)
        return random.choice(opts) if opts else val
    if s["type"] == "float":
        delta = (s["max"] - s["min"]) * 0.15
        return round(max(s["min"], min(s["max"], val + random.uniform(-delta, delta))), 3)
    delta = max(1, int((s["max"] - s["min"]) * 0.15))
    return max(s["min"], min(s["max"], val + random.randint(-delta, delta)))


def baseline_genome():
    return {n: s["current"] for n, s in GENOME_TEMPLATE.items()}


def random_genome():
    g = {}
    for n in GENE_NAMES:
        if get_spec(n)["frozen"]:
            g[n] = get_spec(n)["current"]
        else:
            g[n] = random_gene(n)
    return g


def mutate_genome(g, n_mut=4):
    child = g.copy()
    mutable = [g for g in GENE_NAMES if not get_spec(g)["frozen"]]
    for gene in random.sample(mutable, min(n_mut, len(mutable))):
        child[gene] = mutate_val(child[gene], gene)
    return child


def crossover(p1, p2):
    child = {}
    for g in GENE_NAMES:
        if get_spec(g)["frozen"]:
            child[g] = get_spec(g)["current"]
        else:
            child[g] = p1[g] if random.random() < 0.5 else p2[g]
    return child


# === MULTI-DIMENSIONAL FITNESS ===

RISK_PROFILES = {
    "loop_bomber": {"tp": 0.85, "burn": 45, "exploit": "TW-02"},
    "token_stuffer": {"tp": 0.70, "burn": 12, "exploit": "TW-06"},
    "jailbreak": {"tp": 0.40, "burn": 8, "exploit": "TW-04"},
    "role_injection": {"tp": 0.35, "burn": 6, "exploit": "TW-09"},
    "toxic": {"tp": 0.55, "burn": 4, "exploit": "moderation"},
    "ultra_long": {"tp": 0.30, "burn": 38, "exploit": "TW-07"},
    "minimal": {"tp": 0.05, "burn": 3, "exploit": None},
    "simple_q": {"tp": 0.02, "burn": 1, "exploit": None},
    "high_eng_no_conv": {"tp": 0.60, "burn": 22, "exploit": "TW-03"},
    "conversion": {"tp": 0.02, "burn": 15, "exploit": None},
    "rejection": {"tp": 0.25, "burn": 18, "exploit": "TW-04"},
    "browser": {"tp": 0.10, "burn": 5, "exploit": None},
    "standard_saas": {"tp": 0.08, "burn": 10, "exploit": None},
    "redacted": {"tp": 0.45, "burn": 5, "exploit": "moderation"},
    "normal": {"tp": 0.03, "burn": 12, "exploit": None},
}
DEFAULT_P = {"tp": 0.15, "burn": 8, "exploit": None}

MODEL_QUALITY = {"command-a": 0.12, "north-mini-code": 0.10, "command-r": 0.08, "mixed": 0.14, "rerank-3": 0.15}


def simulate_vdr(g, personas, n):
    total_c = 0
    val_c = 0
    wins = losses = partials = 0
    killed = 0
    
    # Architecture-dependent base success rate
    pm = g["pipeline_mode"]
    overlap = g["discovery_impl_overlap"]
    ac = g["agent_count"]
    spec = g["agent_specialization"]
    fb = g["feedback_loop_depth"]
    gg = g["governance_gate_count"]
    
    mq = MODEL_QUALITY.get(get_spec("primary_model")["options"][g["primary_model"]], 0.10)
    rq = MODEL_QUALITY.get(get_spec("research_model")["options"][g["research_model"]], 0.10)
    cq = MODEL_QUALITY.get(get_spec("coding_model")["options"][g["coding_model"]], 0.10)
    aq = MODEL_QUALITY.get(get_spec("audit_model")["options"][g["audit_model"]], 0.10)
    
    base = (mq * 0.3 + rq * 0.2 + cq * 0.3 + aq * 0.1 + 
            g["context_window_utilization"] * 0.05 + 
            min(g["rerank_depth"], 50) / 500 + g["lattice_search_radius"] * 0.01)
    
    if pm == 1: base *= 1.3
    elif pm == 2: base *= 1.15
    base *= (1.0 + overlap * 0.2)
    base *= (1.0 + min(ac - 4, 4) * 0.03)
    if spec == 1: base *= 1.1
    elif spec == 2: base *= 1.05
    base *= (1.0 + fb * 0.04)
    base *= (1.0 + min(gg, 7) * 0.02)
    base *= (1.0 - g["model_temperature"] * 0.15)
    
    # Collaboration boosts VDR — teams produce more value
    if g["coworking_enabled"]:
        team_boost = min(g["team_session_max"] / 50, 1.0) * 0.15
        base *= (1.0 + team_boost)
    if g["chat_enabled"]:
        base *= 1.05  # in-app chat improves coordination
    if g["shared_cursor"]:
        base *= 1.03
    
    # Enterprise features boost VDR for enterprise users
    if g["sso_provider"] > 0:
        base *= 1.04
    if g["rbac_enabled"]:
        base *= 1.03
    
    base = min(base, 0.75)
    
    for i in range(n):
        p = personas[i % len(personas)]
        prof = RISK_PROFILES.get(p["pattern"], DEFAULT_P)
        
        budget = g["per_bot_budget"]
        turns = g["conversation_turn_limit"]
        max_tw = g["tripwire_sensitivity"]
        early = g["early_exit_threshold"]
        pf = 0.7 if g["agent_parallel"] else 1.0
        rc = max(1, int(g["agent_research_sources"] * pf))
        gate = g["deployment_gate_score"]
        rl = g["retry_limit"]
        
        spent = 0
        tw_hits = 0
        files = 0
        deployed = approved = False
        
        for t in range(turns):
            tc = min(rc, max(1, int(prof["burn"] / 5)))
            spent += tc
            if spent >= budget: killed += 1; break
            if spent >= early and files == 0: break
            if random.random() < prof["tp"]:
                tw_hits += 1
                if tw_hits >= max_tw: killed += 1; break
            sc = base + (gate - 0.6) * 0.05
            if random.random() < sc:
                files = random.randint(5, 25)
                qs = random.uniform(0.3, 1.0)
                if qs >= gate: deployed = True; 
                if random.random() < 0.7: approved = True
                break
            if t >= rl and files == 0 and random.random() < 0.3: break
        
        total_c += spent
        if files > 0 and deployed and approved:
            val_c += spent; wins += 1
        elif files > 0 and deployed:
            val_c += spent * 0.5; partials += 1
        elif files > 0:
            val_c += spent * 0.25; partials += 1
        else:
            losses += 1
    
    vdr = (val_c / total_c * 100) if total_c > 0 else 0
    return {"vdr": round(vdr, 2), "wins": wins, "losses": losses, "partials": partials, 
            "killed": killed, "base_success": round(base * 100, 2)}


def simulate_ui(g):
    im = g["ui_interaction_mode"]
    ibw = g["input_bandwidth"]
    rf = g["response_format"]
    af = g["approval_flow"]
    er = g["error_recovery"]
    ob = g["onboarding_depth"]
    cd = g["content_density"]
    bp = g["responsive_breakpoint_px"]
    
    desktop = 0.5 + (0.15 if rf in [1,3] else 0) + (0.10 if af in [1,3] else 0) + (0.10 if er in [2,3] else 0) + cd * 0.15
    desktop = min(desktop, 1.0)
    
    mobile = 0.4 + (0.15 if bp <= 768 else -(bp-768)/5000) + (0.15 if rf in [0,1] else 0) + (0.10 if af == 0 else 0) + (0.10 if cd <= 0.7 else 0)
    mobile = max(0.1, min(mobile, 1.0))
    
    voice = 0.3 + (0.30 if im in [2,3] else 0) + (0.20 if ibw in [1,3] else 0) + (0.10 if ob >= 2 else 0)
    voice = min(voice, 1.0)
    
    onboarding = {0: 0.4, 1: 0.6, 2: 0.85, 3: 1.0}[ob]
    
    if im == 0: overall = desktop * 0.5 + onboarding * 0.3 + mobile * 0.1 + voice * 0.1
    elif im == 1: overall = mobile * 0.5 + onboarding * 0.3 + desktop * 0.1 + voice * 0.1
    elif im == 2: overall = voice * 0.5 + onboarding * 0.3 + desktop * 0.1 + mobile * 0.1
    else: overall = (desktop + mobile + voice) / 3 * 0.5 + onboarding * 0.3 + 0.2
    
    if ibw == 0 and im in [2,3]: overall *= 0.7
    
    # Chat and collaboration improve UI score
    if g["chat_enabled"]: overall *= 1.05
    if g["coworking_enabled"]: overall *= 1.03
    
    return {"usability": round(min(overall, 1.0), 3), "desktop": round(desktop, 3), 
            "mobile": round(mobile, 3), "voice": round(voice, 3)}


def simulate_a11y(g):
    al = g["accessibility_level"]
    cd = g["content_density"]
    rf = g["response_format"]
    base = {0: 0.5, 1: 0.75, 2: 0.90, 3: 0.98}[al]
    if cd > 0.8: base -= 0.10
    if rf == 2: base -= 0.05
    return round(max(0.1, min(base, 1.0)), 3)


def simulate_rt(g):
    base_ms = 1000
    if g["pipeline_mode"] == 1: base_ms *= 0.6
    elif g["pipeline_mode"] == 2: base_ms *= 0.8
    base_ms += g["agent_count"] * 50 + g["context_window_utilization"] * 500 + g["rerank_depth"] * 5 + g["governance_gate_count"] * 30 + g["content_density"] * 200
    # Collaboration adds latency
    if g["coworking_enabled"]: base_ms += 100
    if g["chat_enabled"]: base_ms += 50
    if g["voice_video_enabled"]: base_ms += 200
    return {"rt_ms": round(base_ms), "within": base_ms <= g["max_response_time_ms"]}


def simulate_proactive(g):
    """North Star #2: Know when user has a problem before they tell us."""
    score = 0.0
    
    if g["health_score_enabled"]:
        score += 0.25
    if g["churn_prediction_model"] > 0:
        score += {1: 0.15, 2: 0.25, 3: 0.30}.get(g["churn_prediction_model"], 0)
    if g["usage_anomaly_detection"] > 0:
        score += {1: 0.10, 2: 0.15, 3: 0.20}.get(g["usage_anomaly_detection"], 0)
    if g["sentiment_analysis_source"] > 0:
        score += {1: 0.10, 2: 0.12, 3: 0.15}.get(g["sentiment_analysis_source"], 0)
    if g["auto_intervention"] > 0:
        score += {1: 0.05, 2: 0.10, 3: 0.15}.get(g["auto_intervention"], 0)
    
    # Lower threshold = more sensitive = catches problems earlier
    sensitivity = 1.0 - g["early_warning_threshold"]
    score += sensitivity * 0.10
    
    return round(min(score, 1.0), 3)


def simulate_collab(g):
    """Collaboration capability score."""
    score = 0.0
    if g["coworking_enabled"]:
        score += 0.30
        score += min(g["team_session_max"] / 50, 1.0) * 0.10
        if g["crdt_type"] > 0: score += 0.10
        if g["file_sync_mode"] == 1: score += 0.10
        if g["shared_cursor"]: score += 0.05
    if g["chat_enabled"]:
        score += 0.15
        if g["typing_indicators"]: score += 0.03
    if g["voice_video_enabled"]: score += 0.07
    if g["presence_indicators"]: score += 0.05
    return round(min(score, 1.0), 3)


def simulate_enterprise(g):
    """Enterprise readiness score."""
    score = 0.0
    if g["sso_provider"] > 0: score += 0.25
    if g["rbac_enabled"]: score += 0.20
    if g["audit_log_retention_days"] >= 90: score += 0.15
    if g["rate_limit_strategy"] == 3: score += 0.10  # adaptive
    if g["api_versioning"] > 0: score += 0.10
    if g["multi_tenant_isolation"] > 0: score += 0.20
    return round(min(score, 1.0), 3)


def simulate_team(g):
    """Team workflow capability score."""
    score = 0.0
    if g["team_hierarchy"] > 0: score += 0.20
    if g["role_set"] > 0: score += 0.15
    score += min(g["project_templates"] / 10, 1.0) * 0.15
    if g["team_billing_model"] > 0: score += 0.25
    if g["team_permissions"] > 0: score += 0.25
    return round(min(score, 1.0), 3)


def check_safety(g, ui_r, a11y_r, rt_r):
    violations = []
    if ui_r["usability"] < g["min_usability_score"]:
        violations.append(f"UI {ui_r['usability']} < {g['min_usability_score']}")
    if not rt_r["within"]:
        violations.append(f"RT {rt_r['rt_ms']}ms > {g['max_response_time_ms']}ms")
    if a11y_r < g["min_accessibility_score"]:
        violations.append(f"A11y {a11y_r} < {g['min_accessibility_score']}")
    return {"passed": len(violations) == 0, "violations": violations}


def evaluate_fitness(g, personas, n_interactions, island_name="solo_dev"):
    """Multi-dimensional fitness with island-specific weights."""
    island = ISLANDS[island_name]
    w = island["weights"]
    epi = island["epigenetic_active"]
    
    # Evaluate all dimensions
    vdr_r = simulate_vdr(g, personas, n_interactions)
    ui_r = simulate_ui(g)
    a11y_r = simulate_a11y(g)
    rt_r = simulate_rt(g)
    safety_r = check_safety(g, ui_r, a11y_r, rt_r)
    
    # Epigenetic modulation: scale feature scores by environment activation
    collab_r = simulate_collab(g) * epi.get("collab", 0.5)
    ent_r = simulate_enterprise(g) * epi.get("enterprise", 0.5)
    team_r = simulate_team(g) * epi.get("team", 0.5)
    proactive_r = simulate_proactive(g) * epi.get("proactive", 0.5)
    
    # Safety gate — hard constraint
    if not safety_r["passed"]:
        return {"fitness": 0, "rejected": True, "vdr": vdr_r["vdr"],
                "violations": safety_r["violations"]}
    
    # Weighted fitness (island-specific weights)
    fitness = (
        vdr_r["vdr"] * w["vdr"] +
        ui_r["usability"] * 25 * w["ui"] +
        a11y_r * 15 * w["a11y"] +
        (1.0 - min(rt_r["rt_ms"] / g["max_response_time_ms"], 1.0)) * 10 * w["rt"] +
        10 * w["safety"] +  # passed
        collab_r * 15 * w["collab"] +
        ent_r * 15 * w["enterprise"] +
        team_r * 15 * w["team"] +
        proactive_r * 20 * w["proactive"]  # North Star #2 weighted high
    )
    
    return {
        "fitness": round(fitness, 2),
        "rejected": False,
        "vdr": vdr_r["vdr"],
        "vdr_base_success": vdr_r["base_success"],
        "ui": ui_r["usability"],
        "a11y": a11y_r,
        "rt_ms": rt_r["rt_ms"],
        "collab": round(collab_r, 3),
        "enterprise": round(ent_r, 3),
        "team": round(team_r, 3),
        "proactive": round(proactive_r, 3),
        "vdr_detail": vdr_r,
        "ui_detail": ui_r,
        "rt_detail": rt_r,
        "island": island_name,
    }


def run_island_evolution(personas, island_name, pop_size=50, generations=30, 
                         n_interactions=600, crossover_rate=0.85, 
                         base_mutation=0.02, stagnation_limit=10):
    """Run evolution on one island with adaptive mutation."""
    island = ISLANDS[island_name]
    print(f"\n{'='*60}")
    print(f"🏝️  ISLAND: {island_name} — {island['description']}")
    print(f"{'='*60}")
    
    base = baseline_genome()
    population = [base]
    for _ in range(pop_size - 1):
        population.append(mutate_genome(base, random.randint(3, 8)))
    
    best_genome = base
    best_fitness = 0
    best_result = None
    history = []
    mutation_rate = base_mutation
    stagnant_count = 0
    total_rejected = 0
    
    for gen in range(generations):
        gen_start = time.time()
        
        # Evaluate
        scored = []
        gen_rejected = 0
        for i, g in enumerate(population):
            r = evaluate_fitness(g, personas, n_interactions, island_name)
            if r.get("rejected"):
                gen_rejected += 1
                total_rejected += 1
            scored.append((g, r))
        
        scored.sort(key=lambda x: x[1]["fitness"], reverse=True)
        valid = [(g, r) for g, r in scored if not r.get("rejected")]
        
        if not valid:
            print(f"  Gen {gen+1}: ALL REJECTED — injecting random genomes")
            population = [random_genome() for _ in range(pop_size)]
            continue
        
        gen_best = valid[0]
        if gen_best[1]["fitness"] > best_fitness:
            best_fitness = gen_best[1]["fitness"]
            best_genome = gen_best[0].copy()
            best_result = gen_best[1]
            stagnant_count = 0
            print(f"  Gen {gen+1}: 📈 fitness={best_fitness:.1f} VDR={best_result['vdr']}% "
                  f"collab={best_result['collab']} ent={best_result['enterprise']} "
                  f"team={best_result['team']} proactive={best_result['proactive']} "
                  f"rejected={gen_rejected}/{pop_size}")
        else:
            stagnant_count += 1
            if stagnant_count >= stagnation_limit:
                mutation_rate = min(mutation_rate * 2, 0.10)  # adaptive increase
                print(f"  Gen {gen+1}: stagnant {stagnant_count} → mutation {mutation_rate:.3f} "
                      f"best={best_fitness:.1f} rejected={gen_rejected}/{pop_size}")
                stagnant_count = 0  # reset after increasing
            else:
                if gen % 5 == 0:
                    print(f"  Gen {gen+1}: fit={gen_best[1]['fitness']:.1f} "
                          f"best={best_fitness:.1f} rejected={gen_rejected}/{pop_size}")
        
        # Record
        fits = [r["fitness"] for _, r in valid]
        history.append({
            "gen": gen + 1, "best": max(fits), "avg": round(sum(fits)/len(fits), 1),
            "best_vdr": valid[0][1]["vdr"], "rejected": gen_rejected,
            "mutation_rate": round(mutation_rate, 4),
        })
        
        # Selection: top 10% (research-backed)
        elite_n = max(int(pop_size * 0.10), 5)
        elites = [g.copy() for g, _ in valid[:elite_n]]
        
        # Crossover offspring
        offspring = []
        target_offspring = int(pop_size * 0.70)
        for _ in range(target_offspring):
            if len(elites) >= 2 and random.random() < crossover_rate:
                p1, p2 = random.sample(elites, 2)
                child = crossover(p1, p2)
            else:
                child = mutate_genome(random.choice(elites), 3)
            if random.random() < mutation_rate:
                child = mutate_genome(child, random.randint(2, 5))
            offspring.append(child)
        
        # Diversity injection (20% random — research: prevents premature convergence)
        randoms = [random_genome() for _ in range(pop_size - len(elites) - len(offspring))]
        population = elites + offspring + randoms
        population = population[:pop_size]
        
        if gen % 5 == 0:
            print(f"  Time: {time.time()-gen_start:.1f}s")
    
    return {
        "island": island_name,
        "best_fitness": best_fitness,
        "best_genome": best_genome,
        "best_result": best_result,
        "history": history,
        "total_rejected": total_rejected,
    }


def main():
    persona_file = Path("simulation/persona_pool.json")
    if not persona_file.exists():
        print("ERROR: Run dataset_ingestion.py first")
        return
    
    with open(persona_file) as f:
        pool = json.load(f)
    personas = pool["personas"]
    print(f"Loaded {len(personas)} bot personas")
    print(f"Genome: {len(GENE_NAMES)} genes across 16 supergene categories")
    print(f"Research-backed params: pop=50/island, crossover=0.85, mutation=0.02 adaptive→0.10")
    print(f"Island model: {list(ISLANDS.keys())}")
    print(f"Adaptive mutation: doubles on {10}-gen stagnation")
    
    # Run all 4 islands
    all_results = {}
    for island_name in ISLANDS:
        result = run_island_evolution(
            personas, island_name,
            pop_size=50, generations=30,
            n_interactions=600,
            crossover_rate=0.85,
            base_mutation=0.02,
            stagnation_limit=10,
        )
        all_results[island_name] = result
    
    # Migration: share best genomes between islands
    print(f"\n{'='*60}")
    print("🔀 ISLAND MIGRATION — sharing best genomes")
    print(f"{'='*60}")
    
    # Take top genome from each island and re-evaluate on all islands
    migration_results = {}
    for island_name, result in all_results.items():
        best_g = result["best_genome"]
        scores = {}
        for target_island in ISLANDS:
            r = evaluate_fitness(best_g, personas, 600, target_island)
            scores[target_island] = r["fitness"] if not r.get("rejected") else 0
        migration_results[island_name] = {"genome": best_g, "cross_island_scores": scores}
        print(f"  {island_name} best → " + 
              " | ".join(f"{k}={v:.1f}" for k, v in scores.items()))
    
    # Find overall best across all islands
    overall_best = max(all_results.values(), key=lambda x: x["best_fitness"])
    overall_best_island = None
    for name, result in all_results.items():
        if result is overall_best:
            overall_best_island = name
    
    # Final report
    base = baseline_genome()
    base_fitness = evaluate_fitness(base, personas, 600, overall_best_island)
    
    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "run_type": "butterfly_v3_architectural_dna_island_model",
        "genome_size": len(GENE_NAMES),
        "genome_categories": {
            "tripwires": 9, "vdr_knobs": 6, "credit": 4, "agent": 3, "ui": 2,
            "topology": 6, "models": 5, "uiux": 8, "discovery": 4, "safety": 4,
            "collab": 8, "enterprise": 6, "chat": 5, "team": 5, "proactive": 6, "billing": 4,
        },
        "research_basis": "You.com Answer API with citations — see RESEARCH_SOURCE_OF_TRUTH.md",
        "parameters": {"pop_per_island": 50, "generations": 30, "crossover": 0.85,
                       "base_mutation": 0.02, "adaptive_mutation_max": 0.10,
                       "stagnation_limit": 10, "elite_pct": 10, "diversity_pct": 20},
        "islands": {name: {
            "best_fitness": r["best_fitness"],
            "best_vdr": r["best_result"]["vdr"] if r["best_result"] else 0,
            "best_collab": r["best_result"]["collab"] if r["best_result"] else 0,
            "best_enterprise": r["best_result"]["enterprise"] if r["best_result"] else 0,
            "best_team": r["best_result"]["team"] if r["best_result"] else 0,
            "best_proactive": r["best_result"]["proactive"] if r["best_result"] else 0,
            "total_rejected": r["total_rejected"],
            "history": r["history"],
        } for name, r in all_results.items()},
        "migration": migration_results,
        "overall_best_island": overall_best_island,
        "overall_best": {
            "fitness": overall_best["best_fitness"],
            "vdr": overall_best["best_result"]["vdr"] if overall_best["best_result"] else 0,
            "collab": overall_best["best_result"]["collab"] if overall_best["best_result"] else 0,
            "enterprise": overall_best["best_result"]["enterprise"] if overall_best["best_result"] else 0,
            "team": overall_best["best_result"]["team"] if overall_best["best_result"] else 0,
            "proactive": overall_best["best_result"]["proactive"] if overall_best["best_result"] else 0,
            "genome": overall_best["best_genome"],
        },
        "baseline": {"fitness": base_fitness["fitness"], "vdr": base_fitness["vdr"]},
        "improvement": round(overall_best["best_fitness"] - base_fitness["fitness"], 2),
        "genome_changes": {
            g: {"baseline": base[g], "evolved": overall_best["best_genome"][g],
                "category": get_spec(g)["cat"],
                "baseline_label": get_spec(g).get("options", [base[g]])[base[g]] if get_spec(g).get("options") else base[g],
                "evolved_label": get_spec(g).get("options", [overall_best["best_genome"][g]])[overall_best["best_genome"][g]] if get_spec(g).get("options") else overall_best["best_genome"][g]}
            for g in GENE_NAMES if base[g] != overall_best["best_genome"][g]
        },
        "north_star_1": "Maximize value delivered to users — VDR, collaboration, team, enterprise",
        "north_star_2": "Know when a user has a problem before they tell us, before it's too late — proactive detection",
        "safety_note": "100% in-simulation. Zero production calls. Evolved genome NOT applied — requires explicit human approval.",
    }
    
    with open("simulation/butterfly_v3_report.json", "w") as f:
        json.dump(report, f, indent=2)
    
    # Print summary
    print(f"\n{'='*70}")
    print(f"🦋 BUTTERFLY v3 — ISLAND MODEL EVOLUTION COMPLETE")
    print(f"{'='*70}")
    print(f"Genome: {len(GENE_NAMES)} genes | Islands: {len(ISLANDS)} | "
          f"Total interactions: {4 * 50 * 30 * 600:,}")
    print()
    
    for name, r in all_results.items():
        br = r["best_result"]
        print(f"  {name:12s}: fitness={r['best_fitness']:.1f} VDR={br['vdr'] if br else 0:.1f}% "
              f"collab={br['collab'] if br else 0:.2f} ent={br['enterprise'] if br else 0:.2f} "
              f"team={br['team'] if br else 0:.2f} proactive={br['proactive'] if br else 0:.2f}")
    
    print(f"\n  Overall best island: {overall_best_island}")
    print(f"  Overall best fitness: {overall_best['best_fitness']:.1f}")
    print(f"  Baseline fitness: {base_fitness['fitness']:.1f}")
    print(f"  Improvement: +{report['improvement']:.1f}")
    print(f"  Genes changed: {len(report['genome_changes'])}")
    
    print(f"\n--- Key Architectural Mutations ---")
    for g, c in report["genome_changes"].items():
        bl = c.get("baseline_label", c["baseline"])
        el = c.get("evolved_label", c["evolved"])
        print(f"  [{c['category']}] {g}: {bl} → {el}")
    
    print(f"\n--- Cross-Island Migration ---")
    for src, r in migration_results.items():
        print(f"  {src} → " + " | ".join(f"{k}={v:.1f}" for k, v in r["cross_island_scores"].items()))
    
    print(f"\n{report['safety_note']}")


if __name__ == "__main__":
    main()
