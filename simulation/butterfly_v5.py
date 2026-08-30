"""
Butterfly v5 — Kill-Off Bottleneck Evolution with Prompt-as-Gene.

NATURAL SELECTION MECHANISM:
  1. Start with diverse population (100 genomes, each with a unique system prompt variant)
  2. Evaluate fitness against island environment
  3. KILL 90-95% — keep only top 5-10 survivors (bottleneck event)
  4. Survivors repopulate via crossover + heavy mutation
  5. Loop until EMERGENT RADICAL CHANGE detected (VDR jump >5% or new pattern)
  6. The system instruction PROMPT itself evolves — it's not fixed, it's a gene

PROMPT-AS-GENE:
  The system prompt has evolvable components:
  - Preamble (the "north star" statement)
  - Agent definitions (which agents exist, their roles)
  - Constraint language (how strict, how phrased)
  - Goal language (what the system optimizes for)
  - Instruction style (imperative, descriptive, Socratic)
  - Temperature/exploration guidance

  Each island may evolve a DIFFERENT optimal prompt.
  The kill-off bottleneck forces radical adaptation.
"""
import json, random, time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from butterfly_v3 import (
    GENOME_TEMPLATE, GENE_NAMES, get_spec, random_gene, mutate_val,
    baseline_genome, random_genome, mutate_genome, crossover,
    ISLANDS, RISK_PROFILES, DEFAULT_P, MODEL_QUALITY,
    simulate_vdr, simulate_ui, simulate_a11y, simulate_rt,
    simulate_proactive, simulate_collab, simulate_enterprise, simulate_team,
    check_safety,
)

# === EVOLVABLE PROMPT COMPONENTS ===

PREAMBLES = [
    "Every interaction must produce measurably verified value for the user.",
    "Your sole purpose is to maximize user value while eliminating waste.",
    "You are part of a governed lattice. Every action must be verified before it reaches the user.",
    "Think like an auditor: verify first, deliver second, waste nothing.",
    "You exist to deliver value. If you can't, detect the gap and fix it autonomously.",
    "Zero waste. Zero unverified output. Zero undetected failures. That is your contract.",
    "Before any action, ask: does this produce verifiable value? If not, stop.",
    "You are a fitness-governed agent. Your survival depends on value delivery rate.",
    "The user's problem is your problem. Detect it before they tell you. Fix it before they notice.",
    "Every credit spent is an investment. If it doesn't return value, the system fails.",
    "Govern your own behavior: if your output wouldn't pass an audit, don't produce it.",
    "Value is not what you generate. Value is what the user can deploy and approve.",
    "You are not a code generator. You are a value delivery system that happens to write code.",
    "The lattice watches you. The tripwires guard the user. Deliver or be halted.",
    "Your fitness score is your heartbeat. If it drops, the system intervenes before the user suffers.",
]

AGENT_DEFINITIONS = [
    "Research→Audit→Design→Code→Verify: five agents, each gated by fitness.",
    "Discover→Validate→Architect→Generate→Govern: the lattice of verified dependencies.",
    "Scout→Judge→Plan→Build→Guard: every output must earn its place.",
    "Find→Rank→Shape→Code→Check: no unverified value crosses the gate.",
    "Search→Score→Design→Compile→Audit: the deterministic path from idea to deployment.",
]

CONSTRAINT_LANGUAGES = [
    "Hard constraint: unverified value never reaches the user. Violation = agent halt.",
    "Rule: if your output hasn't passed a fitness gate, it doesn't ship. No exceptions.",
    "Invariant: VDR >= 91.3%. If VDR drops, tripwires fire and agents are halted.",
    "Constraint: every artifact must be verified before propagation. Unverified = killed.",
    "Law: the system must detect user problems before the user reports them.",
    "Governance: zero-waste principle. Every credit must produce verifiable value.",
]

GOAL_LANGUAGES = [
    "Maximize VDR while maintaining zero-waste value delivery.",
    "Deliver verified value to every user, every interaction, with zero waste.",
    "Achieve 91.3% VDR through deterministic agent separation and fitness governance.",
    "Minimize the gap between promised and delivered value.",
    "Evolve toward zero-waste: every credit spent must return measurable value.",
]

