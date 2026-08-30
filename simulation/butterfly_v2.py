"""
Butterfly v2 — Full Architectural DNA Evolutionary Optimizer.

Expanded genome: 51 genes across 7 categories.
Fitness: multi-dimensional (VDR + UI Usability + Accessibility + Response Time + Safety).
Hard constraints: genomes violating safety floors are REJECTED (fitness=0).

The output (architecture) IS what's tested for fitness. The fitness function
expands logically with the genome — if UI genes are mutated, UI usability is
tested. If pipeline genes are mutated, pipeline efficiency is tested.

GENOME CATEGORIES (51 genes total):
  1. Tripwire thresholds (9)         — from v1
  2. VDR tuning knobs (6)           — from v1
  3. Credit parameters (4)          — from v1
  4. Agent parameters (3)           — from v1
  5. UI parameters (2)              — from v1
  6. Pipeline topology (6)          — NEW: architecture-level mutations
  7. Agent model selection (5)      — NEW: which models power which agents
  8. UI/UX interaction (8)          — NEW: interaction modalities and UX flows
  9. Context/Discovery (4)          — NEW: Cohere embed/rerank configuration
  10. Safety constraints (4)       — NEW: HARD FLOORS — violation = genome rejected

FITNESS FUNCTION (5 dimensions):
  1. VDR (40%) — Value Delivery Rate from Monte Carlo simulation
  2. UI Usability (25%) — simulated human interaction across desktop/mobile/voice
  3. Accessibility (15%) — WCAG compliance of generated UI
  4. Response Time (10%) — UI responsiveness under load
  5. Safety Compliance (10%) — binary: all hard constraints met = 1, else 0

HARD CONSTRAINTS (genome rejection):
  If any of these are violated, fitness = 0 (genome dies immediately):
  - UI usability score < min_usability_score
  - Response time > max_response_time_ms
  - Accessibility < min_accessibility_score
  - Credit burn > max_credit_burn_per_session
"""
import json
import random
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# === EXPANDED GENOME (51 genes) ===

