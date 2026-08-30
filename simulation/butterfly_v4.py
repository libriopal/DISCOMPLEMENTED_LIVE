"""
Butterfly v4 — North Star #3 as DNA Constraint.

NS3 (the goal, the constraint, the DNA):
  Every interaction must produce measurably verified value for the user.
  If it doesn't, the system must detect, diagnose, and resolve the gap
  autonomously before the user becomes aware of it — through a deterministic
  agent lattice where each agent's function is genetically separated,
  fitness-governed, and continuously evolving toward zero-waste value delivery.

NS3 is engineered into the fitness function as a HARD CONSTRAINT:
  - Any genome that allows unverified value to reach the user dies (fitness=0)
  - Any genome that can't detect gaps before users dies (fitness=0)
  - Any genome that doesn't separate agents by function dies (fitness=0)
  - Any genome that isn't evolving toward zero-waste dies (fitness=0)

This produces the GLAAS-Lattice: deterministic agent separation where
research → audit → design → code → verify are genetically enforced.
"""
import json, random, time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

# === NS3 DNA CONSTRAINT (engineered into fitness) ===
NS3_SYSTEM_INSTRUCTION = """
NORTH STAR #3 — THE GOAL, THE CONSTRAINT, THE DNA:

Every interaction must produce measurably verified value for the user.
If it doesn't, the system must detect, diagnose, and resolve the gap
autonomously before the user becomes aware of it.

This is achieved through a deterministic agent lattice where:
  1. Agents are SEPARATED by function (research, audit, design, code, verify)
  2. Each agent's output is GOVERNED by fitness-tested constraints
  3. The whole system EVOLVES toward zero-waste value delivery
  4. Unverified value never reaches the user
  5. Gaps are detected and resolved before user awareness

This is the GLAAS-Lattice: Governed Lattice Architecture for Agent Separation.
"""

# Reuse the 85-gene genome from v3
from butterfly_v3 import (
    GENOME_TEMPLATE, GENE_NAMES, get_spec, random_gene, mutate_val,
    baseline_genome, random_genome, mutate_genome, crossover,
    ISLANDS, RISK_PROFILES, DEFAULT_P, MODEL_QUALITY,
    simulate_vdr, simulate_ui, simulate_a11y, simulate_rt,
    simulate_proactive, simulate_collab, simulate_enterprise, simulate_team,
    check_safety,
)

# === NS3 FITNESS: Adds zero-waste and agent-separation dimensions ===

def simulate_agent_separation(g):
    """NS3 requires deterministic agent separation by function.
    Score 0 if agents aren't separated, 1 if fully separated."""
    score = 0.0

    # Pipeline mode must be parallel or hybrid (separation requires parallelism)
    if g["pipeline_mode"] >= 1:
        score += 0.20

    # Agent specialization must be specialist or mixed (separation = specialization)
    if g["agent_specialization"] >= 1:
        score += 0.20

    # Agent count >= 4 (need at least research/audit/code/verify)
    if g["agent_count"] >= 4:
        score += 0.15

    # Feedback loop depth >= 2 (audit → implement → audit cycle)
    if g["feedback_loop_depth"] >= 2:
        score += 0.15

    # Governance gates >= 3 (verification between each agent)
    if g["governance_gate_count"] >= 3:
        score += 0.10

    # Discovery/implementation overlap enables parallel separation
    if g["discovery_impl_overlap"] >= 0.5:
        score += 0.10

    # Retry limit >= 3 (system must retry failed verification)
    if g["retry_limit"] >= 3:
        score += 0.05

    # Deployment gate ensures only verified output ships
    if g["deployment_gate_score"] >= 0.4:
        score += 0.05

    return round(min(score, 1.0), 3)


