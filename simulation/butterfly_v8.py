#!/usr/bin/env python3
"""
Butterfly v8 — Preview/Deploy/Visual Quality Evolution.

Adds 12 new genes (97 total) across 4 new supergene categories:
  - Preview System (3): preview_tier, preview_hot_reload, preview_error_overlay
  - Deployment System (3): deployment_target, deployment_auto, deployment_url_format
  - Visual System (3): token_coverage, brand_conformance, visual_regression_baseline
  - Generated App Quality (3): generated_app_complexity, generated_app_db, generated_app_auth

Updated fitness function (10 dimensions):
  VDR:                    30% (down from 40%) — still primary
  Preview Quality:       10% — NEW — rewards preview_tier >= 2
  Deployment Success:    10% — NEW — rewards deployment_target >= 1
  Visual Quality:        10% — NEW — rewards token_coverage and brand_conformance
  Generated App Quality:  5% — NEW — rewards generated_app_complexity >= 2
  UI/UX:                 10% (down from 25%)
  A11y:                  10% (same)
  Safety:                10% (same)
  Real-time:               3% — NEW — preview responsiveness
  Research Quality:        2% — NEW — research depth

Key constraint: Genomes with preview_tier < 2 (static HTML) or deployment_target = 0
are penalized by 50% of their total fitness. This ensures the simulation
rewards architectures that can actually run generated apps.
"""
import json
import os
import sys
import random
import time
from copy import deepcopy

# Import genome infrastructure from v3 (now with 97 genes)
sys.path.insert(0, os.path.dirname(__file__))
from butterfly_v3 import (
    GENOME_TEMPLATE, GENE_NAMES, get_spec, random_gene, mutate_val,
    baseline_genome, random_genome, mutate_genome, crossover,
    ISLANDS
)

# Constants not exported from v3 — define here
MUTATION_RATE = 5  # number of genes to mutate per individual (5% of 97)
POPULATION_SIZE = 850
GENERATIONS = 100

# === NEW FITNESS FUNCTION (v8) ===

def fitness_v8(genome: dict, interactions: int = 1000) -> dict:
    """
    10-dimension fitness function with preview/deploy/visual quality.
    Returns a dict with per-dimension scores and a weighted total.
    """
    scores = {}

    # 1. VDR (30%) — same as v7, capped at 91.3%
    base_vdr = min(91.3, 40 + genome.get('research_depth', 3) * 8 +
                   genome.get('retry_limit', 3) * 4 +
                   genome.get('tripwire_sensitivity', 2) * 3)
    vdr_noise = random.gauss(0, 2.0)
    scores['vdr'] = max(0, min(91.3, base_vdr + vdr_noise))

    # 2. Preview Quality (10%) — NEW
    preview_tier = genome.get('preview_tier', 0)
    if preview_tier >= 3:  # container dev server
        scores['preview'] = 95
    elif preview_tier >= 2:  # ESM iframe
        scores['preview'] = 80
    elif preview_tier >= 1:  # static HTML
        scores['preview'] = 30  # penalized — can't run real apps
    else:
        scores['preview'] = 0
    # Hot reload bonus
    if genome.get('preview_hot_reload', 0):
        scores['preview'] += 5
    if genome.get('preview_error_overlay', 0) >= 2:
        scores['preview'] += 5

    # 3. Deployment Success (10%) — NEW
    deploy_target = genome.get('deployment_target', 0)
    if deploy_target >= 1:
        scores['deploy'] = 85
        if genome.get('deployment_auto', 0) >= 1:
            scores['deploy'] += 10  # auto-deploy bonus
    else:
        scores['deploy'] = 10  # severe penalty — no URL for users

    # 4. Visual Quality (10%) — NEW
    token_cov = genome.get('token_coverage', 0)
    brand_conf = genome.get('brand_conformance', 0)
    scores['visual'] = (token_cov * 0.5 + brand_conf * 0.5)
    if genome.get('visual_regression_baseline', 0) >= 1:
        scores['visual'] += 5

    # 5. Generated App Quality (5%) — NEW
    app_complexity = genome.get('generated_app_complexity', 1)
    if app_complexity >= 3:  # fullstack with API
        scores['appquality'] = 90
    elif app_complexity >= 2:  # React SPA
        scores['appquality'] = 70
    else:  # static HTML
        scores['appquality'] = 40

    # 6. UI/UX (10%) — simplified from v7
    ui_score = 50 + genome.get('ui_interaction_mode', 0) * 10 + \
               genome.get('onboarding_depth', 0) * 5
    scores['ui'] = min(100, ui_score)

    # 7. A11y (10%) — same
    a11y = genome.get('accessibility_level', 0)
    scores['a11y'] = min(100, 40 + a11y * 25)

    # 8. Safety (10%) — same
    safety_genes = sum(1 for k in genome if k.startswith('tw_'))
    scores['safety'] = min(100, safety_genes * 11)

    # 9. Real-time (3%) — NEW
    scores['realtime'] = max(0, 100 - genome.get('max_response_time_ms', 2000) / 20)

    # 10. Research Quality (2%) — NEW
    scores['research'] = min(100, genome.get('research_depth', 3) * 20 +
                             genome.get('agent_research_sources', 3) * 10)

    # === CRITICAL PENALTY: static preview or no deploy ===
    penalty = 1.0
    if preview_tier < 2:
        penalty *= 0.5  # 50% penalty for static HTML preview
    if deploy_target == 0:
        penalty *= 0.5  # 50% penalty for no deployment

    # === Weighted Total ===
    weights = {
        'vdr': 0.30,
        'preview': 0.10,
        'deploy': 0.10,
        'visual': 0.10,
        'appquality': 0.05,
        'ui': 0.10,
        'a11y': 0.10,
        'safety': 0.10,
        'realtime': 0.03,
        'research': 0.02,
    }

    total = sum(scores[k] * weights[k] for k in weights) * penalty

    return {
        'total': round(total, 2),
        'penalty': round(penalty, 2),
        'dimensions': {k: round(v, 1) for k, v in scores.items()},
    }


