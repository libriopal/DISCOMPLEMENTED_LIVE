# Butterfly Evolutionary Optimizer — Research Source of Truth

**Date:** 2026-08-19
**Source:** You.com Answer API (api.you.com/v1/answer) with citation-backed research
**Purpose:** Ground the Butterfly evolutionary architecture optimizer in proven, peer-reviewed practices

---

## 1. Optimal GA Parameters for 50+ Gene Genomes

**Citations:**

- [acadenia.edu/32638949](https://www.academia.edu/32638949/THE_OPTIMAL_CROSSOVER_OR_MUTATION_RATES_IN_GENETIC_ALGORITHM_A_REVIEW)
- [algorithmafternoon.com](https://algorithmafternoon.com/books/genetic_algorithm/chapter06/)
- [ResearchGate/225642916](https://www.researchgate.net/publication/225642916_Adaptive_mutation_in_genetic_algorithms)

**Current Butterfly settings → Research-recommended settings:**

| Parameter            | Current       | Research-Recommended                                 | Source                             |
| -------------------- | ------------- | ---------------------------------------------------- | ---------------------------------- |
| Population size      | 25            | **100–150** (100 validated as optimal)               | Adaptive mutation studies          |
| Crossover rate       | ~0.5 (random) | **0.8–0.9**                                          | Repeatedly reported effective      |
| Mutation rate        | 0.12 (fixed)  | **0.02 base, adaptive 0.02→0.05**                    | DeJong, adaptive mutation research |
| Generations          | 20            | **1,000–5,000** (convergence within hundreds)        | Goldberg & Deb O(log N) theory     |
| Elitism              | 6/25 (24%)    | **Top 10%** (10/100)                                 | UNSW recommendation                |
| Stagnation detection | None          | **Increase mutation after ~50 stagnant generations** | Adaptive mutation experiments      |

## 2. Multi-Objective Fitness: NSGA-II

**Citations:**

- [ResearchGate NSGA-II fitness](https://www.researchgate.net/post/What-is-the-fitness-function-in-NSGA-II-Algorithm-Multiobjective-Optimization)
- [ResearchGate constraint handling](https://www.researchgate.net/publication/224393743_Constraint_Handling_in_Multiobjective_Evolutionary_Optimization)

**Current Butterfly:** Weighted sum (VDR×40% + UI×25% + A11y×15% + RT×10% + Safety×10%)
**Research finding:** Weighted sums are suboptimal for multi-objective optimization. NSGA-II uses:

- **Pareto dominance** — solutions are ranked into non-dominated fronts
- **Crowding distance** — preserves diversity within each front
- **Constrained Dominance Principle (CDP)** — feasible solutions always dominate infeasible ones
- **No scalarization** — produces a Pareto front of trade-off solutions

**Recommendation:** Replace weighted sum with NSGA-II non-dominated sorting + CDP for safety constraints.

## 3. Architectural Gene Types for Software Systems

**Citations:**

- [ResearchGate multiobjective GA building form](https://www.researchgate.net/publication/258868740)
- [ScienceDirect component placement](https://www.sciencedirect.com/science/article/abs/pii/S0020025512000242)

**Missing gene categories the Butterfly should add:**

1. **Component placement genes** — which agent runs on which model/endpoint
2. **Interface/API genes** — API contract parameters, protocol choices
3. **Responsibility genes** — execution time, parameter size, frequency of use per agent
4. **GA control genes** — the evolutionary parameters themselves (population, mutation rate) as evolvable

## 4. Prompt Engineering as Evolvable Genes

**Citations:**

- [Cameron Wolfe: Automatic Prompt Optimization](https://cameronrwolfe.substack.com/p/automatic-prompt-optimization)
- [arxiv.org/2504.07157](https://arxiv.org/html/2504.07157v3)
- [arxiv.org/2309.16797](https://arxiv.org/pdf/2309.16797)
- [github.com/alignment-farm/genetic-prompt-programming](https://github.com/alignment-farm/genetic-prompt-programming)

**Finding:** Prompts CAN be evolved genetically. Prompts are encoded as sequences analogous to DNA, and evolutionary operators (mutation, crossover) are applied — often by the LLM itself. Fitness is measured on validation data.

**New gene categories to add:**

- Prompt structure genes (few-shot vs zero-shot, chain-of-thought vs direct)
- Prompt length gene (short vs long system prompts)
- Prompt temperature coupling (how model temperature relates to prompt style)
- Context injection genes (what context gets injected into prompts)

## 5. Preventing Premature Convergence

**Citations:**

- [PLOS ONE adaptive regeneration](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0321711)
- [ResearchGate premature convergence IR](https://www.researchgate.net/publication/279249038)
- [ResearchGate mechanisms to avoid convergence](https://www.researchgate.net/publication/267409605)

**Current Butterfly problem:** VDR plateaus at ~77% after generation 10
**Research-recommended strategies:**

1. **Adaptive regeneration** — re-initialize part of population when fitness stagnates
2. **Dynamic operator rates** — increase exploration when convergence detected
3. **Adaptive mutation** — raise mutation probability as diversity drops
4. **Niching/crowding** — maintain multiple sub-populations exploring different regions
5. **Island model** — parallel sub-populations with occasional migration
6. **Selection tuning** — reduce selective pressure (smaller tournaments)
7. **Larger population** — more genetic variety for high-dimensional genomes

## 6. Contextual Environment in GAs

**Citations:**

- [ScienceDirect heterogeneous fitness landscapes](https://www.sciencedirect.com/science/article/abs/pii/S0378437122004137)
- [Springer geographic isolation](https://link.springer.com/chapter/10.1007/978-3-642-41888-4_10)
- [PLOS CompBio G×E interactions](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1006445)

**Finding:** The contextual environment shapes the fitness landscape. Key concepts:

- **Genotype-by-Environment (G×E) interactions** — the same genome performs differently in different environments
- **Dynamic environments** — fitness landscape changes over time
- **Co-evolutionary fitness** — fitness depends on other agents' state
- **Island model with migration** — different environments = different fitness functions

**Application to Butterfly:**

- Simulate different user environments (enterprise, startup, solo dev, agency)
- Each environment has different fitness weights (enterprise cares about security, startup about speed)
- Run island model: separate populations evolve in different environments, occasionally migrate

## 7. Epigenetic Gene Regulation

**Citations:**

- [arxiv.org/1903.03854](https://arxiv.org/pdf/1903.03854)
- [PMC/10170609](https://pmc.ncbi.nlm.nih.gov/articles/PMC10170609/)

**Finding:** Epigenetic layers allow gene activation/deactivation without changing the genotype:

1. **Epiline** — binary activation mask per gene (on/off)
2. **Adaptive factor** — measures environmental change, triggers epi-mutations
3. **Inheritance** — epigenetic tags transfer to offspring during crossover

**Application to Butterfly:**

- Add epiline mask: not all 51 genes need to be active simultaneously
- Environment determines which genes are expressed
- E.g., mobile environment activates UI genes, enterprise environment activates security genes

## 8. NSGA-II Python Implementation

**Citations:**

- [pymoo.org getting started](https://pymoo.org/getting_started/part_2.html)
- [Medium NSGA-II sustainable urban futures](https://medium.com/operations-research-bit/a-dive-into-multi-objective-optimization-crafting-sustainable-urban-futures-656151f30c22)

**Finding:** pymoo library provides:

- `ElementwiseProblem` for custom problem definition
- SBX crossover + polynomial mutation (PM)
- Automatic constraint handling via constraint vector G
- Pareto front visualization with matplotlib
- Adaptive mutation: `eta = 20 * (1 - gen/max_gen)`

## 9. Consolidated Recommendations for Butterfly v3

Based on all research findings:

### Genome Expansion (51 → ~70 genes)

- **Prompt engineering genes (6):** few-shot/zero-shot, chain-of-thought, prompt length, context injection, temperature coupling, system prompt style
- **Component placement genes (4):** agent-to-model mapping, agent-to-endpoint routing, agent responsibility weight, agent execution priority
- **Interface/API genes (3):** API contract strictness, protocol choice (REST/GraphQL/gRPC), rate limiting strategy
- **Epigenetic activation mask (51 genes):** binary on/off per gene, environment-driven
- **GA control genes (4):** population size, mutation rate, crossover rate, elitism ratio — the evolution tunes ITSELF

### Algorithm Upgrade

- Replace weighted-sum fitness with **NSGA-II** non-dominated sorting
- Add **Constrained Dominance Principle** for safety constraints
- Implement **adaptive mutation**: 0.02 base → 0.05 on stagnation (50 generations)
- Add **island model**: 4 parallel sub-populations (enterprise, startup, solo, agency environments)
- Add **epigenetic layer**: gene activation mask driven by environment
- Add **stagnation detection**: increase mutation rate when no improvement for N generations

### Parameter Updates (research-backed)

- Population: 25 → **100**
- Crossover rate: ~0.5 → **0.85**
- Mutation rate: 0.12 (fixed) → **0.02 base, adaptive to 0.05**
- Generations: 20 → **500+** (convergence expected within hundreds)
- Elitism: 24% → **10%** (10 of 100)

### Safety Constraints (unchanged)

- Safety genes remain FROZEN — never mutated, never crossed over
- CDP ensures feasible solutions always dominate infeasible ones
- Hard constraints: usability floor, RT limit, a11y floor, credit burn cap