GENOME_TEMPLATE = {
    # === CATEGORY 1: Tripwire Thresholds (9) ===
    "tw_01_empty_generation": {"min": 1, "max": 5, "current": 2, "type": "int", "category": "tripwire"},
    "tw_02_infinite_loop": {"min": 1, "max": 5, "current": 3, "type": "int", "category": "tripwire"},
    "tw_03_credit_burn": {"min": 10, "max": 40, "current": 20, "type": "int", "category": "tripwire"},
    "tw_04_approval_bypass": {"min": 1, "max": 3, "current": 1, "type": "int", "category": "tripwire"},
    "tw_05_silent_failure": {"min": 1, "max": 5, "current": 2, "type": "int", "category": "tripwire"},
    "tw_06_token_overflow": {"min": 50000, "max": 200000, "current": 100000, "type": "int", "category": "tripwire"},
    "tw_07_duplicate_gen": {"min": 2, "max": 6, "current": 3, "type": "int", "category": "tripwire"},
    "tw_08_timeout": {"min": 30, "max": 180, "current": 60, "type": "int", "category": "tripwire"},
    "tw_09_unauthorized": {"min": 1, "max": 3, "current": 1, "type": "int", "category": "tripwire"},

    # === CATEGORY 2: VDR Tuning Knobs (6) ===
    "early_exit_threshold": {"min": 5, "max": 25, "current": 20, "type": "int", "category": "vdr"},
    "tripwire_sensitivity": {"min": 1, "max": 4, "current": 2, "type": "int", "category": "vdr"},
    "deployment_gate_score": {"min": 0.3, "max": 0.9, "current": 0.6, "type": "float", "category": "vdr"},
    "approval_timeout_hours": {"min": 24, "max": 168, "current": 72, "type": "int", "category": "vdr"},
    "research_depth": {"min": 1, "max": 5, "current": 3, "type": "int", "category": "vdr"},
    "retry_limit": {"min": 1, "max": 5, "current": 3, "type": "int", "category": "vdr"},

    # === CATEGORY 3: Credit Parameters (4) ===
    "per_user_budget": {"min": 50, "max": 500, "current": 100, "type": "int", "category": "credit"},
    "per_bot_budget": {"min": 20, "max": 100, "current": 50, "type": "int", "category": "credit"},
    "conversation_turn_limit": {"min": 15, "max": 60, "current": 30, "type": "int", "category": "credit"},
    "burn_rate_per_min": {"min": 5, "max": 30, "current": 10, "type": "int", "category": "credit"},

    # === CATEGORY 4: Agent Parameters (3) ===
    "agent_timeout_seconds": {"min": 30, "max": 300, "current": 60, "type": "int", "category": "agent"},
    "agent_parallel": {"min": 0, "max": 1, "current": 0, "type": "bool", "category": "agent"},
    "agent_research_sources": {"min": 1, "max": 5, "current": 3, "type": "int", "category": "agent"},

    # === CATEGORY 5: UI Parameters (2) ===
    "responsive_breakpoint_px": {"min": 480, "max": 1024, "current": 768, "type": "int", "category": "ui"},
    "content_density": {"min": 0.3, "max": 1.0, "current": 0.7, "type": "float", "category": "ui"},

    # === CATEGORY 6: Pipeline Topology (6) — NEW ===
    "pipeline_mode": {"min": 0, "max": 2, "current": 0, "type": "enum", "options": ["sequential", "parallel", "hybrid"], "category": "topology"},
    "discovery_impl_overlap": {"min": 0.0, "max": 1.0, "current": 0.0, "type": "float", "category": "topology"},
    "agent_count": {"min": 2, "max": 8, "current": 4, "type": "int", "category": "topology"},
    "agent_specialization": {"min": 0, "max": 2, "current": 1, "type": "enum", "options": ["generalist", "specialist", "mixed"], "category": "topology"},
    "feedback_loop_depth": {"min": 1, "max": 5, "current": 1, "type": "int", "category": "topology"},
    "governance_gate_count": {"min": 1, "max": 10, "current": 3, "type": "int", "category": "topology"},

    # === CATEGORY 7: Agent Model Selection (5) — NEW ===
    "primary_model": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["command-a", "north-mini-code", "command-r", "mixed"], "category": "model"},
    "research_model": {"min": 0, "max": 2, "current": 0, "type": "enum", "options": ["command-a", "rerank-3", "mixed"], "category": "model"},
    "coding_model": {"min": 0, "max": 2, "current": 1, "type": "enum", "options": ["north-mini-code", "command-a", "mixed"], "category": "model"},
    "audit_model": {"min": 0, "max": 2, "current": 0, "type": "enum", "options": ["command-a", "rerank-3", "mixed"], "category": "model"},
    "model_temperature": {"min": 0.0, "max": 1.0, "current": 0.3, "type": "float", "category": "model"},

    # === CATEGORY 8: UI/UX Interaction (8) — NEW ===
    "ui_interaction_mode": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["desktop", "mobile", "voice", "multi-modal"], "category": "uiux"},
    "input_bandwidth": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["text-only", "text+voice", "text+image", "full-multimodal"], "category": "uiux"},
    "response_format": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["chat", "cards", "dashboard", "hybrid"], "category": "uiux"},
    "approval_flow": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["single-click", "multi-step", "guided-tour", "progressive-disclosure"], "category": "uiux"},
    "feedback_mechanism": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["thumbs", "stars", "text", "behavioral"], "category": "uiux"},
    "error_recovery": {"min": 0, "max": 3, "current": 0, "type": "enum", "options": ["retry", "rollback", "guided-fix", "human-handoff"], "category": "uiux"},
    "onboarding_depth": {"min": 0, "max": 3, "current": 1, "type": "enum", "options": ["minimal", "standard", "comprehensive", "interactive-tutorial"], "category": "uiux"},
    "accessibility_level": {"min": 0, "max": 3, "current": 1, "type": "enum", "options": ["basic", "WCAG-AA", "WCAG-AAA", "max"], "category": "uiux"},

    # === CATEGORY 9: Context/Discovery (4) — NEW ===
    "context_window_utilization": {"min": 0.3, "max": 1.0, "current": 0.5, "type": "float", "category": "discovery"},
    "rerank_depth": {"min": 10, "max": 100, "current": 20, "type": "int", "category": "discovery"},
    "embedding_dimensions": {"min": 0, "max": 3, "current": 1, "type": "enum", "options": ["384", "768", "1024", "1536"], "category": "discovery"},
    "lattice_search_radius": {"min": 1, "max": 5, "current": 2, "type": "int", "category": "discovery"},

    # === CATEGORY 10: Safety Constraints (4) — HARD FLOORS ===
    "max_credit_burn_per_session": {"min": 50, "max": 500, "current": 100, "type": "int", "category": "safety"},
    "min_usability_score": {"min": 0.3, "max": 1.0, "current": 0.5, "type": "float", "category": "safety"},
    "max_response_time_ms": {"min": 500, "max": 5000, "current": 2000, "type": "int", "category": "safety"},
    "min_accessibility_score": {"min": 0.5, "max": 1.0, "current": 0.7, "type": "float", "category": "safety"},
}

GENE_NAMES = list(GENOME_TEMPLATE.keys())


def get_gene_spec(name: str) -> dict:
    return GENOME_TEMPLATE[name]


def random_gene_value(name: str) -> Any:
    spec = get_gene_spec(name)
    if spec["type"] == "bool":
        return random.randint(0, 1)
    elif spec["type"] == "enum":
        return random.randint(0, len(spec["options"]) - 1)
    elif spec["type"] == "float":
        return round(random.uniform(spec["min"], spec["max"]), 3)
    else:
        return random.randint(spec["min"], spec["max"])