INSTRUCTION_STYLES = [
    "imperative",  # "Do X. Verify Y. Ship Z."
    "descriptive",  # "The system does X. Then Y is verified. Z ships."
    "Socratic",  # "Ask: does this produce value? If yes, proceed. If no, stop."
    "conditional",  # "If X is true, do Y. Otherwise, halt and report."
    "contractual",  # "You agree to: produce verified value, detect gaps, halt on failure."
]

TEMPERATURE_GUIDANCE = [
    "Be deterministic. Low temperature. No creative deviation from the lattice.",
    "Be precise. Every output must be reproducible and auditable.",
    "Be consistent. The same input must produce the same verified output.",
    "Be conservative. When in doubt, verify more, not less.",
    "Be rigorous. High certainty, low variance, zero unverified output.",
]


def create_random_prompt():
    """Create a random system prompt from evolvable components."""
    return {
        "preamble": random.choice(PREAMBLES),
        "agent_definition": random.choice(AGENT_DEFINITIONS),
        "constraint_language": random.choice(CONSTRAINT_LANGUAGES),
        "goal_language": random.choice(GOAL_LANGUAGES),
        "instruction_style": random.choice(INSTRUCTION_STYLES),
        "temperature_guidance": random.choice(TEMPERATURE_GUIDANCE),
    }


def assemble_prompt(prompt_genes):
    """Assemble the prompt genes into a single system instruction string."""
    style_prefix = {
        "imperative": "DO THIS. ",
        "descriptive": "THE SYSTEM WORKS AS FOLLOWS. ",
        "Socratic": "ASK YOURSELF: ",
        "conditional": "RULES: ",
        "contractual": "YOU AGREE TO THE FOLLOWING: ",
    }.get(prompt_genes["instruction_style"], "")
    
    return f"""{style_prefix}{prompt_genes['preamble']}

AGENT LATTICE: {prompt_genes['agent_definition']}

CONSTRAINT: {prompt_genes['constraint_language']}

GOAL: {prompt_genes['goal_language']}

TEMPERAMENT: {prompt_genes['temperature_guidance']}"""


def mutate_prompt(prompt):
    """Mutate 1-3 prompt components."""
    child = prompt.copy()
    components = ["preamble", "agent_definition", "constraint_language", 
                  "goal_language", "instruction_style", "temperature_guidance"]
    n_mutations = random.randint(1, 3)
    for comp in random.sample(components, min(n_mutations, len(components))):
        if comp == "preamble": child[comp] = random.choice(PREAMBLES)
        elif comp == "agent_definition": child[comp] = random.choice(AGENT_DEFINITIONS)
        elif comp == "constraint_language": child[comp] = random.choice(CONSTRAINT_LANGUAGES)
        elif comp == "goal_language": child[comp] = random.choice(GOAL_LANGUAGES)
        elif comp == "instruction_style": child[comp] = random.choice(INSTRUCTION_STYLES)
        elif comp == "temperature_guidance": child[comp] = random.choice(TEMPERATURE_GUIDANCE)
    return child


def crossover_prompts(p1, p2):
    """Crossover two prompts — each component taken from either parent."""
    child = {}
    for comp in ["preamble", "agent_definition", "constraint_language", 
                 "goal_language", "instruction_style", "temperature_guidance"]:
        child[comp] = p1[comp] if random.random() < 0.5 else p2[comp]
    return child


def prompt_hash(prompt):
    """Simple hash for tracking prompt diversity."""
    return hash(json.dumps(prompt, sort_keys=True))


# === PROMPT-AFFECTED FITNESS ===
# The prompt genes directly affect the simulation — different prompts
# produce different agent behaviors, which changes VDR.

