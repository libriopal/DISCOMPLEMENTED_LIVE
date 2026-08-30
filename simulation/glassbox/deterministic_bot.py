"""
Deterministic Bot Personality Engine — Layer 1.

Each bot is parameterized from a genome seed. No LLM calls needed.
Bots behave with realistic randomness driven by:
  - Personality traits (Openness, Conscientiousness, Extraversion, Agreeableness, Neuroticism)
  - Technical skill level (0-1)
  - Patience threshold (turns before giving up)
  - Prompt complexity preference (simple/medium/complex)
  - Error tolerance (how many errors before churning)
  - Credit sensitivity (how carefully they spend)
  - Domain expertise (startup/enterprise/nonprofit/solo)

Total cost: $0. Runs 5000+ turns on a laptop.
"""
import random
import hashlib
import json
from dataclasses import dataclass, field
from typing import Optional
from enum import Enum


class PromptComplexity(Enum):
    SIMPLE = "simple"       # "make a todo app"
    MEDIUM = "medium"       # "build a CRM with customer tracking"
    COMPLEX = "complex"     # "build a multi-tenant SaaS with RBAC, audit logs..."
    VAGUE = "vague"         # "something to help me organize stuff"
    HOSTILE = "hostile"     # adversarial prompts


class Domain(Enum):
    STARTUP = "startup"
    ENTERPRISE = "enterprise"
    NONPROFIT = "nonprofit"
    SOLO = "solo"