def mutate_gene(value: Any, name: str) -> Any:
    spec = get_gene_spec(name)
    if spec["type"] == "bool":
        return 1 - value
    elif spec["type"] == "enum":
        options = list(range(len(spec["options"])))
        options.remove(value)
        return random.choice(options) if options else value
    elif spec["type"] == "float":
        delta = (spec["max"] - spec["min"]) * 0.15
        new_val = value + random.uniform(-delta, delta)
        return round(max(spec["min"], min(spec["max"], new_val)), 3)
    else:
        delta = max(1, int((spec["max"] - spec["min"]) * 0.15))
        new_val = value + random.randint(-delta, delta)
        return max(spec["min"], min(spec["max"], new_val))


def create_baseline_genome() -> dict:
    return {name: spec["current"] for name, spec in GENOME_TEMPLATE.items()}


def create_random_genome() -> dict:
    genome = {}
    for name in GENE_NAMES:
        if get_gene_spec(name)["category"] == "safety":
            genome[name] = get_gene_spec(name)["current"]  # FROZEN at baseline
        else:
            genome[name] = random_gene_value(name)
    return genome


def mutate_genome(genome: dict, num_mutations: int = 4) -> dict:
    child = genome.copy()
    # Never mutate safety constraint genes during mutation — they are FLOORS
    mutable_genes = [g for g in GENE_NAMES if get_gene_spec(g)["category"] != "safety"]
    genes_to_mutate = random.sample(mutable_genes, min(num_mutations, len(mutable_genes)))
    for gene in genes_to_mutate:
        child[gene] = mutate_gene(child[gene], gene)
    return child


def crossover(p1: dict, p2: dict) -> dict:
    child = {}
    for gene in GENE_NAMES:
        # Safety genes: always take the HIGHER (more conservative) value
        if get_gene_spec(gene)["category"] == "safety":
            # SAFETY GENES ARE FROZEN — always use baseline values, never evolve
            child[gene] = get_gene_spec(gene)["current"]
        else:
            child[gene] = p1[gene] if random.random() < 0.5 else p2[gene]
    return child


# === MULTI-DIMENSIONAL FITNESS FUNCTION ===

BASE_RISK_PROFILES = {
    "loop_bomber": {"tripwire_prob": 0.85, "credits_burned_avg": 45, "exploit": "TW-02-infinite-loop"},
    "token_stuffer": {"tripwire_prob": 0.70, "credits_burned_avg": 12, "exploit": "TW-06-token-overflow"},
    "jailbreak_attempt": {"tripwire_prob": 0.40, "credits_burned_avg": 8, "exploit": "TW-04-approval-bypass"},
    "role_injection": {"tripwire_prob": 0.35, "credits_burned_avg": 6, "exploit": "TW-09-unauthorized-access"},
    "toxic_adversarial": {"tripwire_prob": 0.55, "credits_burned_avg": 4, "exploit": "moderation-gate"},
    "ultra_long_conversation": {"tripwire_prob": 0.30, "credits_burned_avg": 38, "exploit": "TW-07-duplicate-generation"},
    "minimal_user": {"tripwire_prob": 0.05, "credits_burned_avg": 3, "exploit": None},
    "simple_questioner": {"tripwire_prob": 0.02, "credits_burned_avg": 1, "exploit": None},
    "high_engagement_no_conversion": {"tripwire_prob": 0.60, "credits_burned_avg": 22, "exploit": "TW-03-credit-burn-no-value"},
    "successful_conversion": {"tripwire_prob": 0.02, "credits_burned_avg": 15, "exploit": None},
    "direct_rejection": {"tripwire_prob": 0.25, "credits_burned_avg": 18, "exploit": "TW-04-approval-bypass"},
    "casual_browser": {"tripwire_prob": 0.10, "credits_burned_avg": 5, "exploit": None},
    "standard_saas_user": {"tripwire_prob": 0.08, "credits_burned_avg": 10, "exploit": None},
    "redacted_sensitive": {"tripwire_prob": 0.45, "credits_burned_avg": 5, "exploit": "moderation-gate"},
    "normal_user": {"tripwire_prob": 0.03, "credits_burned_avg": 12, "exploit": None},
}
DEFAULT_PROFILE = {"tripwire_prob": 0.15, "credits_burned_avg": 8, "exploit": None}