STYLE_MULTIPLIERS = {
    "imperative": {"speed": 1.1, "accuracy": 1.0, "waste_reduction": 1.05},
    "descriptive": {"speed": 0.95, "accuracy": 1.05, "waste_reduction": 1.0},
    "Socratic": {"speed": 0.85, "accuracy": 1.15, "waste_reduction": 1.1},
    "conditional": {"speed": 1.0, "accuracy": 1.08, "waste_reduction": 1.05},
    "contractual": {"speed": 0.9, "accuracy": 1.12, "waste_reduction": 1.08},
}

PREAMBLE_EFFECTS = {
    # Some preambles are better for certain environments
    "Every interaction must produce measurably verified value for the user.": {"vdr_boost": 1.05, "waste_boost": 1.08},
    "Your sole purpose is to maximize user value while eliminating waste.": {"vdr_boost": 1.03, "waste_boost": 1.05},
    "You are part of a governed lattice. Every action must be verified before it reaches the user.": {"vdr_boost": 1.02, "waste_boost": 1.10},
    "Think like an auditor: verify first, deliver second, waste nothing.": {"vdr_boost": 1.04, "waste_boost": 1.12},
    "You exist to deliver value. If you can't, detect the gap and fix it autonomously.": {"vdr_boost": 1.06, "waste_boost": 1.03},
    "Zero waste. Zero unverified output. Zero undetected failures. That is your contract.": {"vdr_boost": 1.01, "waste_boost": 1.15},
    "Before any action, ask: does this produce verifiable value? If not, stop.": {"vdr_boost": 1.03, "waste_boost": 1.10},
    "You are a fitness-governed agent. Your survival depends on value delivery rate.": {"vdr_boost": 1.07, "waste_boost": 1.04},
    "The user's problem is your problem. Detect it before they tell you. Fix it before they notice.": {"vdr_boost": 1.05, "waste_boost": 1.02},
    "Every credit spent is an investment. If it doesn't return value, the system fails.": {"vdr_boost": 1.04, "waste_boost": 1.07},
    "Govern your own behavior: if your output wouldn't pass an audit, don't produce it.": {"vdr_boost": 1.02, "waste_boost": 1.13},
    "Value is not what you generate. Value is what the user can deploy and approve.": {"vdr_boost": 1.08, "waste_boost": 1.03},
    "You are not a code generator. You are a value delivery system that happens to write code.": {"vdr_boost": 1.06, "waste_boost": 1.05},
    "The lattice watches you. The tripwires guard the user. Deliver or be halted.": {"vdr_boost": 1.03, "waste_boost": 1.08},
    "Your fitness score is your heartbeat. If it drops, the system intervenes before the user suffers.": {"vdr_boost": 1.05, "waste_boost": 1.06},
}

CONSTRAINT_EFFECTS = {
    "Hard constraint: unverified value never reaches the user. Violation = agent halt.": {"gate_strictness": 1.15, "waste_reduction": 1.10},
    "Rule: if your output hasn't passed a fitness gate, it doesn't ship. No exceptions.": {"gate_strictness": 1.10, "waste_reduction": 1.08},
    "Invariant: VDR >= 91.3%. If VDR drops, tripwires fire and agents are halted.": {"gate_strictness": 1.20, "waste_reduction": 1.15},
    "Constraint: every artifact must be verified before propagation. Unverified = killed.": {"gate_strictness": 1.12, "waste_reduction": 1.12},
    "Law: the system must detect user problems before the user reports them.": {"gate_strictness": 1.05, "waste_reduction": 1.03, "proactive_boost": 1.15},
    "Governance: zero-waste principle. Every credit must produce verifiable value.": {"gate_strictness": 1.08, "waste_reduction": 1.20},
}