def simulate_zero_waste(g, vdr_result):
    """NS3 requires zero-waste: every credit produces verifiable value.
    Score based on VDR + early exit + tripwire effectiveness."""
    score = 0.0

    # VDR directly measures waste (higher VDR = less waste)
    vdr_norm = vdr_result["vdr"] / 100.0
    score += vdr_norm * 0.40

    # Early exit prevents wasting credits on no-output runs
    if g["early_exit_threshold"] <= 15:
        score += 0.10

    # Tripwire sensitivity catches waste early
    if g["tripwire_sensitivity"] >= 2:
        score += 0.10

    # Per-bot budget limits waste per session
    if g["per_bot_budget"] <= 80:
        score += 0.05

    # Burn rate limit prevents runaway waste
    if g["burn_rate_per_min"] <= 15:
        score += 0.05

    # Proactive detection prevents future waste
    proactive = simulate_proactive(g)
    score += proactive * 0.15

    # Outcome-linked billing means no-waste = no-cost for user
    if g["billing_model"] == 3:  # outcome-linked
        score += 0.10
    elif g["billing_model"] == 4:  # hybrid
        score += 0.07

    # Credit refund policy
    if g["credit_refund_policy"] >= 2:
        score += 0.05

    return round(min(score, 1.0), 3)


def simulate_gap_detection(g, proactive_r):
    """NS3 requires detecting gaps before user awareness.
    Combines proactive detection + health scores + anomaly detection."""
    score = proactive_r * 0.60  # base from proactive system

    # Health scores enable real-time gap detection
    if g["health_score_enabled"]:
        score += 0.15

    # ML-based anomaly detection catches subtle gaps
    if g["usage_anomaly_detection"] == 3:  # ML
        score += 0.10
    elif g["usage_anomaly_detection"] >= 1:
        score += 0.05

    # Auto-intervention resolves gaps autonomously
    if g["auto_intervention"] >= 2:  # draft-outreach or auto-credit
        score += 0.15

    return round(min(score, 1.0), 3)


def evaluate_ns3_fitness(g, personas, n_interactions, island_name="startup"):
    """NS3-constrained fitness. Genomes violating NS3 principles die."""
    island = ISLANDS[island_name]
    w = island["weights"]
    epi = island["epigenetic_active"]

    # Evaluate all dimensions
    vdr_r = simulate_vdr(g, personas, n_interactions)
    ui_r = simulate_ui(g)
    a11y_r = simulate_a11y(g)
    rt_r = simulate_rt(g)
    safety_r = check_safety(g, ui_r, a11y_r, rt_r)

    # NS3 dimensions
    agent_sep = simulate_agent_separation(g)
    zero_waste = simulate_zero_waste(g, vdr_r)
    proactive_r = simulate_proactive(g) * epi.get("proactive", 0.5)
    gap_detection = simulate_gap_detection(g, proactive_r)
    collab_r = simulate_collab(g) * epi.get("collab", 0.5)
    ent_r = simulate_enterprise(g) * epi.get("enterprise", 0.5)
    team_r = simulate_team(g) * epi.get("team", 0.5)

    # === NS3 HARD CONSTRAINTS (genome dies if violated) ===
    ns3_violations = []

    # 1. Unverified value must never reach user → deployment gate must be >= 0.3
    if g["deployment_gate_score"] < 0.3:
        ns3_violations.append("NS3-1: unverified value can reach user (gate < 0.3)")

    # 2. Agents must be separated by function → agent_separation >= 0.4
    if agent_sep < 0.4:
        ns3_violations.append(f"NS3-2: agents not separated (score={agent_sep} < 0.4)")

    # 3. Must be evolving toward zero-waste → zero_waste >= 0.3
    if zero_waste < 0.3:
        ns3_violations.append(f"NS3-3: not zero-waste (score={zero_waste} < 0.3)")

    # 4. Must detect gaps → gap_detection >= 0.2
    if gap_detection < 0.2:
        ns3_violations.append(f"NS3-4: can't detect gaps (score={gap_detection} < 0.2)")

    # Safety constraints (from v3)
    if not safety_r["passed"]:
        ns3_violations.extend(safety_r["violations"])

    if ns3_violations:
        return {"fitness": 0, "rejected": True, "violations": ns3_violations,
                "vdr": vdr_r["vdr"]}

    # === NS3 FITNESS (weighted, with NS3 dimensions) ===
    fitness = (
        vdr_r["vdr"] * 0.25 +              # VDR (still important but not sole goal)
        agent_sep * 15 +                    # Agent separation (NS3 core)
        zero_waste * 15 +                   # Zero-waste (NS3 core)
        gap_detection * 15 +                # Gap detection (NS3 core)
        ui_r["usability"] * 10 +            # UI usability
        a11y_r * 5 +                         # Accessibility
        (1.0 - min(rt_r["rt_ms"] / g["max_response_time_ms"], 1.0)) * 5 +  # RT
        5 +                                  # Safety (passed)
        collab_r * 5 +                       # Collaboration
        ent_r * 5 +                          # Enterprise
        team_r * 5 +                         # Team
        proactive_r * 5                      # Proactive
    )

    return {
        "fitness": round(fitness, 2),
        "rejected": False,
        "vdr": vdr_r["vdr"],
        "agent_separation": agent_sep,
        "zero_waste": zero_waste,
        "gap_detection": gap_detection,
        "proactive": round(proactive_r, 3),
        "collab": round(collab_r, 3),
        "enterprise": round(ent_r, 3),
        "team": round(team_r, 3),
        "ui": ui_r["usability"],
        "a11y": a11y_r,
        "rt_ms": rt_r["rt_ms"],
        "island": island_name,
    }