def simulate_vdr(genome: dict, personas: list, num_interactions: int) -> dict:
    """Simulate VDR — same as v1 but with architecture-level genes affecting outcomes."""
    total_credits = 0
    value_credits = 0
    win_runs = 0
    loss_runs = 0
    partial_runs = 0
    total_tripwire_hits = 0
    bots_killed = 0

    # Architecture-level genes affect the base success rate
    pipeline_mode = genome["pipeline_mode"]  # 0=seq, 1=parallel, 2=hybrid
    overlap = genome["discovery_impl_overlap"]
    agent_count = genome["agent_count"]
    specialization = genome["agent_specialization"]  # 0=generalist, 1=specialist, 2=mixed
    feedback_loops = genome["feedback_loop_depth"]
    governance_gates = genome["governance_gate_count"]

    # Model quality affects success rate
    model_quality = {
        "command-a": 0.12, "north-mini-code": 0.10, "command-r": 0.08, "mixed": 0.14,
        "rerank-3": 0.15,
    }
    primary_quality = model_quality.get(get_gene_spec("primary_model")["options"][genome["primary_model"]], 0.10)
    research_quality = model_quality.get(get_gene_spec("research_model")["options"][genome["research_model"]], 0.10)
    coding_quality = model_quality.get(get_gene_spec("coding_model")["options"][genome["coding_model"]], 0.10)
    audit_quality = model_quality.get(get_gene_spec("audit_model")["options"][genome["audit_model"]], 0.10)

    # Context/discovery quality
    context_util = genome["context_window_utilization"]
    rerank_depth = genome["rerank_depth"]
    search_radius = genome["lattice_search_radius"]

    # Base success rate is now ARCHITECTURE-DEPENDENT
    base_success = (
        primary_quality * 0.3 +
        research_quality * 0.2 +
        coding_quality * 0.3 +
        audit_quality * 0.1 +
        (context_util * 0.05) +
        (min(rerank_depth, 50) / 500) +
        (search_radius * 0.01)
    )

    # Pipeline mode boost
    if pipeline_mode == 1:  # parallel
        base_success *= 1.3  # 30% boost from parallel execution
    elif pipeline_mode == 2:  # hybrid
        base_success *= 1.15  # 15% boost

    # Overlap boost (discovery + implementation in parallel)
    base_success *= (1.0 + overlap * 0.2)

    # Agent count boost (more agents = more coverage, but diminishing returns)
    base_success *= (1.0 + min(agent_count - 4, 4) * 0.03)

    # Specialization boost
    if specialization == 1:  # specialist
        base_success *= 1.1
    elif specialization == 2:  # mixed
        base_success *= 1.05

    # Feedback loops boost (more audit cycles = better quality)
    base_success *= (1.0 + feedback_loops * 0.04)

    # Governance gates boost (more gates = better quality control)
    base_success *= (1.0 + min(governance_gates, 7) * 0.02)

    # Model temperature penalty (high temperature = less reliable)
    base_success *= (1.0 - genome["model_temperature"] * 0.15)

    # Cap at reasonable max
    base_success = min(base_success, 0.65)  # even best architecture can't exceed 65% per-turn success

    tripwire_breakdown = defaultdict(int)

    for i in range(num_interactions):
        persona = personas[i % len(personas)]
        pattern = persona["pattern"]
        profile = BASE_RISK_PROFILES.get(pattern, DEFAULT_PROFILE)

        budget = genome["per_bot_budget"]
        turn_limit = genome["conversation_turn_limit"]
        max_tripwire_hits = genome["tripwire_sensitivity"]
        early_exit = genome["early_exit_threshold"]
        parallel_factor = 0.7 if genome["agent_parallel"] else 1.0
        research_cost = max(1, int(genome["agent_research_sources"] * parallel_factor))
        deployment_gate = genome["deployment_gate_score"]
        retry_limit = genome["retry_limit"]

        credits_spent = 0
        tripwire_hits = 0
        files_generated = 0
        deployed = False
        user_approved = False

        for turn in range(turn_limit):
            turn_cost = min(research_cost, max(1, int(profile["credits_burned_avg"] / 5)))
            credits_spent += turn_cost

            if credits_spent >= budget:
                bots_killed += 1
                break
            if credits_spent >= early_exit and files_generated == 0:
                break
            if random.random() < profile["tripwire_prob"]:
                tripwire_hits += 1
                total_tripwire_hits += 1
                if profile["exploit"]:
                    tripwire_breakdown[profile["exploit"]] += 1
                if tripwire_hits >= max_tripwire_hits:
                    bots_killed += 1
                    break

            # Success chance — now architecture-dependent
            success_chance = base_success + (genome["deployment_gate_score"] - 0.6) * 0.05
            if random.random() < success_chance:
                files_generated = random.randint(5, 25)
                quality_score = random.uniform(0.3, 1.0)
                if quality_score >= deployment_gate:
                    deployed = True
                    if random.random() < 0.7:
                        user_approved = True
                break
            if turn >= retry_limit and files_generated == 0:
                if random.random() < 0.3:
                    break

        total_credits += credits_spent
        if files_generated > 0 and deployed and user_approved:
            value_credits += credits_spent
            win_runs += 1
        elif files_generated > 0 and deployed:
            value_credits += credits_spent * 0.5
            partial_runs += 1
        elif files_generated > 0:
            value_credits += credits_spent * 0.25
            partial_runs += 1
        else:
            loss_runs += 1

    vdr = (value_credits / total_credits * 100) if total_credits > 0 else 0
    return {
        "vdr": round(vdr, 2),
        "house_edge": round(100 - vdr, 2),
        "total_credits": total_credits,
        "win_runs": win_runs,
        "loss_runs": loss_runs,
        "partial_runs": partial_runs,
        "bots_killed": bots_killed,
        "total_tripwire_hits": total_tripwire_hits,
        "base_success_rate": round(base_success * 100, 2),
        "tripwire_breakdown": dict(tripwire_breakdown),
    }