def simulate_with_prompt(genome, prompt, personas, n_interactions, island_name):
    """Run VDR simulation with prompt-affected parameters."""
    # Get base VDR result
    vdr_r = simulate_vdr(genome, personas, n_interactions)
    
    # Apply prompt effects
    style = prompt["instruction_style"]
    style_mult = STYLE_MULTIPLIERS.get(style, {"speed": 1.0, "accuracy": 1.0, "waste_reduction": 1.0})
    
    preamble_eff = PREAMBLETTE_EFFECTS.get(prompt["preamble"], {"vdr_boost": 1.0, "waste_boost": 1.0})
    constraint_eff = CONSTRAINT_EFFECTS.get(prompt["constraint_language"], {"gate_strictness": 1.0, "waste_reduction": 1.0})
    
    # Recalculate VDR with prompt effects
    vdr_boosted = vdr_r["vdr"] * preamble_eff.get("vdr_boost", 1.0) * style_mult.get("accuracy", 1.0)
    
    # Constraint language affects deployment gate
    gate_adjustment = constraint_eff.get("gate_strictness", 1.0)
    adjusted_gate = min(genome["deployment_gate_score"] * gate_adjustment, 0.9)
    
    # Waste reduction from prompt
    waste_reduction = preamble_eff.get("waste_boost", 1.0) * constraint_eff.get("waste_reduction", 1.0) * style_mult.get("waste_reduction", 1.0)
    
    # Re-simulate with adjusted parameters
    adjusted_genome = genome.copy()
    adjusted_genome["deployment_gate_score"] = adjusted_gate
    
    # Proactive boost from constraint language
    proactive_boost = constraint_eff.get("proactive_boost", 1.0)
    
    vdr_r2 = simulate_vdr(adjusted_genome, personas, n_interactions)
    vdr_r2["vdr"] = round(vdr_r2["vdr"] * waste_reduction, 2)
    vdr_r2["vdr"] = min(vdr_r2["vdr"], 99.9)
    
    return vdr_r2, waste_reduction, proactive_boost


# Fix the typo
PREAMBLETTE_EFFECTS = PREAMBLE_EFFECTS


def evaluate_full_fitness(genome, prompt, personas, n_interactions, island_name):
    """Full NS3 fitness with prompt effects."""
    island = ISLANDS[island_name]
    w = island["weights"]
    epi = island["epigenetic_active"]
    
    vdr_r, waste_mult, proactive_boost = simulate_with_prompt(genome, prompt, personas, n_interactions, island_name)
    ui_r = simulate_ui(genome)
    a11y_r = simulate_a11y(genome)
    rt_r = simulate_rt(genome)
    safety_r = check_safety(genome, ui_r, a11y_r, rt_r)
    
    proactive_r = simulate_proactive(genome) * epi.get("proactive", 0.5) * proactive_boost
    collab_r = simulate_collab(genome) * epi.get("collab", 0.5)
    ent_r = simulate_enterprise(genome) * epi.get("enterprise", 0.5)
    team_r = simulate_team(genome) * epi.get("team", 0.5)
    
    # Agent separation (from v4)
    agent_sep = 0.0
    if genome["pipeline_mode"] >= 1: agent_sep += 0.20
    if genome["agent_specialization"] >= 1: agent_sep += 0.20
    if genome["agent_count"] >= 4: agent_sep += 0.15
    if genome["feedback_loop_depth"] >= 2: agent_sep += 0.15
    if genome["governance_gate_count"] >= 3: agent_sep += 0.10
    if genome["discovery_impl_overlap"] >= 0.5: agent_sep += 0.10
    if genome["deployment_gate_score"] >= 0.4: agent_sep += 0.05
    if genome["retry_limit"] >= 3: agent_sep += 0.05
    agent_sep = round(min(agent_sep, 1.0), 3)
    
    zero_waste = round(min(vdr_r["vdr"] / 100 * waste_mult, 1.0), 3)
    gap_detection = round(min(proactive_r * 0.6 + (0.15 if genome["health_score_enabled"] else 0) + (0.10 if genome["usage_anomaly_detection"] == 3 else 0.05) + (0.15 if genome["auto_intervention"] >= 2 else 0), 1.0), 3)
    
    # Safety gate
    if not safety_r["passed"]:
        return {"fitness": 0, "rejected": True, "vdr": vdr_r["vdr"]}
    
    # NS3 hard constraints
    if genome["deployment_gate_score"] < 0.3: return {"fitness": 0, "rejected": True}
    if agent_sep < 0.4: return {"fitness": 0, "rejected": True}
    if zero_waste < 0.3: return {"fitness": 0, "rejected": True}
    if gap_detection < 0.2: return {"fitness": 0, "rejected": True}
    
    fitness = (
        vdr_r["vdr"] * 0.25 + agent_sep * 15 + zero_waste * 15 + gap_detection * 15 +
        ui_r["usability"] * 10 + a11y_r * 5 +
        (1.0 - min(rt_r["rt_ms"] / genome["max_response_time_ms"], 1.0)) * 5 +
        5 + collab_r * 5 + ent_r * 5 + team_r * 5 + proactive_r * 5
    )
    
    return {
        "fitness": round(fitness, 2), "rejected": False,
        "vdr": vdr_r["vdr"], "agent_sep": agent_sep,
        "zero_waste": zero_waste, "gap_detection": gap_detection,
        "proactive": round(proactive_r, 3), "collab": round(collab_r, 3),
        "enterprise": round(ent_r, 3), "team": round(team_r, 3),
        "prompt": prompt,
        "island": island_name,
    }


