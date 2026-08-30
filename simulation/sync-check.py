#!/usr/bin/env python3
"""
Sync verification script — checks that the local genome_config.py
is in sync with the production /api/genome/status endpoint.

Run this before any Monte Carlo simulation to ensure parity.
If out of sync, regenerate genome_config.py from the TypeScript source.

Usage:
    python3 sync-check.py [--production-url https://discomplemented.com]
"""
import json
import sys
import urllib.request
from genome_config import GENOME_COUNT, MONTE_CARLO_POPULATION, DAILY_STAGING_BOTS, GENERATION_COUNT, SIM_SEED

def check_sync(production_url='https://discomplemented.com'):
    """Fetch the production genome status and compare with local config."""
    try:
        url = f"{production_url}/api/genome/status"
        print(f"Fetching genome status from {url}...")
        with urllib.request.urlopen(url, timeout=10) as response:
            data = json.loads(response.read())

        production_genome = data.get('genomeCount')
        production_pop = data.get('monteCarloPopulation')
        production_bots = data.get('dailyStagingBots')
        production_gen = data.get('generationCount')
        production_seed = data.get('seed')

        print(f"\n=== Production (source of truth) ===")
        print(f"  Genome count: {production_genome}")
        print(f"  Monte Carlo population: {production_pop}")
        print(f"  Daily staging bots: {production_bots}")
        print(f"  Generations: {production_gen}")
        print(f"  Seed: {hex(production_seed) if production_seed else 'N/A'}")

        print(f"\n=== Local config ===")
        print(f"  Genome count: {GENOME_COUNT}")
        print(f"  Monte Carlo population: {MONTE_CARLO_POPULATION}")
        print(f"  Daily staging bots: {DAILY_STAGING_BOTS}")
        print(f"  Generations: {GENERATION_COUNT}")
        print(f"  Seed: {hex(SIM_SEED)}")

        mismatches = []
        if production_genome != GENOME_COUNT:
            mismatches.append(f"  ❌ Genome count: local={GENOME_COUNT} vs production={production_genome}")
        if production_pop != MONTE_CARLO_POPULATION:
            mismatches.append(f"  ❌ MC Population: local={MONTE_CARLO_POPULATION} vs production={production_pop}")
        if production_bots != DAILY_STAGING_BOTS:
            mismatches.append(f"  ❌ Daily bots: local={DAILY_STAGING_BOTS} vs production={production_bots}")
        if production_gen != GENERATION_COUNT:
            mismatches.append(f"  ❌ Generations: local={GENERATION_COUNT} vs production={production_gen}")
        if production_seed and production_seed != SIM_SEED:
            mismatches.append(f"  ❌ Seed: local={hex(SIM_SEED)} vs production={hex(production_seed)}")

        if mismatches:
            print(f"\n{'='*50}")
            print(f"❌ SYNC FAILED — {len(mismatches)} mismatch(es):")
            for m in mismatches:
                print(m)
            print(f"\n⚠ ACTION REQUIRED: Regenerate genome_config.py from TypeScript source.")
            print(f"  Run: python3 -c \"from simulation.generate_config import main; main()\"")
            sys.exit(1)
        else:
            print(f"\n{'='*50}")
            print(f"✅ SYNC VERIFIED — local config matches production.")
            print(f"   1:1:1 parity confirmed. Safe to proceed with Monte Carlo.")
            sys.exit(0)

    except Exception as e:
        print(f"❌ Error fetching production genome status: {e}")
        print(f"   Cannot verify sync. Aborting for safety.")
        sys.exit(2)

if __name__ == '__main__':
    url = 'https://discomplemented.com'
    if '--production-url' in sys.argv:
        idx = sys.argv.index('--production-url')
        if idx + 1 < len(sys.argv):
            url = sys.argv[idx + 1]
    check_sync(url)