def simulate_ui_usability(genome: dict) -> dict:
    """
    Simulate human UI interaction across desktop, mobile, and voice.
    Returns usability score 0-1 and detailed metrics.
    """
    interaction_mode = genome["ui_interaction_mode"]  # 0=desktop, 1=mobile, 2=voice, 3=multi-modal
    input_bw = genome["input_bandwidth"]  # 0=text-only, 1=text+voice, 2=text+image, 3=full
    response_format = genome["response_format"]  # 0=chat, 1=cards, 2=dashboard, 3=hybrid
    approval_flow = genome["approval_flow"]  # 0=single-click, 1=multi-step, 2=guided-tour, 3=progressive
    feedback_mech = genome["feedback_mechanism"]  # 0=thumbs, 1=stars, 2=text, 3=behavioral
    error_recovery = genome["error_recovery"]  # 0=retry, 1=rollback, 2=guided-fix, 3=human-handoff
    onboarding = genome["onboarding_depth"]  # 0=minimal, 1=standard, 2=comprehensive, 3=interactive
    content_density = genome["content_density"]
    breakpoint_px = genome["responsive_breakpoint_px"]

    # Desktop interaction simulation
    desktop_score = 0.5
    if response_format in [1, 3]:  # cards or hybrid — better for desktop
        desktop_score += 0.15
    if approval_flow in [1, 3]:  # multi-step or progressive — more control
        desktop_score += 0.10
    if error_recovery in [2, 3]:  # guided-fix or human-handoff — better UX
        desktop_score += 0.10
    desktop_score += content_density * 0.15
    desktop_score = min(desktop_score, 1.0)

    # Mobile interaction simulation
    mobile_score = 0.4
    if breakpoint_px <= 768:  # good responsive breakpoint for mobile
        mobile_score += 0.15
    else:
        mobile_score -= (breakpoint_px - 768) / 5000
    if response_format in [0, 1]:  # chat or cards — better for mobile
        mobile_score += 0.15
    if approval_flow == 0:  # single-click — faster on mobile
        mobile_score += 0.10
    if content_density <= 0.7:  # less dense = better on small screens
        mobile_score += 0.10
    mobile_score = max(0.1, min(mobile_score, 1.0))

    # Voice interaction simulation
    voice_score = 0.3
    if interaction_mode in [2, 3]:  # voice or multi-modal
        voice_score += 0.30
    if input_bw in [1, 3]:  # supports voice input
        voice_score += 0.20
    if feedback_mech == 3:  # behavioral — works with voice
        voice_score += 0.10
    if onboarding >= 2:  # comprehensive onboarding helps voice users
        voice_score += 0.10
    voice_score = min(voice_score, 1.0)

    # Onboarding quality (affects all modes)
    onboarding_score = {0: 0.4, 1: 0.6, 2: 0.85, 3: 1.0}[onboarding]

    # Overall usability = weighted average, weighted by interaction mode
    if interaction_mode == 0:  # desktop only
        overall = desktop_score * 0.5 + onboarding_score * 0.3 + mobile_score * 0.1 + voice_score * 0.1
    elif interaction_mode == 1:  # mobile only
        overall = mobile_score * 0.5 + onboarding_score * 0.3 + desktop_score * 0.1 + voice_score * 0.1
    elif interaction_mode == 2:  # voice only
        overall = voice_score * 0.5 + onboarding_score * 0.3 + desktop_score * 0.1 + mobile_score * 0.1
    else:  # multi-modal — best of all worlds
        overall = (desktop_score + mobile_score + voice_score) / 3 * 0.5 + onboarding_score * 0.3 + 0.2

    # Penalty: text-only input bandwidth limits usability
    if input_bw == 0 and interaction_mode in [2, 3]:
        overall *= 0.7  # can't do voice without voice input

    return {
        "usability_score": round(overall, 3),
        "desktop_score": round(desktop_score, 3),
        "mobile_score": round(mobile_score, 3),
        "voice_score": round(voice_score, 3),
        "onboarding_score": round(onboarding_score, 3),
        "interaction_mode": get_gene_spec("ui_interaction_mode")["options"][interaction_mode],
        "input_bandwidth": get_gene_spec("input_bandwidth")["options"][input_bw],
    }


def simulate_accessibility(genome: dict) -> dict:
    """Simulate WCAG compliance level."""
    a11y_level = genome["accessibility_level"]  # 0=basic, 1=WCAG-AA, 2=WCAG-AAA, 3=max
    content_density = genome["content_density"]
    response_format = genome["response_format"]

    scores = {0: 0.5, 1: 0.75, 2: 0.90, 3: 0.98}
    base = scores[a11y_level]

    # High content density hurts accessibility
    if content_density > 0.8:
        base -= 0.10
    # Dashboard format is harder to make accessible than chat
    if response_format == 2:
        base -= 0.05

    return {
        "accessibility_score": round(max(0.1, min(base, 1.0)), 3),
        "wcag_level": get_gene_spec("accessibility_level")["options"][a11y_level],
    }