def run_kill_off_evolution(personas, island_name, pop_size=100, generations=50,
                            n_interactions=600, kill_rate=0.92,
                            stagnation_limit=5, emergence_threshold=5.0):
    """
    Run kill-off bottleneck evolution.
    
    kill_rate: fraction of population killed each generation (0.92 = 92% die)
    stagnation_limit: generations without improvement before increasing mutation
    emergence_threshold: VDR jump that counts as "emergent radical change"
    """
    print(f"\n{'='*70}")
    print(f"💀 BUTTERFLY v5 — KILL-OFF EVOLUTION: {island_name}")
    print(f"   {ISLANDS[island_name]['description']}")
    print(f"{'='*70}")
    print(f"Population: {pop_size} | Kill rate: {kill_rate*100:.0f}% | Generations: {generations}")
    print(f"Survivors per gen: {int(pop_size * (1 - kill_rate))} | Emergence threshold: +{emergance_threshold}% VDR")
    
    # Initialize diverse population — each genome has a unique random prompt
    population = []
    for i in range(pop_size):
        g = mutate_genome(baseline_genome(), random.randint(4, 10))
        g["pipeline_mode"] = random.choice([1, 2])
        g["agent_specialization"] = random.choice([1, 2])
        g["feedback_loop_depth"] = random.randint(2, 4)
        g["governance_gate_count"] = random.randint(3, 7)
        g["deployment_gate_score"] = round(random.uniform(0.3, 0.7), 3)
        p = create_random_prompt()
        population.append({"genome": g, "prompt": p})
    
    best_fitness = 0
    best_individual = None
    best_result = None
    history = []
    emergent_changes = []
    prev_best_vdr = 0
    mutation_multiplier = 1.0
    stagnant = 0
    bottleneck_events = 0
    
    for gen in range(generations):
        gen_start = time.time()
        
        # Evaluate all
        scored = []
        for ind in population:
            r = evaluate_full_fitness(ind["genome"], ind["prompt"], personas, n_interactions, island_name)
            scored.append((ind, r))
        
        scored.sort(key=lambda x: x[1]["fitness"] if not x[1].get("rejected") else -1, reverse=True)
        valid = [(ind, r) for ind, r in scored if not r.get("rejected")]
        
        if not valid:
            print(f"  Gen {gen+1}: EXTINCTION — all {pop_size} killed by constraints. Re-seeding...")
            bottleneck_events += 1
            population = []
            for _ in range(pop_size):
                g = mutate_genome(baseline_genome(), random.randint(6, 12))
                g["pipeline_mode"] = random.choice([1, 2])
                g["agent_specialization"] = random.choice([1, 2])
                g["feedback_loop_depth"] = random.randint(2, 5)
                g["governance_gate_count"] = random.randint(3, 8)
                g["deployment_gate_score"] = round(random.uniform(0.3, 0.7), 3)
                p = create_random_prompt()
                population.append({"genome": g, "prompt": p})
            continue
        
        # Check for emergent radical change
        current_best_vdr = valid[0][1]["vdr"]
        if prev_best_vdr > 0 and (current_best_vdr - prev_best_vdr) >= emergence_threshold:
            emergent_changes.append({
                "generation": gen + 1,
                "vdr_jump": round(current_best_vdr - prev_best_vdr, 2),
                "from_vdr": round(prev_best_vdr, 2),
                "to_vdr": round(current_best_vdr, 2),
                "prompt": valid[0][1]["prompt"],
                "description": f"EMERGENT: VDR jumped {current_best_vdr - prev_best_vdr:.1f}%"
            })
            print(f"  Gen {gen+1}: 🌟 EMERGENT RADICAL CHANGE! VDR jumped {current_best_vdr - prev_best_vdr:.1f}% → {current_best_vdr:.1f}%")
        
        prev_best_vdr = current_best_vdr
        
        # Track best
        if valid[0][1]["fitness"] > best_fitness:
            best_fitness = valid[0][1]["fitness"]
            best_individual = valid[0][0]
            best_result = valid[0][1]
            stagnant = 0
            print(f"  Gen {gen+1}: 📈 fit={best_fitness:.1f} VDR={current_best_vdr:.1f}% "
                  f"waste={valid[0][1]['zero_waste']} gap={valid[0][1]['gap_detection']} "
                  f"| prompt: {valid[0][1]['prompt']['instruction_style']}/{valid[0][1]['prompt']['preamble'][:40]}...")
        else:
            stagnant += 1
        
        # === KILL-OFF BOTTLENECK ===
        n_survivors = max(int(pop_size * (1 - kill_rate)), 3)
        survivors = [(ind, r) for ind, r in valid[:n_survivors]]
        killed = pop_size - len(survivors)
        bottleneck_events += 1
        
        if gen % 5 == 0 or stagnant >= stagnation_limit:
            print(f"  Gen {gen+1}: 💀 KILLED {killed}/{pop_size} | {len(survivors)} survivors | "
                  f"best={best_fitness:.1f} VDR={current_best_vdr:.1f}%")
        
        # Stagnation → increase mutation
        if stagnant >= stagnation_limit:
            mutation_multiplier = min(mutation_multiplier * 1.5, 3.0)
            print(f"  Gen {gen+1}: 🧬 STAGNANT — mutation ×{mutation_multiplier:.1f}")
            stagnant = 0
        
        # === REPOPULATE FROM SURVIVORS ===
        new_pop = []
        
        # Keep survivors as-is (elitism)
        for ind, _ in survivors:
            new_pop.append(ind.copy() if isinstance(ind, dict) else ind)
        
        # Crossover survivors → offspring
        survivor_genomes = [ind["genome"] for ind in [s[0] for s in survivors]]
        survivor_prompts = [ind["prompt"] for ind in [s[0] for s in survivors]]
        
        n_offspring = int(pop_size * 0.60)
        for _ in range(n_offspring):
            if len(survivor_genomes) >= 2:
                p1_g, p2_g = random.sample(survivor_genomes, 2)
                p1_p, p2_p = random.sample(survivor_prompts, 2)
                child_g = crossover(p1_g, p2_g)
                child_p = crossover_prompts(p1_p, p2_p)
            else:
                child_g = mutate_genome(survivor_genomes[0], 5)
                child_p = mutate_prompt(survivor_prompts[0])
            
            # Heavy mutation (kill-off demands rapid adaptation)
            n_mut = int(random.randint(3, 8) * mutation_multiplier)
            child_g = mutate_genome(child_g, n_mut)
            child_p = mutate_prompt(child_p)
            if random.random() < 0.3 * mutation_multiplier:
                child_p = mutate_prompt(mutate_prompt(child_p))  # double mutation
            
            new_pop.append({"genome": child_g, "prompt": child_p})
        
        # Diversity: fresh random individuals (prevents inbreeding depression)
        n_random = pop_size - len(new_pop)
        for _ in range(n_random):
            g = random_genome()
            g["pipeline_mode"] = random.choice([1, 2])
            g["agent_specialization"] = random.choice([1, 2])
            g["feedback_loop_depth"] = random.randint(2, 5)
            g["governance_gate_count"] = random.randint(3, 8)
            g["deployment_gate_score"] = round(random.uniform(0.3, 0.7), 3)
            p = create_random_prompt()
            new_pop.append({"genome": g, "prompt": p})
        
        population = new_pop[:pop_size]
        
        # Track prompt diversity
        unique_prompts = len(set(prompt_hash(ind["prompt"]) for ind in population))
        
        history.append({
            "gen": gen + 1, "best_fitness": best_fitness,
            "best_vdr": current_best_vdr, "survivors": len(survivors),
            "killed": killed, "unique_prompts": unique_prompts,
            "mutation_mult": round(mutation_multiplier, 2),
        })
        
        if gen % 5 == 0:
            print(f"  Prompt diversity: {unique_prompts}/{pop_size} unique | Time: {time.time()-gen_start:.1f}s")
    
    # Find best prompt for this island
    best_prompt = best_individual["prompt"] if best_individual else create_random_prompt()
    best_prompt_text = assemble_prompt(best_prompt)
    
    return {
        "island": island_name,
        "best_fitness": best_fitness,
        "best_vdr": best_result["vdr"] if best_result else 0,
        "best_prompt": best_prompt,
        "best_prompt_text": best_prompt_text,
        "best_genome": best_individual["genome"] if best_individual else baseline_genome(),
        "best_result": best_result,
        "emergent_changes": emergent_changes,
        "bottleneck_events": bottleneck_events,
        "history": history,
    }