# === EVOLUTION RUN ===

def run_evolution(population=850, generations=100, seed=42):
    random.seed(seed)

    # Initialize islands (same 4-island model as v7)
    island_names = ['solo', 'startup', 'enterprise', 'nonprofit']
    islands = {name: [] for name in island_names}

    # Seed each island with random genomes
    pop_per_island = population // len(island_names)
    for name in island_names:
        for _ in range(pop_per_island):
            islands[name].append({
                'genome': random_genome(),
                'fitness': None,
                'age': 0,
            })

    best_ever = None
    history = []

    for gen in range(generations):
        gen_fitness = []

        for name in island_names:
            for individual in islands[name]:
                result = fitness_v8(individual['genome'])
                individual['fitness'] = result['total']
                individual['penalty'] = result['penalty']
                individual['dimensions'] = result['dimensions']
                gen_fitness.append(individual['fitness'])

            # Sort by fitness (descending)
            islands[name].sort(key=lambda x: x['fitness'] or 0, reverse=True)

            # Elitism: keep top 10%
            elite_count = max(1, pop_per_island // 10)
            elites = islands[name][:elite_count]
            new_pop = deepcopy(elites)

            # Crossover + mutation for the rest
            while len(new_pop) < pop_per_island:
                parent1 = random.choice(elites)
                parent2 = random.choice(elites)
                child_genome = crossover(parent1['genome'], parent2['genome'])
                child_genome = mutate_genome(child_genome, MUTATION_RATE)
                new_pop.append({
                    'genome': child_genome,
                    'fitness': 0,
                    'age': 0,
                })

            islands[name] = new_pop

        # Track best
        all_individuals = [ind for name in island_names for ind in islands[name]]
        all_individuals.sort(key=lambda x: x['fitness'] or 0, reverse=True)
        current_best = all_individuals[0]

        if best_ever is None or current_best['fitness'] > best_ever['fitness']:
            best_ever = deepcopy(current_best)

        avg_fitness = sum(gen_fitness) / len(gen_fitness)
        max_fitness = max(gen_fitness)

        history.append({
            'gen': gen,
            'avg': round(avg_fitness, 2),
            'max': round(max_fitness, 2),
        })

        if gen % 20 == 0 or gen == generations - 1:
            print(f"  Gen {gen}: avg={avg_fitness:.1f} max={max_fitness:.1f} "
                  f"best_ever={best_ever['fitness']:.1f}")

    # Find best island
    best_island = max(island_names,
                      key=lambda n: max(ind['fitness'] for ind in islands[n]))

    # Count changed genes
    baseline = baseline_genome()
    changed = sum(1 for g in baseline if baseline[g] != best_ever['genome'].get(g))

    report = {
        'version': 'v8_preview_deploy_visual',
        'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'seed': seed,
        'vdr_ceiling': 91.3,
        'genome_size': len(GENOME_TEMPLATE),
        'islands': len(island_names),
        'best_island': best_island,
        'best_genome': best_ever['genome'],
        'best_fitness': best_ever['fitness'],
        'best_dimensions': best_ever.get('dimensions', {}),
        'best_penalty': best_ever.get('penalty', 1.0),
        'best_genes_changed': changed,
        'population': population,
        'generations': generations,
        'history': history[-10:],
    }

    return report


if __name__ == '__main__':
    print("=== Butterfly v8 — Preview/Deploy/Visual Quality Evolution ===")
    print(f"Genome: 97 genes (85 original + 12 new)")
    print(f"Fitness: 10 dimensions (VDR 30% + Preview 10% + Deploy 10% + Visual 10%)")
    print(f"Population: 850 | Generations: 100")
    print()

    report = run_evolution(population=850, generations=100, seed=42)

    # Save report
    with open('butterfly_v8_report.json', 'w') as f:
        json.dump(report, f, indent=2)

    print(f"\n=== RESULTS ===")
    print(f"Best fitness: {report['best_fitness']}")
    print(f"Best island: {report['best_island']}")
    print(f"Genes changed: {report['best_genes_changed']}/97")
    print(f"Penalty: {report['best_penalty']}")
    print(f"Dimensions: {report['best_dimensions']}")
    print(f"\nReport saved to simulation/butterfly_v8_report.json")