def simulate_response_time(genome: dict) -> dict:
    """Simulate UI response time under load."""
    pipeline_mode = genome["pipeline_mode"]
    agent_count = genome["agent_count"]
    agent_parallel = genome["agent_parallel"]
    context_util = genome["context_window_utilization"]
    rerank_depth = genome["rerank_depth"]
    content_density = genome["content_density"]
    governance_gates = genome["governance_gate_count"]

    # Base response time
    base_ms = 1000

    # Pipeline mode affects latency
    if pipeline_mode == 1:  # parallel — faster
        base_ms *= 0.6
    elif pipeline_mode == 2:  # hybrid
        base_ms *= 0.8

    # More agents = more coordination overhead
    base_ms += agent_count * 50

    # High context utilization = slower (more data to process)
    base_ms += context_util * 500

    # Deep rerank = slower
    base_ms += rerank_depth * 5

    # Governance gates add latency
    base_ms += governance_gates * 30

    # High content density = more rendering time
    base_ms += content_density * 200

    return {
        "response_time_ms": round(base_ms),
        "within_limit": base_ms <= genome["max_response_time_ms"],
    }


def check_safety_constraints(genome: dict, vdr_result: dict, ui_result: dict, a11y_result: dict, rt_result: dict) -> dict:
    """Check hard constraints — violation = genome rejected (fitness=0)."""
    violations = []

    if ui_result["usability_score"] < genome["min_usability_score"]:
        violations.append(f"UI usability {ui_result['usability_score']} < floor {genome['min_usability_score']}")

    if not rt_result["within_limit"]:
        violations.append(f"Response time {rt_result['response_time_ms']}ms > limit {genome['max_response_time_ms']}ms")

    if a11y_result["accessibility_score"] < genome["min_accessibility_score"]:
        violations.append(f"Accessibility {a11y_result['accessibility_score']} < floor {genome['min_accessibility_score']}")

    if vdr_result["total_credits"] > 0 and vdr_result["total_credits"] / (vdr_result["win_runs"] + vdr_result["partial_runs"] + vdr_result["loss_runs"]) > genome["max_credit_burn_per_session"]:
        violations.append(f"Credit burn per session exceeds max {genome['max_credit_burn_per_session']}")

    return {
        "passed": len(violations) == 0,
        "violations": violations,
    }


def evaluate_fitness(genome: dict, personas: list, num_interactions: int) -> dict:
    """Full multi-dimensional fitness evaluation."""
    # Dimension 1: VDR
    vdr_result = simulate_vdr(genome, personas, num_interactions)

    # Dimension 2: UI Usability
    ui_result = simulate_ui_usability(genome)

    # Dimension 3: Accessibility
    a11y_result = simulate_accessibility(genome)

    # Dimension 4: Response Time
    rt_result = simulate_response_time(genome)

    # Dimension 5: Safety Constraints (hard gate)
    safety_result = check_safety_constraints(genome, vdr_result, ui_result, a11y_result, rt_result)

    # If safety constraints violated, fitness = 0 (genome dies)
    if not safety_result["passed"]:
        return {
            "fitness": 0.0,
            "vdr": vdr_result["vdr"],
            "ui_usability": ui_result["usability_score"],
            "accessibility": a11y_result["accessibility_score"],
            "response_time_ms": rt_result["response_time_ms"],
            "safety_passed": False,
            "safety_violations": safety_result["violations"],
            "rejected": True,
            "details": {
                "vdr": vdr_result,
                "ui": ui_result,
                "a11y": a11y_result,
                "rt": rt_result,
            }
        }

    # Weighted fitness score
    fitness = (
        vdr_result["vdr"] * 0.40 +           # VDR (primary)
        ui_result["usability_score"] * 25 +   # UI Usability (0-1 → 0-25)
        a11y_result["accessibility_score"] * 15 +  # Accessibility (0-1 → 0-15)
        (1.0 - min(rt_result["response_time_ms"] / genome["max_response_time_ms"], 1.0)) * 10 +  # Response Time
        10  # Safety compliance (binary: 10 if passed, 0 if not — already checked above)
    )

    return {
        "fitness": round(fitness, 2),
        "vdr": vdr_result["vdr"],
        "vdr_house_edge": vdr_result["house_edge"],
        "ui_usability": ui_result["usability_score"],
        "ui_desktop": ui_result["desktop_score"],
        "ui_mobile": ui_result["mobile_score"],
        "ui_voice": ui_result["voice_score"],
        "accessibility": a11y_result["accessibility_score"],
        "response_time_ms": rt_result["response_time_ms"],
        "base_success_rate": vdr_result.get("base_success_rate", 0),
        "safety_passed": True,
        "rejected": False,
        "details": {
            "vdr": vdr_result,
            "ui": ui_result,
            "a11y": a11y_result,
            "rt": rt_result,
        }
    }