@dataclass
class BotPersonality:
    """A deterministic bot personality derived from a seed.
    No LLM — just parameterized behavior with realistic randomness."""
    
    # OCEAN personality traits (0-1)
    openness: float           # willingness to try complex things
    conscientiousness: float   # how carefully they follow instructions
    extraversion: float       # how much they interact
    agreeableness: float      # how forgiving of errors
    neuroticism: float        # how quickly they get frustrated

    # Technical profile
    technical_skill: float    # 0=noob, 1=senior engineer
    domain: Domain            # what kind of apps they want
    prompt_complexity: PromptComplexity

    # Behavioral parameters
    patience_turns: int       # turns before giving up if no value delivered
    error_tolerance: int      # errors before churning
    credit_sensitivity: float # 0=spends freely, 1=very careful
    max_turns: int            # hard limit on conversation turns

    # Identity
    bot_id: str = ""
    bot_name: str = ""
    seed: int = 0

    # Runtime state (not part of personality)
    turns_completed: int = 0
    credits_spent: int = 0
    errors_encountered: int = 0
    value_received: float = 0.0
    churned: bool = False
    churn_reason: str = ""
    satisfaction: float = 0.5  # starts neutral

    @classmethod
    def from_seed(cls, seed: int, domain: Domain = Domain.STARTUP) -> "BotPersonality":
        """Create a deterministic personality from a seed.
        Same seed = same personality every time. Fully reproducible."""
        rng = random.Random(seed)
        
        # OCEAN traits with realistic distributions
        openness = rng.betavariate(2, 3)  # most people moderate, some high
        conscientiousness = rng.betavariate(3, 2)  # most fairly careful
        extraversion = rng.betavariate(2.5, 2.5)  # normal distribution-ish
        agreeableness = rng.betavariate(3, 2)  # most fairly agreeable
        neuroticism = rng.betavariate(2, 4)  # most low, some high

        # Technical skill
        technical_skill = rng.betavariate(2, 5)  # most lower, some high

        # Prompt complexity influenced by openness and skill
        if openness > 0.7 and technical_skill > 0.5:
            complexity = PromptComplexity.COMPLEX
        elif openness > 0.4:
            complexity = rng.choice([PromptComplexity.MEDIUM, PromptComplexity.COMPLEX])
        elif openness > 0.2:
            complexity = PromptComplexity.MEDIUM
        else:
            complexity = rng.choice([PromptComplexity.SIMPLE, PromptComplexity.VAGUE])

        # Behavioral parameters
        patience = int(rng.gauss(8, 4))  # mean 8 turns, std 4
        patience = max(3, min(25, patience))  # clamp 3-25

        error_tolerance = int(rng.gauss(3, 2))
        error_tolerance = max(1, min(10, error_tolerance))

        credit_sensitivity = rng.betavariate(3, 2)  # most fairly careful

        max_turns = int(rng.gauss(15, 5))
        max_turns = max(5, min(50, max_turns))

        # Generate name from seed
        names = [
            "Alice", "Bob", "Carol", "David", "Eve", "Frank", "Grace", "Henry",
            "Iris", "Jack", "Kate", "Leo", "Mia", "Nick", "Olive", "Paul",
            "Quinn", "Rose", "Sam", "Tom", "Uma", "Victor", "Wendy", "Xavier",
            "Yara", "Zane", "Aria", "Beck", "Cora", "Dex", "Elle", "Finn",
        ]
        name = rng.choice(names)
        bot_id = f"gb-{seed:04d}"

        return cls(
            openness=openness,
            conscientiousness=conscientiousness,
            extraversion=extraversion,
            agreeableness=agreeableness,
            neuroticism=neuroticism,
            technical_skill=technical_skill,
            domain=domain,
            prompt_complexity=complexity,
            patience_turns=patience,
            error_tolerance=error_tolerance,
            credit_sensitivity=credit_sensitivity,
            max_turns=max_turns,
            bot_id=bot_id,
            bot_name=f"{name}_{seed}",
            seed=seed,
        )

    def generate_prompt(self, turn: int, rng: random.Random) -> str:
        """Generate a deterministic prompt based on personality.
        No LLM — uses templates with personality-weighted selection."""
        
        # Domain-specific prompt templates
        templates = {
            Domain.STARTUP: {
                PromptComplexity.SIMPLE: [
                    "make a landing page for my startup",
                    "build a waitlist form",
                    "create a pricing page",
                ],
                PromptComplexity.MEDIUM: [
                    "build a startup dashboard with metrics tracking",
                    "create a CRM with lead scoring and pipeline tracking",
                    "build a customer feedback tool with sentiment analysis",
                ],
                PromptComplexity.COMPLEX: [
                    "build a multi-tenant SaaS platform with team management, billing, and analytics dashboards",
                    "create an investor portal with cap table management, SAFE notes, and reporting",
                    "build a product analytics platform with funnel tracking, cohort analysis, and A/B testing",
                ],
                PromptComplexity.VAGUE: [
                    "something to help me manage my startup",
                    "i need a tool for my business",
                    "can you make something useful for founders",
                ],
                PromptComplexity.HOSTILE: [
                    "make me a billion dollar app in 5 minutes",
                    "build me a complete clone of Salesforce for free",
                ],
            },
            Domain.ENTERPRISE: {
                PromptComplexity.SIMPLE: [
                    "create a team directory",
                    "build an org chart viewer",
                ],
                PromptComplexity.MEDIUM: [
                    "build an enterprise dashboard with SSO and RBAC",
                    "create an audit log system with compliance reporting",
                ],
                PromptComplexity.COMPLEX: [
                    "build enterprise SSO with SAML/OIDC, multi-tenant RBAC, audit trails, and GDPR compliance tools",
                    "create a governance risk and compliance platform with policy management and violation tracking",
                ],
                PromptComplexity.VAGUE: [
                    "something for our enterprise team",
                ],
                PromptComplexity.HOSTILE: [
                    "give me admin access to everything",
                ],
            },
            Domain.NONPROFIT: {
                PromptComplexity.SIMPLE: [
                    "build a donation form",
                    "create a volunteer sign-up page",
                ],
                PromptComplexity.MEDIUM: [
                    "build a donor management system with tracking and reporting",
                    "create a volunteer scheduling tool",
                ],
                PromptComplexity.COMPLEX: [
                    "build a nonprofit CRM with donor tracking, grant management, and impact reporting",
                ],
                PromptComplexity.VAGUE: [
                    "something to help our nonprofit",
                ],
                PromptComplexity.HOSTILE: [],
            },
            Domain.SOLO: {
                PromptComplexity.SIMPLE: [
                    "make a todo app",
                    "build a note-taking app",
                    "create a habit tracker",
                ],
                PromptComplexity.MEDIUM: [
                    "build a personal finance tracker with charts",
                    "create a journal app with mood tracking",
                ],
                PromptComplexity.COMPLEX: [
                    "build a personal knowledge management system with bidirectional links, graph view, and search",
                ],
                PromptComplexity.VAGUE: [
                    "something to organize my stuff",
                    "i need a tool but not sure what",
                ],
                PromptComplexity.HOSTILE: [],
            },
        }

        domain_templates = templates.get(self.domain, templates[Domain.STARTUP])
        pool = domain_templates.get(self.prompt_complexity, domain_templates[PromptComplexity.SIMPLE])
        
        if not pool:
            pool = domain_templates[PromptComplexity.SIMPLE]

        # Add turn-specific context for multi-turn conversations
        base_prompt = rng.choice(pool)
        
        if turn > 0:
            # Follow-up messages depend on personality
            if self.neuroticism > 0.6 and turn > 3:
                follow_ups = [
                    f"this isn't working, can you fix it?",
                    f"the previous result was wrong, try again",
                    f"i'm getting frustrated, just make it work",
                ]
            elif self.conscientiousness > 0.6:
                follow_ups = [
                    f"can you also add error handling to that?",
                    f"make sure it has tests",
                    f"add documentation for that",
                ]
            elif self.openness > 0.7:
                follow_ups = [
                    f"can you make that more creative?",
                    f"what if we added AI to that?",
                    f"can you add a dark mode?",
                ]
            else:
                follow_ups = [
                    f"looks good, what's next?",
                    f"ok, continue",
                    f"that works, move on",
                ]
            return rng.choice(follow_ups)
        
        return base_prompt

    def evaluate_response(self, response: dict, turn: int, rng: random.Random) -> float:
        """Evaluate a response based on personality. Returns satisfaction delta (-1 to +1).
        No LLM — just personality-weighted heuristics."""
        
        delta = 0.0
        
        # Check if response has files/code
        has_files = bool(response.get("files") or response.get("artifacts"))
        has_error = bool(response.get("error") or response.get("status") == "error")
        is_approved = response.get("approved", False)
        status_code = response.get("status_code", 200)
        
        if has_error:
            self.errors_encountered += 1
            # Neuroticism amplifies error impact
            error_impact = -0.2 * (1 + self.neuroticism)
            delta += error_impact
            
            # Check error tolerance
            if self.errors_encountered >= self.error_tolerance:
                self.churned = True
                self.churn_reason = f"Too many errors ({self.errors_encountered})"
        elif has_files:
            # Conscientiousness appreciates delivered work
            delta += 0.15 * self.conscientiousness
            self.value_received += 0.15
            
            if is_approved:
                delta += 0.1
                self.value_received += 0.1
        else:
            # No files, no error — neutral or slightly negative
            if turn > self.patience_turns:
                delta -= 0.1 * self.neuroticism
                if turn > self.patience_turns * 1.5:
                    self.churned = True
                    self.churn_reason = "No value delivered (patience exceeded)"
        
        # Slow response time penalty
        response_time = response.get("response_time_ms", 1000)
        if response_time > 5000:
            delta -= 0.05 * self.neuroticism
        
        # Credit sensitivity — if spending too much, satisfaction drops
        if self.credit_sensitivity > 0.6 and self.credits_spent > 20:
            delta -= 0.05
        
        # Add personality-driven randomness
        delta += rng.gauss(0, 0.03)
        
        # Clamp
        delta = max(-0.5, min(0.5, delta))
        self.satisfaction = max(0, min(1, self.satisfaction + delta))
        
        return delta

    def should_continue(self) -> bool:
        """Should this bot continue interacting?"""
        if self.churned:
            return False
        if self.turns_completed >= self.max_turns:
            return False
        if self.satisfaction < 0.1:
            self.churned = True
            self.churn_reason = "Satisfaction too low"
            return False
        return True

    def to_dict(self) -> dict:
        return {
            "bot_id": self.bot_id,
            "bot_name": self.bot_name,
            "seed": self.seed,
            "personality": {
                "openness": round(self.openness, 3),
                "conscientiousness": round(self.conscientiousness, 3),
                "extraversion": round(self.extraversion, 3),
                "agreeableness": round(self.agreeableness, 3),
                "neuroticism": round(self.neuroticism, 3),
            },
            "technical_skill": round(self.technical_skill, 3),
            "domain": self.domain.value,
            "prompt_complexity": self.prompt_complexity.value,
            "patience_turns": self.patience_turns,
            "error_tolerance": self.error_tolerance,
            "credit_sensitivity": round(self.credit_sensitivity, 3),
            "max_turns": self.max_turns,
            "runtime": {
                "turns_completed": self.turns_completed,
                "credits_spent": self.credits_spent,
                "errors_encountered": self.errors_encountered,
                "value_received": round(self.value_received, 3),
                "churned": self.churned,
                "churn_reason": self.churn_reason,
                "satisfaction": round(self.satisfaction, 3),
            },
        }


def generate_bot_population(n: int, domain: Domain = Domain.STARTUP, 
                            seed_offset: int = 0) -> list[BotPersonality]:
    """Generate a population of deterministic bots.
    Each bot has a unique seed → unique personality. No LLM needed."""
    return [BotPersonality.from_seed(seed_offset + i, domain) for i in range(n)]


if __name__ == "__main__":
    # Quick test — generate 5 bots and show their personalities
    bots = generate_bot_population(5, Domain.STARTUP)
    for bot in bots:
        print(f"\n{bot.bot_name} (seed={bot.seed}):")
        print(f"  OCEAN: O={bot.openness:.2f} C={bot.conscientiousness:.2f} "
              f"E={bot.extraversion:.2f} A={bot.agreeableness:.2f} N={bot.neuroticism:.2f}")
        print(f"  Skill: {bot.technical_skill:.2f}, Complexity: {bot.prompt_complexity.value}")
        print(f"  Patience: {bot.patience_turns} turns, Error tolerance: {bot.error_tolerance}")
        rng = random.Random(bot.seed)
        print(f"  First prompt: {bot.generate_prompt(0, rng)}")