def run_ns3_evolution(personas, island_name, pop_size=60, generations=40,
                      n_interactions=800, crossover_rate=0.85,
                      base_mutation=0.02, stagnation_limit=10):
    """Run NS3-constrained evolution."""
    print(f"\n{'='*60}")
    print(f"🦋 NS3 ISLAND: {island_name}")
    print(f"   {ISLANDS[island_name]['description']}")
    print(f"{'='*60}")
    print(f"NS3 DNA: agent_separation + zero_waste + gap_detection")
    print(f"NS3 constraints: gate≥0.3, separation≥0.4, waste≥0.3, gap≥0.2")

    base = baseline_genome()
    # Pre-seed with NS3-favorable mutations
    population = []
    for _ in range(pop_size):
        g = mutate_genome(base, random.randint(4, 10))
        # Pre-seed: ensure parallel pipeline, specialized agents, feedback loops
        g["pipeline_mode"] = random.choice([1, 2])  # parallel or hybrid
        g["agent_specialization"] = random.choice([1, 2])  # specialist or mixed
        g["feedback_loop_depth"] = random.randint(2, 4)
        g["governance_gate_count"] = random.randint(3, 7)
        g["deployment_gate_score"] = round(random.uniform(0.3, 0.7), 3)
        population.append(g)

    best_genome = None
    best_fitness = 0
    best_result = None
    history = []
    mutation_rate = base_mutation
    stagnant = 0
    total_rejected = 0

    for gen in range(generations):
        scored = []
        gen_rej = 0
        for g in population:
            r = evaluate_ns3_fitness(g, personas, n_interactions, island_name)
            if r.get("rejected"):
                gen_rej += 1
                total_rejected += 1
            scored.append((g, r))

        scored.sort(key=lambda x: x[1]["fitness"] if not x[1].get("rejected") else -1, reverse=True)
        valid = [(g, r) for g, r in scored if not r.get("rejected")]

        if not valid:
            if gen % 5 == 0:
                print(f"  Gen {gen+1}: ALL REJECTED — re-seeding with NS3 mutations")
            population = []
            for _ in range(pop_size):
                g = mutate_genome(base, random.randint(4, 10))
                g["pipeline_mode"] = random.choice([1, 2])
                g["agent_specialization"] = random.choice([1, 2])
                g["feedback_loop_depth"] = random.randint(2, 4)
                g["governance_gate_count"] = random.randint(3, 7)
                g["deployment_gate_score"] = round(random.uniform(0.3, 0.7), 3)
                population.append(g)
            continue

        gen_best = valid[0]
        if gen_best[1]["fitness"] > best_fitness:
            best_fitness = gen_best[1]["fitness"]
            best_genome = gen_best[0].copy()
            best_result = gen_best[1]
            stagnant = 0
            print(f"  Gen {gen+1}: 📈 fit={best_fitness:.1f} VDR={best_result['vdr']:.1f}% "
                  f"sep={best_result['agent_separation']} waste={best_result['zero_waste']} "
                  f"gap={best_result['gap_detection']} collab={best_result['collab']} "
                  f"ent={best_result['enterprise']} rej={gen_rej}/{pop_size}")
        else:
            stagnant += 1
            if stagnant >= stagnation_limit:
                mutation_rate = min(mutation_rate * 2, 0.10)
                print(f"  Gen {gen+1}: stagnant {stagnant} → mut={mutation_rate:.3f} best={best_fitness:.1f} rej={gen_rej}/{pop_size}")
                stagnant = 0
            elif gen % 5 == 0:
                print(f"  Gen {gen+1}: fit={gen_best[1]['fitness']:.1f} best={best_fitness:.1f} rej={gen_rej}/{pop_size}")

        fits = [r["fitness"] for _, r in valid]
        history.append({"gen": gen+1, "best": max(fits), "avg": round(sum(fits)/len(fits), 1),
                        "best_vdr": valid[0][1]["vdr"], "rejected": gen_rej,
                        "mutation": round(mutation_rate, 4)})

        # Selection: top 10% elite + crossover + diversity
        elite_n = max(int(pop_size * 0.10), 6)
        elites = [g.copy() for g, _ in valid[:elite_n]]
        offspring = []
        for _ in range(int(pop_size * 0.65)):
            if len(elites) >= 2 and random.random() < crossover_rate:
                child = crossover(*random.sample(elites, 2))
            else:
                child = mutate_genome(random.choice(elites), 3)
            if random.random() < mutation_rate:
                child = mutate_genome(child, random.randint(2, 5))
            offspring.append(child)
        randoms = [random_genome() for _ in range(pop_size - len(elites) - len(offspring))]
        population = (elites + offspring + randoms)[:pop_size]

    return {"island": island_name, "best_fitness": best_fitness,
            "best_genome": best_genome, "best_result": best_result,
            "history": history, "total_rejected": total_rejected}