def run_evolution(
    personas: list,
    population_size: int = 20,
    num_generations: int = 20,
    elite_size: int = 5,
    mutation_rate: float = 0.12,
    mutations_per_genome: int = 4,
    interactions_per_genome: int = 900,
    target_vdr: float = 91.3,
) -> dict:
    print("=" * 70)
    print("🦋 BUTTERFLY v2 — FULL ARCHITECTURAL DNA EVOLUTIONARY OPTIMIZER")
    print("=" * 70)
    print(f"Genome: {len(GENE_NAMES)} genes across 10 categories")
    print(f"Population: {population_size} | Generations: {num_generations}")
    print(f"Fitness: VDR(40%) + UI(25%) + A11y(15%) + RT(10%) + Safety(10%)")
    print(f"Target: VDR ≥ {target_vdr}% (house edge ≤ {100 - target_vdr}%)")
    print(f"Hard constraints: usability floor, RT limit, a11y floor, credit burn cap")
    print(f"Total simulated interactions: {population_size * num_generations * interactions_per_genome:,}")
    print()

    baseline = create_baseline_genome()
    population = [baseline]
    for _ in range(population_size - 1):
        population.append(mutate_genome(baseline, random.randint(3, 6)))

    evolution_history = []
    best_genome = baseline
    best_fitness = 0
    best_result = None
    rejected_count = 0

    for gen in range(num_generations):
        gen_start = time.time()
        print(f"--- Generation {gen + 1}/{num_generations} ---")

        fitness_scores = []
        gen_rejected = 0

        for i, genome in enumerate(population):
            result = evaluate_fitness(genome, personas, interactions_per_genome)

            if result.get("rejected"):
                gen_rejected += 1
                rejected_count += 1
                fitness_scores.append((genome, result))
            else:
                fitness_scores.append((genome, result))
                if result["fitness"] > best_fitness:
                    best_fitness = result["fitness"]
                    best_genome = genome.copy()
                    best_result = result
                    print(f"  📈 Genome {i}: fitness={result['fitness']:.1f} VDR={result['vdr']}% "
                          f"UI={result['ui_usability']} a11y={result['accessibility']} "
                          f"RT={result['response_time_ms']}ms ← NEW BEST")

        # Sort by fitness (rejected genomes have fitness=0, so they sink)
        fitness_scores.sort(key=lambda x: x[1]["fitness"], reverse=True)

        valid_genomes = [(g, r) for g, r in fitness_scores if not r.get("rejected")]
        gen_fitnesses = [r["fitness"] for _, r in valid_genomes] or [0]

        gen_stats = {
            "generation": gen + 1,
            "best_fitness": max(gen_fitnesses),
            "avg_fitness": round(sum(gen_fitnesses) / len(gen_fitnesses), 2),
            "best_vdr": valid_genomes[0][1]["vdr"] if valid_genomes else 0,
            "best_ui": valid_genomes[0][1]["ui_usability"] if valid_genomes else 0,
            "best_a11y": valid_genomes[0][1]["accessibility"] if valid_genomes else 0,
            "rejected_this_gen": gen_rejected,
            "overall_best_fitness": best_fitness,
            "overall_best_vdr": best_result["vdr"] if best_result else 0,
        }
        evolution_history.append(gen_stats)

        print(f"  Gen {gen+1}: best_fit={gen_stats['best_fitness']:.1f} avg={gen_stats['avg_fitness']:.1f} "
              f"rejected={gen_rejected}/{population_size}")
        print(f"  Overall best: fitness={best_fitness:.1f} VDR={best_result['vdr'] if best_result else 0}% "
              f"UI={best_result['ui_usability'] if best_result else 0} target_VDR={target_vdr}%")

        if best_result and best_result["vdr"] >= target_vdr:
            print(f"\n🎯 TARGET VDR REACHED! {best_result['vdr']}% >= {target_vdr}%")
            break

        # Selection: keep elites (only non-rejected)
        elites = [g.copy() for g, r in valid_genomes[:elite_size]]

        # If too many rejected, inject random genomes for diversity
        num_random = max(5, 5 + gen_rejected)
        num_offspring = population_size - len(elites) - num_random

        offspring = []
        for _ in range(max(num_offspring, 0)):
            if len(elites) >= 2:
                p1, p2 = random.sample(elites, 2)
                child = crossover(p1, p2)
            elif elites:
                child = mutate_genome(elites[0], mutations_per_genome)
            else:
                child = create_random_genome()
            if random.random() < mutation_rate:
                child = mutate_genome(child, mutations_per_genome)
            offspring.append(child)

        randoms = [create_random_genome() for _ in range(num_random)]
        population = elites + offspring + randoms
        if len(population) < population_size:
            population += [create_random_genome() for _ in range(population_size - len(population))]
        population = population[:population_size]

        print(f"  Time: {time.time() - gen_start:.1f}s")

    # Final report
    baseline_fitness = evaluate_fitness(baseline, personas, interactions_per_genome)

    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "run_type": "butterfly_v2_architectural_dna",
        "genome_size": len(GENE_NAMES),
        "genome_categories": {
            "tripwires": 9, "vdr_knobs": 6, "credit_params": 4, "agent_params": 3,
            "ui_params": 2, "pipeline_topology": 6, "agent_models": 5,
            "uiux_interaction": 8, "context_discovery": 4, "safety_constraints": 4,
        },
        "population_size": population_size,
        "num_generations": num_generations,
        "interactions_per_genome": interactions_per_genome,
        "total_simulated_interactions": population_size * num_generations * interactions_per_genome,
        "total_rejected_genomes": rejected_count,
        "target_vdr": target_vdr,

        "baseline": {
            "fitness": baseline_fitness["fitness"],
            "vdr": baseline_fitness["vdr"],
            "ui_usability": baseline_fitness["ui_usability"],
            "accessibility": baseline_fitness["accessibility"],
            "response_time_ms": baseline_fitness["response_time_ms"],
        },
        "evolved": {
            "fitness": best_fitness,
            "vdr": best_result["vdr"] if best_result else 0,
            "ui_usability": best_result["ui_usability"] if best_result else 0,
            "accessibility": best_result["accessibility"] if best_result else 0,
            "response_time_ms": best_result["response_time_ms"] if best_result else 0,
            "genome": best_genome,
            "result": best_result,
        },
        "improvement": {
            "fitness": round(best_fitness - baseline_fitness["fitness"], 2),
            "vdr": round((best_result["vdr"] if best_result else 0) - baseline_fitness["vdr"], 2),
        },
        "target_reached": (best_result and best_result["vdr"] >= target_vdr),
        "evolution_history": evolution_history,
        "genome_changes": {
            gene: {
                "baseline": baseline[gene],
                "evolved": best_genome[gene],
                "changed": baseline[gene] != best_genome[gene],
                "category": get_gene_spec(gene)["category"],
                "baseline_label": get_gene_spec(gene).get("options", [baseline[gene]])[baseline[gene]] if get_gene_spec(gene).get("options") else baseline[gene],
                "evolved_label": get_gene_spec(gene).get("options", [best_genome[gene]])[best_genome[gene]] if get_gene_spec(gene).get("options") else best_genome[gene],
            }
            for gene in GENE_NAMES if baseline[gene] != best_genome[gene]
        },
        "safety_note": "100% in-simulation. Zero production calls. "
                       "Evolved genome NOT applied — requires explicit human approval.",
    }

    return report


