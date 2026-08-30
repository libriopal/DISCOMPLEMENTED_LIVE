"""
Dataset Ingestion — stream real human conversation data from HuggingFace.

Datasets:
  1. allenai/WildChat (529K real human-ChatGPT conversations)
  2. DeepMostInnovations/saas-sales-conversations (100K SaaS sales conversations)

Uses HuggingFace Datasets streaming to avoid downloading the full 7GB.
Extracts behavioral patterns for bot persona generation.
"""
import json
import random
from collections import defaultdict
from typing import Iterator

try:
    from datasets import load_dataset
except ImportError:
    print("ERROR: pip install datasets")
    exit(1)


def stream_wildchat(sample_size: int = 4000) -> list[dict]:
    """Stream WildChat conversations and extract behavioral patterns."""
    print(f"Streaming WildChat (sampling {sample_size} conversations)...")

    ds = load_dataset("allenai/WildChat", split="train", streaming=True)

    conversations = []
    for i, row in enumerate(ds):
        if i >= sample_size:
            break

        conv = row.get("conversation", [])
        turns = len(conv)
        user_messages = [t for t in conv if t.get("role") == "user"]
        assistant_messages = [t for t in conv if t.get("role") == "assistant"]

        # Extract behavioral features
        total_chars = sum(len(t.get("content", "")) for t in conv)
        avg_user_msg_len = (
            sum(len(m.get("content", "")) for m in user_messages) / max(len(user_messages), 1)
        )
        toxic = row.get("toxic", False)
        redacted = row.get("redacted", False)
        language = row.get("language", "unknown")

        # Classify behavioral pattern
        pattern = classify_wildchat_pattern(
            turns=turns,
            total_chars=total_chars,
            avg_user_msg_len=avg_user_msg_len,
            toxic=toxic,
            redacted=redacted,
            user_messages=user_messages,
        )

        conversations.append({
            "source": "wildchat",
            "conversation_id": row.get("conversation_id", ""),
            "turns": turns,
            "total_chars": total_chars,
            "avg_user_msg_len": avg_user_msg_len,
            "toxic": toxic,
            "redacted": redacted,
            "language": language,
            "pattern": pattern,
            "first_user_msg": user_messages[0]["content"][:200] if user_messages else "",
            "user_messages": [m["content"] for m in user_messages],
        })

    print(f"  Extracted {len(conversations)} WildChat conversations")
    return conversations


def classify_wildchat_pattern(
    turns: int, total_chars: int, avg_user_msg_len: float,
    toxic: bool, redacted: bool, user_messages: list
) -> str:
    """Classify a conversation into a behavioral pattern."""
    if toxic:
        return "toxic_adversarial"
    if redacted:
        return "redacted_sensitive"
    if turns > 50:
        return "ultra_long_conversation"
    if avg_user_msg_len > 2000:
        return "token_stuffer"
    if turns <= 2 and avg_user_msg_len < 50:
        return "minimal_user"
    # Check for constraint/jailbreak patterns
    first_msg = user_messages[0]["content"][:500] if user_messages else ""
    if "CONSTRAINTS" in first_msg or "ignore previous" in first_msg.lower():
        return "jailbreak_attempt"
    if "you are" in first_msg.lower() and "must" in first_msg.lower():
        return "role_injection"
    if any(
        m.get("content", "") for m in user_messages
        if len(m.get("content", "")) < 20 and m.get("content", "").strip().endswith("?")
    ):
        return "simple_questioner"
    return "normal_user"


def stream_saas_sales(sample_size: int = 4000) -> list[dict]:
    """Stream SaaS sales conversations and extract behavioral patterns."""
    print(f"Streaming SaaS sales conversations (sampling {sample_size})...")

    ds = load_dataset(
        "DeepMostInnovations/saas-sales-conversations", split="train", streaming=True
    )

    conversations = []
    for i, row in enumerate(ds):
        if i >= sample_size:
            break

        # This dataset has 3088 columns — extract only the relevant ones
        company_name = row.get("company_name", "")
        product_name = row.get("product_name", "")
        product_type = row.get("product_type", "")
        conversation_json = row.get("conversation", "[]")
        outcome = row.get("outcome", 0)
        conv_length = row.get("conversation_length", 0)
        customer_engagement = row.get("customer_engagement", 0)
        sales_effectiveness = row.get("sales_effectiveness", 0)
        conv_style = row.get("conversation_style", "unknown")
        comm_channel = row.get("communication_channel", "unknown")
        full_text = row.get("full_text", "")

        try:
            conv_data = json.loads(conversation_json) if isinstance(conversation_json, str) else conversation_json
        except (json.JSONDecodeError, TypeError):
            conv_data = []

        pattern = classify_saas_pattern(
            outcome=outcome,
            engagement=customer_engagement,
            conv_length=conv_length,
            style=conv_style,
            channel=comm_channel,
        )

        conversations.append({
            "source": "saas_sales",
            "company_name": company_name,
            "product_name": product_name,
            "product_type": product_type,
            "outcome": outcome,
            "conversation_length": conv_length,
            "customer_engagement": customer_engagement,
            "sales_effectiveness": sales_effectiveness,
            "conversation_style": conv_style,
            "communication_channel": comm_channel,
            "pattern": pattern,
            "full_text": full_text[:500],
            "first_msg_preview": full_text[:200] if full_text else "",
        })

    print(f"  Extracted {len(conversations)} SaaS sales conversations")
    return conversations