def main():
    persona_file = Path("simulation/persona_pool.json")
    if not persona_file.exists():
        print("ERROR: Run dataset_ingestion.py first"); return
    with open(persona_file) as f:
        personas = json.load(f)["personas"]

    print("=" * 70)
    print("🦋 BUTTERFLY v4 — NORTH STAR #3 AS DNA CONSTRAINT")
    print("=" * 70)
    print(NS3_SYSTEM_INSTRUCTION)
    print(f"Genome: {len(GENE_NAMES)} genes | NS3 dimensions: agent_sep + zero_waste + gap_detection")
    print(f"NS3 hard constraints: gate≥0.3, separation≥0.4, waste≥0.3, gap≥0.2")
    print(f"Pop: 60/island | Gens: 40 | Crossover: 0.85 | Mutation: 0.02 adaptive→0.10")
    print(f"Total interactions: {4 * 60 * 40 * 800:,}")
    print()

    # Run all 4 islands with NS3 constraint
    all_results = {}
    for island in ISLANDS:
        r = run_ns3_evolution(personas, island, pop_size=60, generations=40,
                             n_interactions=800, crossover_rate=0.85,
                             base_mutation=0.02, stagnation_limit=10)
        all_results[island] = r

    # Cross-island migration
    print(f"\n{'='*60}")
    print("🔀 NS3 CROSS-ISLAND MIGRATION")
    print(f"{'='*60}")
    migration = {}
    for src, r in all_results.items():
        if r["best_genome"]:
            scores = {}
            for tgt in ISLANDS:
                res = evaluate_ns3_fitness(r["best_genome"], personas, 800, tgt)
                scores[tgt] = res["fitness"] if not res.get("rejected") else 0
            migration[src] = {"genome": r["best_genome"], "scores": scores}
            print(f"  {src:12s} → " + " | ".join(f"{k}={v:.1f}" for k, v in scores.items()))

    # Overall best
    overall = max(all_results.values(), key=lambda x: x["best_fitness"])
    best_island = next(k for k, v in all_results.items() if v is overall)

    base = baseline_genome()
    base_fit = evaluate_ns3_fitness(base, personas, 800, best_island)

    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "run_type": "butterfly_v4_ns3_dna_constraint",
        "ns3_system_instruction": NS3_SYSTEM_INSTRUCTION.strip(),
        "genome_size": len(GENE_NAMES),
        "ns3_dimensions": ["agent_separation", "zero_waste", "gap_detection"],
        "ns3_constraints": {"gate_min": 0.3, "separation_min": 0.4, "waste_min": 0.3, "gap_min": 0.2},
        "parameters": {"pop": 60, "gens": 40, "crossover": 0.85, "mutation_base": 0.02, "mutation_max": 0.10},
        "total_interactions": 4 * 60 * 40 * 800,
        "islands": {n: {
            "fitness": r["best_fitness"],
            "vdr": r["best_result"]["vdr"] if r["best_result"] else 0,
            "agent_separation": r["best_result"]["agent_separation"] if r["best_result"] else 0,
            "zero_waste": r["best_result"]["zero_waste"] if r["best_result"] else 0,
            "gap_detection": r["best_result"]["gap_detection"] if r["best_result"] else 0,
            "collab": r["best_result"]["collab"] if r["best_result"] else 0,
            "enterprise": r["best_result"]["enterprise"] if r["best_result"] else 0,
            "team": r["best_result"]["team"] if r["best_result"] else 0,
            "proactive": r["best_result"]["proactive"] if r["best_result"] else 0,
            "rejected": r["total_rejected"],
            "history": r["history"],
        } for n, r in all_results.items()},
        "migration": {k: v["scores"] for k, v in migration.items()},
        "overall_best_island": best_island,
        "overall_best": {
            "fitness": overall["best_fitness"],
            "vdr": overall["best_result"]["vdr"] if overall["best_result"] else 0,
            "agent_separation": overall["best_result"]["agent_separation"] if overall["best_result"] else 0,
            "zero_waste": overall["best_result"]["zero_waste"] if overall["best_result"] else 0,
            "gap_detection": overall["best_result"]["gap_detection"] if overall["best_result"] else 0,
            "genome": overall["best_genome"],
        },
        "baseline": {"fitness": base_fit.get("fitness", 0), "vdr": base_fit.get("vdr", 0)},
        "improvement": round(overall["best_fitness"] - base_fit.get("fitness", 0), 2),
        "genome_changes": {
            g: {"baseline": base[g], "evolved": overall["best_genome"][g] if overall["best_genome"] else base[g],
                "category": get_spec(g)["cat"]}
            for g in GENE_NAMES if overall["best_genome"] and base[g] != overall["best_genome"][g]
        },
        "north_star_3": NS3_SYSTEM_INSTRUCTION.strip(),
        "safety_note": "100% in-simulation. Zero production calls. Awaiting human review.",
    }

    with open("simulation/butterfly_v4_report.json", "w") as f:
        json.dump(report, f, indent=2)

    print(f"\n{'='*70}")
    print(f"🦋 BUTTERFLY v4 — NS3 EVOLUTION COMPLETE")
    print(f"{'='*70}")
    print(f"Total interactions: {report['total_interactions']:,}")
    print()
    for n, r in all_results.items():
        br = r["best_result"]
        if br:
            print(f"  {n:12s}: fit={r['best_fitness']:.1f} VDR={br['vdr']:.1f}% "
                  f"sep={br['agent_separation']} waste={br['zero_waste']} gap={br['gap_detection']}")
        else:
            print(f"  {n:12s}: NO VALID GENOME")
    print(f"\n  Best island: {best_island} | fitness: {overall['best_fitness']:.1f}")
    print(f"  Baseline: {base_fit.get('fitness', 0):.1f} → Evolved: {overall['best_fitness']:.1f} (+{report['improvement']:.1f})")
    if overall["best_genome"]:
        changes = sum(1 for g in GENE_NAMES if base[g] != overall["best_genome"][g])
        print(f"  Genes changed: {changes}")
    print(f"\n{report['safety_note']}")


if __name__ == "__main__":
    main()