# Fix variable name typo
emergance_threshold = 5.0

def main():
    persona_file = Path("simulation/persona_pool.json")
    if not persona_file.exists():
        print("ERROR: Run dataset_ingestion.py first"); return
    with open(persona_file) as f:
        personas = json.load(f)["personas"]
    
    global emergance_threshold
    emergance_threshold = 5.0
    
    print("=" * 70)
    print("💀 BUTTERFLY v5 — KILL-OFF BOTTLENECK EVOLUTION")
    print("    PROMPT-AS-GENE NATURAL SELECTION")
    print("=" * 70)
    print(f"Kill rate: 92% per generation | Survivors: 8/100")
    print(f"Emergence: radical change = VDR jump >= 5%")
    print(f"Prompt genes: 6 evolvable components per individual")
    print(f"Total interactions: {4 * 100 * 50 * 600:,}")
    print()
    
    all_results = {}
    for island in ISLANDS:
        r = run_kill_off_evolution(
            personas, island,
            pop_size=100, generations=50,
            n_interactions=600, kill_rate=0.92,
            stagnation_limit=5, emergence_threshold=5.0,
        )
        all_results[island] = r
    
    # === ANALYZE: Find best prompt per island ===
    print(f"\n{'='*70}")
    print("🧬 EVOLVED PROMPTS PER ISLAND")
    print(f"{'='*70}")
    
    for island, r in all_results.items():
        print(f"\n--- {island} ---")
        print(f"Fitness: {r['best_fitness']:.1f} | VDR: {r['best_vdr']:.1f}%")
        print(f"Emergent changes: {len(r['emergent_changes'])}")
        print(f"Bottleneck events: {r['bottleneck_events']}")
        print(f"\nEvolved System Prompt:")
        print(r['best_prompt_text'])
        print()
    
    # === CROSS-ISLAND PROMPT COMPARISON ===
    print(f"\n{'='*70}")
    print("🔀 CROSS-ISLAND PROMPT MIGRATION")
    print(f"{'='*70}")
    
    migration = {}
    for src_island, r in all_results.items():
        src_prompt = r['best_prompt']
        src_genome = r['best_genome']
        scores = {}
        for tgt_island in ISLANDS:
            res = evaluate_full_fitness(src_genome, src_prompt, personas, 600, tgt_island)
            scores[tgt_island] = res["fitness"] if not res.get("rejected") else 0
        migration[src_island] = scores
        print(f"  {src_island:12s} → " + " | ".join(f"{k}={v:.1f}" for k, v in scores.items()))
    
    # === FIND UNIVERSAL BEST PROMPT ===
    # The prompt that performs best ACROSS ALL islands
    best_universal = None
    best_universal_avg = 0
    for src_island, scores in migration.items():
        avg = sum(scores.values()) / len(scores)
        if avg > best_universal_avg:
            best_universal_avg = avg
            best_universal = src_island
    
    print(f"\n  UNIVERSAL BEST: {best_universal} (avg fitness: {best_universal_avg:.1f})")
    
    # === COLLECT ALL EMERGENT CHANGES ===
    all_emergent = []
    for island, r in all_results.items():
        for change in r['emergent_changes']:
            change['island'] = island
            all_emergent.append(change)
    
    # Final report
    base = baseline_genome()
    base_prompt = create_random_prompt()
    
    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "run_type": "butterfly_v5_kill_off_prompt_evolution",
        "description": "Kill-off bottleneck evolution with prompt-as-gene. 92% kill rate per generation. Prompt components evolve through natural selection.",
        "parameters": {
            "population": 100, "generations": 50, "kill_rate": 0.92,
            "survivors_per_gen": 8, "emergence_threshold": 5.0,
            "stagnation_limit": 5, "interactions_per_genome": 600,
        },
        "total_interactions": 4 * 100 * 50 * 600,
        "prompt_components": {
            "preambles": len(PREAMBLES),
            "agent_definitions": len(AGENT_DEFINITIONS),
            "constraint_languages": len(CONSTRAINT_LANGUAGES),
            "goal_languages": len(GOAL_LANGUAGES),
            "instruction_styles": len(INSTRUCTION_STYLES),
            "temperature_guidances": len(TEMPERATURE_GUIDANCE),
            "total_possible_prompts": len(PREAMBLES) * len(AGENT_DEFINITIONS) * len(CONSTRAINT_LANGUAGES) * len(GOAL_LANGUAGES) * len(INSTRUCTION_STYLES) * len(TEMPERATURE_GUIDANCE),
        },
        "islands": {
            island: {
                "best_fitness": r["best_fitness"],
                "best_vdr": r["best_vdr"],
                "best_prompt": r["best_prompt"],
                "best_prompt_text": r["best_prompt_text"],
                "emergent_changes": r["emergent_changes"],
                "bottleneck_events": r["bottleneck_events"],
                "history": r["history"],
            }
            for island, r in all_results.items()
        },
        "migration": migration,
        "universal_best_prompt": {
            "island": best_universal,
            "avg_fitness": best_universal_avg,
            "prompt": all_results[best_universal]["best_prompt"],
            "prompt_text": all_results[best_universal]["best_prompt_text"],
        },
        "all_emergent_changes": all_emergent,
        "emergent_count": len(all_emergent),
    }
    
    with open("simulation/butterfly_v5_report.json", "w") as f:
        json.dump(report, f, indent=2)
    
    print(f"\n{'='*70}")
    print(f"💀 BUTTERFLY v5 — KILL-OFF EVOLUTION COMPLETE")
    print(f"{'='*70}")
    print(f"Total interactions: {report['total_interactions']:,}")
    print(f"Total bottleneck events: {sum(r['bottleneck_events'] for r in all_results.values())}")
    print(f"Total emergent changes: {len(all_emergent)}")
    print(f"Total possible prompt combinations: {report['prompt_components']['total_possible_prompts']:,}")
    print()
    for island, r in all_results.items():
        print(f"  {island:12s}: fit={r['best_fitness']:.1f} VDR={r['best_vdr']:.1f}% "
              f"emergent={len(r['emergent_changes'])} bottlenecks={r['bottleneck_events']}")
    print(f"\n  Universal best prompt island: {best_universal} (avg fitness: {best_universal_avg:.1f})")
    print(f"\n{'='*70}")
    print("UNIVERSAL BEST EVOLVED SYSTEM PROMPT:")
    print(f"{'='*70}")
    print(report["universal_best_prompt"]["prompt_text"])
    print(f"\n{'='*70}")
    print(f"Report saved to simulation/butterfly_v5_report.json")


if __name__ == "__main__":
    main()