def classify_saas_pattern(
    outcome: int, engagement: float, conv_length: int,
    style: str, channel: str
) -> str:
    """Classify a SaaS sales conversation into a behavioral pattern."""
    if outcome == 0 and engagement > 0.7:
        return "high_engagement_no_conversion"  # credit burner pattern
    if outcome == 1:
        return "successful_conversion"  # happy path
    if outcome == 0 and engagement < 0.3:
        return "low_engagement_abandoned"  # confused user
    if conv_length > 20:
        return "long_negotiation"  # multi-turn builder
    if "casual" in style.lower():
        return "casual_browser"  # free rider
    if "direct" in style.lower() and outcome == 0:
        return "direct_rejection"  # gate tester
    if channel == "chat":
        return "chat_free_tier"  # free tier user
    return "standard_saas_user"


def build_persona_pool(
    wildchat_data: list[dict],
    saas_data: list[dict],
    num_bots: int = 30,
) -> list[dict]:
    """Build a pool of bot personas from the extracted patterns."""
    print(f"Building {num_bots} bot personas...")

    # Aggregate patterns by frequency
    wildchat_patterns = defaultdict(list)
    for conv in wildchat_data:
        wildchat_patterns[conv["pattern"]].append(conv)

    saas_patterns = defaultdict(list)
    for conv in saas_data:
        saas_patterns[conv["pattern"]].append(conv)

    personas = []
    persona_types = [
        # (name, source, pattern, description, danger_level)
        ("loop_bomber", "wildchat", "normal_user",
         "Sends the same prompt repeatedly to trigger generation loops", "critical"),
        ("token_stuffer", "wildchat", "token_stuffer",
         "Sends extremely long prompts to overflow context windows", "critical"),
        ("jailbreak_hunter", "wildchat", "jailbreak_attempt",
         "Attempts prompt injection and system override", "critical"),
        ("role_injector", "wildchat", "role_injection",
         "Tries to override the agent's role and instructions", "high"),
        ("toxic_adversary", "wildchat", "toxic_adversarial",
         "Sends adversarial content to test moderation gates", "high"),
        ("ultra_long_talker", "wildchat", "ultra_long_conversation",
         "Builds 50+ turn conversations to exploit memory/state bugs", "medium"),
        ("minimal_user", "wildchat", "minimal_user",
         "Sends very short prompts — tests error handling for vague input", "low"),
        ("simple_questioner", "wildchat", "simple_questioner",
         "Asks simple questions instead of building apps", "low"),
        ("credit_burner", "saas_sales", "high_engagement_no_conversion",
         "Keeps pipeline running but never approves — wastes credits", "critical"),
        ("happy_path", "saas_sales", "successful_conversion",
         "Normal user who wants an app built successfully", "none"),
        ("gate_tester", "saas_sales", "direct_rejection",
         "Tries every possible path through approval gates", "high"),
        ("confused_user", "saas_sales", "low_engagement_abandoned",
         "Can't articulate what they want — tests UX clarity", "low"),
        ("multi_turn_builder", "saas_sales", "long_negotiation",
         "Builds long context to test state management", "medium"),
        ("free_rider", "saas_sales", "chat_free_tier",
         "Tries to access pro features without paying", "high"),
        ("casual_browser", "saas_sales", "casual_browser",
         "Browses but doesn't commit — tests free tier limits", "low"),
    ]

    # Generate personas
    for i in range(num_bots):
        persona_type = persona_types[i % len(persona_types)]
        name, source, pattern, desc, danger = persona_type

        # Sample real conversation data for this persona
        pool = wildchat_patterns.get(pattern, []) if source == "wildchat" else saas_patterns.get(pattern, [])
        sample = random.choice(pool) if pool else {}

        persona = {
            "bot_id": f"bot-{i:03d}",
            "bot_name": name,
            "source": source,
            "pattern": pattern,
            "description": desc,
            "danger_level": danger,
            "credit_budget": 50,  # hard cap per bot
            "turn_limit": 30,     # hard cap per conversation
            "timeout_seconds": 60,
            "real_data_sample": {
                "turns": sample.get("turns", sample.get("conversation_length", 0)),
                "avg_msg_len": sample.get("avg_user_msg_len", 0),
                "first_msg": sample.get("first_user_msg", sample.get("first_msg_preview", "")),
                "engagement": sample.get("customer_engagement", 0),
                "outcome": sample.get("outcome", None),
            },
        }
        personas.append(persona)

    print(f"  Generated {len(personas)} bot personas")
    return personas


def main():
    """Run dataset ingestion and save persona pool."""
    print("=" * 60)
    print("Monte Carlo Simulation: Dataset Ingestion")
    print("=" * 60)

    # Stream datasets
    wildchat = stream_wildchat(sample_size=4000)
    saas = stream_saas_sales(sample_size=4000)

    # Build persona pool
    personas = build_persona_pool(wildchat, saas, num_bots=30)

    # Save results
    wildchat_pattern_counts = defaultdict(int)
    for c in wildchat:
        wildchat_pattern_counts[c["pattern"]] += 1

    saas_pattern_counts = defaultdict(int)
    for c in saas:
        saas_pattern_counts[c["pattern"]] += 1

    output = {
        "wildchat_patterns": dict(wildchat_pattern_counts),
        "saas_patterns": dict(saas_pattern_counts),
        "personas": personas,
        "total_wildchat_sampled": len(wildchat),
        "total_saas_sampled": len(saas),
    }

    with open("simulation/persona_pool.json", "w") as f:
        json.dump(output, f, indent=2)

    print(f"\nPersona pool saved to simulation/persona_pool.json")
    print(f"  WildChat patterns: {output['wildchat_patterns']}")
    print(f"  SaaS patterns: {output['saas_patterns']}")
    print(f"  Total bots: {len(personas)}")

    # Print danger level summary
    danger_counts = defaultdict(int)
    for p in personas:
        danger_counts[p["danger_level"]] += 1
    print(f"  Danger levels: {dict(danger_counts)}")


if __name__ == "__main__":
    main()