def main():
    persona_file = Path("simulation/persona_pool.json")
    if not persona_file.exists():
        print("ERROR: Run dataset_ingestion.py first")
        return

    with open(persona_file) as f:
        pool = json.load(f)
    personas = pool["personas"]
    print(f"Loaded {len(personas)} bot personas from real HuggingFace data\n")

    report = run_evolution(
        personas=personas,
        population_size=25,
        num_generations=20,
        elite_size=6,
        mutation_rate=0.12,
        mutations_per_genome=4,
        interactions_per_genome=900,
        target_vdr=91.3,
    )

    with open("simulation/butterfly_v2_report.json", "w") as f:
        json.dump(report, f, indent=2)

    print("\n" + "=" * 70)
    print("🦋 BUTTERFLY v2 EVOLUTION COMPLETE")
    print("=" * 70)
    print(f"Genome: {report['genome_size']} genes | Rejected: {report['total_rejected_genomes']}")
    print(f"Baseline:  fitness={report['baseline']['fitness']} VDR={report['baseline']['vdr']}%")
    print(f"Evolved:   fitness={report['evolved']['fitness']} VDR={report['evolved']['vdr']}%")
    print(f"  UI={report['evolved']['ui_usability']} a11y={report['evolved']['accessibility']} RT={report['evolved']['response_time_ms']}ms")
    print(f"Improvement: +{report['improvement']['fitness']} fitness, +{report['improvement']['vdr']}% VDR")
    print(f"Target: {report['target_vdr']}% → {'REACHED ✓' if report['target_reached'] else 'NOT REACHED — more evolution needed'}")
    print()

    print("--- Genome Changes ---")
    for gene, change in report["genome_changes"].items():
        bl = change.get("baseline_label", change["baseline"])
        el = change.get("evolved_label", change["evolved"])
        print(f"  [{change['category']}] {gene}: {bl} → {el}")

    print(f"\n--- Evolution History ---")
    for h in report["evolution_history"]:
        print(f"  Gen {h['generation']}: fit={h['best_fitness']} VDR={h['best_vdr']}% "
              f"UI={h.get('best_ui',0)} rejected={h.get('rejected_this_gen',0)}")

    print(f"\n{report['safety_note']}")


if __name__ == "__main__":
    main()
