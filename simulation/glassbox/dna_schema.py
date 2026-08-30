"""
DNA-to-Schema Mapping Engine — Semantic Memory Cloud.

Links the architecture genome (DNA) directly to database schemas.
Each gene maps to a schema field, table, or migration.

This creates a coherent, visual layer where:
  - Genome mutations = schema migrations
  - Gene expression = schema activation
  - DNA sequences = table relationships
  - Semantic embeddings = field similarity

The semantic memory cloud visualizes how architectural DNA shapes
the database — making the genome-to-code pipeline explicit and auditable.

Mapping structure:
  Gene → { table, column, type, migration, expression_level }

Expression level:
  0 = dormant (gene exists but not active in schema)
  1 = latent (field exists but not used)
  2 = active (field is used by the application)
  3 = critical (field is essential for operation)
"""
import json
import os
from dataclasses import dataclass, field
from typing import Optional
from enum import IntEnum


class ExpressionLevel(IntEnum):
    DORMANT = 0   # gene exists but not active in schema
    LATENT = 1     # field exists but not used
    ACTIVE = 2     # field is used by the application
    CRITICAL = 3   # field is essential for operation


@dataclass
class GeneSchemaMapping:
    """Maps a single genome gene to its database representation."""
    gene_name: str
    category: str
    value: any
    expression_level: ExpressionLevel
    
    # Database mapping
    table: str
    column: Optional[str] = None  # None if the gene maps to a whole table
    column_type: Optional[str] = None  # TEXT, INTEGER, REAL, etc.
    migration: Optional[str] = None  # which migration created this
    
    # Semantic info
    description: str = ""
    user_need: str = ""  # what real user need this gene addresses
    
    # Embedding info (for semantic memory cloud)
    embedding_id: Optional[str] = None
    semantic_cluster: Optional[str] = None
    
    def to_dict(self) -> dict:
        return {
            "gene": self.gene_name,
            "category": self.category,
            "value": self.value,
            "expression_level": int(self.expression_level),
            "expression_name": self.expression_level.name.lower(),
            "table": self.table,
            "column": self.column,
            "column_type": self.column_type,
            "migration": self.migration,
            "description": self.description,
            "user_need": self.user_need,
            "embedding_id": self.embedding_id,
            "semantic_cluster": self.semantic_cluster,
        }


# The DNA-to-Schema mapping for all 85 genome genes
# This is the core of the semantic memory cloud
DNA_SCHEMA_MAP: dict[str, GeneSchemaMapping] = {}


def _map(gene, category, value, table, column=None, col_type=None, 
         migration=None, level=ExpressionLevel.ACTIVE, desc="", need=""):
    """Helper to register a gene mapping."""
    DNA_SCHEMA_MAP[gene] = GeneSchemaMapping(
        gene_name=gene, category=category, value=value,
        expression_level=level,
        table=table, column=column, column_type=col_type,
        migration=migration,
        description=desc, user_need=need,
    )


# === TRIPWIRE GENES (9) → tripwire_events table ===
tw_genes = [
    ("tw_01_empty_generation", 3, "empty_generation_streak", "INTEGER", "010", "Max consecutive empty generations before pause"),
    ("tw_02_infinite_loop", 4, "infinite_loop_detection", "INTEGER", "010", "Max loop iterations before abort"),
    ("tw_03_credit_burn", 39, "credit_burn_warning", "INTEGER", "010", "Credits burned without delivery before warning"),
    ("tw_04_approval_bypass", 2, "approval_bypass_attempts", "INTEGER", "010", "Max approval bypass attempts before block"),
    ("tw_06_token_overflow", 89435, "token_overflow_limit", "INTEGER", "010", "Max tokens per interaction"),
    ("tw_07_duplicate_gen", 4, "duplicate_generation_limit", "INTEGER", "010", "Max duplicate generations before flag"),
    ("tw_08_timeout", 91, "timeout_seconds", "INTEGER", "010", "Pipeline timeout in seconds"),
    ("tw_09_unauthorized", 2, "unauthorized_attempt_limit", "INTEGER", "010", "Max unauthorized attempts before block"),
]
for gene, val, col, col_type, mig, desc in tw_genes:
    _map(gene, "tripwire", val, "tripwire_events", col, col_type, mig,
         ExpressionLevel.CRITICAL, desc, "Protect users from value destruction")

_map("burn_rate_per_min", "tripwire", 27, "tripwire_events", "burn_rate_per_min", "INTEGER", "010",
     ExpressionLevel.CRITICAL, "Max credits/min before burn rate alert", "Prevent credit waste")


# === VDR GENES (6) → simulation_runs / pipeline_runs ===
_map("early_exit_threshold", "vdr", 16, "pipeline_runs", "status", "TEXT", "001",
     ExpressionLevel.CRITICAL, "Turn threshold for early exit if no value delivered", "Don't waste credits on dead-end generations")
_map("tripwire_sensitivity", "vdr", 4, "tripwire_events", "severity", "TEXT", "010",
     ExpressionLevel.ACTIVE, "How many tripwire hits before escalation", "Catch problems early")
_map("deployment_gate_score", "vdr", 0.611, "pipeline_runs", "status", "TEXT", "001",
     ExpressionLevel.ACTIVE, "Minimum score to pass deployment gate", "Ensure quality before deploy")
_map("approval_timeout_hours", "vdr", 74, "pipeline_runs", "status", "TEXT", "001",
     ExpressionLevel.ACTIVE, "Hours before approval expires", "Don't block on stale approvals")
_map("research_depth", "vdr", 5, "research_queries", "query", "TEXT", "001",
     ExpressionLevel.ACTIVE, "How deep the research agent digs", "Validate ideas before building")
_map("retry_limit", "vdr", 2, "pipeline_steps", "status", "TEXT", "001",
     ExpressionLevel.ACTIVE, "Max retries per failed step", "Don't waste credits on repeated failures")


# === CREDIT GENES (4) → credit_ledger / users ===
_map("per_user_budget", "credit", 238, "users", "credits_remaining", "INTEGER", "002",
     ExpressionLevel.CRITICAL, "Monthly credit budget per user", "Fair resource allocation")
_map("per_bot_budget", "credit", 67, "credit_ledger", "amount", "INTEGER", "008",
     ExpressionLevel.ACTIVE, "Credit budget per pipeline run", "Prevent single bot from burning all credits")
_map("conversation_turn_limit", "credit", 15, "pipeline_runs", "id", "TEXT", "001",
     ExpressionLevel.ACTIVE, "Max pipeline runs per time window", "Rate limiting to prevent abuse")
_map("agent_timeout_seconds", "credit", 142, "pipeline_runs", "status", "TEXT", "001",
     ExpressionLevel.ACTIVE, "Max seconds per pipeline run", "Don't waste compute on stuck pipelines")


# === AGENT GENES (3) → pipeline_steps ===
_map("agent_parallel", "agent", 1, "pipeline_steps", "status", "TEXT", "001",
     ExpressionLevel.ACTIVE, "Parallel vs sequential pipeline execution", "Speed up delivery")
_map("agent_research_sources", "agent", 3, "research_queries", "query", "TEXT", "001",
     ExpressionLevel.ACTIVE, "Number of research sources to consult", "Thorough validation")
_map("agent_count", "agent", 4, "pipeline_steps", "agent_type", "TEXT", "001",
     ExpressionLevel.CRITICAL, "Number of agents in the pipeline", "Division of labor")


# === MODEL GENES (5) → (configuration, not tables) ===
_map("primary_model", "model", 3, "pipeline_steps", "model", "TEXT", "001",
     ExpressionLevel.CRITICAL, "Primary LLM model selection", "Quality of output")
_map("research_model", "model", 1, "research_queries", "model", "TEXT", "001",
     ExpressionLevel.ACTIVE, "Model for research agent", "Research quality")
_map("coding_model", "model", 0, "pipeline_steps", "model", "TEXT", "001",
     ExpressionLevel.ACTIVE, "Model for code generation", "Code quality")
_map("model_temperature", "model", 0.676, "pipeline_steps", "metadata", "TEXT", "001",
     ExpressionLevel.ACTIVE, "LLM temperature setting", "Creativity vs determinism")
_map("context_window_utilization", "model", 0.356, "pipeline_steps", "metadata", "TEXT", "001",
     ExpressionLevel.LATENT, "How much context window to use", "Efficiency")


# === DISCOVERY GENES (4) → lattice_nodes / lattice_edges ===
_map("rerank_depth", "discovery", 78, "lattice_nodes", "metadata", "TEXT", "003",
     ExpressionLevel.CRITICAL, "Cohere rerank depth for search results", "Find relevant patterns")
_map("embedding_dimensions", "discovery", 1536, "lattice_nodes", "embedding_id", "TEXT", "003",
     ExpressionLevel.ACTIVE, "Cohere embedding dimensions", "Semantic search quality")
_map("lattice_search_radius", "discovery", 3, "lattice_edges", "weight", "REAL", "001",
     ExpressionLevel.ACTIVE, "Search radius in the lattice graph", "Pattern discovery breadth")
_map("feedback_loop_depth", "discovery", 4, "lattice_executions", "result", "TEXT", "012",
     ExpressionLevel.ACTIVE, "How many feedback loops in discovery", "Learning depth")


# === TOPOLOGY GENES (6) → pipeline_runs ===
_map("pipeline_mode", "topology", 1, "pipeline_runs", "status", "TEXT", "001",
     ExpressionLevel.CRITICAL, "Parallel vs sequential pipeline", "Speed vs reliability")
_map("discovery_impl_overlap", "topology", 0.3, "pipeline_steps", "metadata", "TEXT", "001",
     ExpressionLevel.LATENT, "Overlap between discovery and implementation", "Efficiency")
_map("agent_count", "topology", 4, "pipeline_steps", "agent_type", "TEXT", "001",
     ExpressionLevel.CRITICAL, "Number of agents", "Division of labor")
_map("feedback_loop_enabled", "topology", 1, "pipeline_steps", "status", "TEXT", "001",
     ExpressionLevel.ACTIVE, "Whether feedback loops are enabled", "Quality iteration")
_map("error_isolation", "topology", 1, "pipeline_steps", "status", "TEXT", "001",
     ExpressionLevel.ACTIVE, "Isolate errors to single agents", "Resilience")
_map("state_persistence", "topology", 2, "pipeline_runs", "status", "TEXT", "001",
     ExpressionLevel.ACTIVE, "How pipeline state persists across steps", "Recovery")


# === UI/UX GENES (8) → (frontend config, not database) ===
_map("ui_interaction_mode", "uiux", 3, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.ACTIVE, "UI interaction paradigm (desktop/mobile/voice/multi-modal)", "Accessibility")
_map("input_bandwidth", "uiux", 3, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.LATENT, "How much input the UI accepts (text/voice/upload)", "Usability")
_map("response_format", "uiux", 3, "generations", "metadata", "TEXT", "001",
     ExpressionLevel.ACTIVE, "How responses are formatted (text/cards/streaming)", "Clarity")
_map("approval_flow", "uiux", 3, "pipeline_runs", "status", "TEXT", "001",
     ExpressionLevel.ACTIVE, "How approval works (auto/manual/gated)", "Control")
_map("error_recovery", "uiux", 3, "pipeline_runs", "error_message", "TEXT", "001",
     ExpressionLevel.ACTIVE, "How errors are recovered (retry/handoff/rollback)", "Resilience")
_map("onboarding_depth", "uiux", 3, "users", "tier", "TEXT", "002",
     ExpressionLevel.ACTIVE, "How much onboarding guidance", "User success")
_map("accessibility_level", "uiux", 2, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.CRITICAL, "WCAG accessibility level (AA/AAA)", "Inclusivity")
_map("min_usability_score", "uiux", 0.5, "generations", "metadata", "TEXT", "001",
     ExpressionLevel.ACTIVE, "Minimum usability score for deployment", "Quality gate")


# === COLLAB GENES (8) → (future collab tables) ===
_map("coworking_enabled", "collab", 1, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.LATENT, "Real-time collaboration", "Team productivity")
_map("crdt_type", "collab", 1, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.LATENT, "Conflict-free data type (automerge/yjs)", "Concurrent editing")
_map("presence_indicators", "collab", 1, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.LATENT, "Show who's online", "Team awareness")
_map("typing_indicators", "collab", 1, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.LATENT, "Show typing status", "Communication clarity")
_map("team_session_max", "collab", 40, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.LATENT, "Max team members in a session", "Scalability")
_map("collab_persistence", "collab", 2, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.LATENT, "How collab state persists (D1/postgres)", "Data durability")
_map("real_time_sync", "collab", 1, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.LATENT, "Real-time state synchronization", "Team coordination")
_map("offline_support", "collab", 0, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.DORMANT, "Offline editing support", "Resilience")


# === CHAT GENES (5) → (FluxyChat, not D1) ===
_map("chat_enabled", "chat", 1, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.ACTIVE, "Whether chat is enabled", "User communication")
_map("chat_transport", "chat", 1, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.ACTIVE, "Chat transport (websocket/sse/poll)", "Real-time updates")
_map("message_persistence", "chat", 2, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.ACTIVE, "How messages persist (memory/d1)", "Conversation history")
_map("chat_context_window", "chat", 3, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.LATENT, "Context window for chat", "Conversation coherence")
_map("chat_threading", "chat", 1, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.LATENT, "Threaded conversations", "Organization")


# === ENTERPRISE GENES (6) → user_roles / audit_log ===
_map("sso_provider", "enterprise", 1, "user_roles", "role", "TEXT", "019",
     ExpressionLevel.LATENT, "SSO provider (SAML/OIDC)", "Enterprise security")
_map("rbac_enabled", "enterprise", 1, "user_roles", "role", "TEXT", "019",
     ExpressionLevel.LATENT, "Role-based access control", "Enterprise security")
_map("audit_log_retention_days", "enterprise", 6, "admin_audit_log", "created_date", "TEXT", "019",
     ExpressionLevel.ACTIVE, "Audit log retention period", "Compliance")
_map("multi_tenant_isolation", "enterprise", 1, "users", "id", "TEXT", "002",
     ExpressionLevel.CRITICAL, "Tenant data isolation", "Data security")
_map("data_residency", "enterprise", 1, "users", "metadata", "TEXT", "002",
     ExpressionLevel.LATENT, "Data residency controls", "GDPR compliance")
_map("compliance_framework", "enterprise", 1, "admin_audit_log", "event_type", "TEXT", "019",
     ExpressionLevel.LATENT, "Compliance framework (SOC2/HIPAA/GDPR)", "Enterprise trust")


# === PROACTIVE GENES (6) → health_scores / decisions ===
_map("health_score_enabled", "proactive", 1, "health_scores", "score", "REAL", "009",
     ExpressionLevel.CRITICAL, "Whether health scoring is enabled", "Proactive monitoring")
_map("churn_prediction_model", "proactive", 1, "decisions", "decision_type", "TEXT", "011",
     ExpressionLevel.ACTIVE, "Churn prediction model type", "Prevent user loss")
_map("usage_anomaly_detection", "proactive", 3, "decisions", "decision_type", "TEXT", "011",
     ExpressionLevel.ACTIVE, "Anomaly detection sensitivity", "Catch issues early")
_map("sentiment_analysis_source", "proactive", 1, "health_scores", "sentiment", "REAL", "009",
     ExpressionLevel.ACTIVE, "Sentiment analysis source (chat/survey/behavioral)", "Understand user mood")
_map("early_warning_threshold", "proactive", 0.3, "health_scores", "score", "REAL", "009",
     ExpressionLevel.CRITICAL, "Threshold for early warning", "Catch problems before user notices")
_map("auto_intervention", "proactive", 3, "decisions", "action", "TEXT", "011",
     ExpressionLevel.ACTIVE, "Automatic intervention level", "Self-healing")


# === TEAM GENES (5) ===
_map("team_hierarchy", "team", 1, "user_roles", "role", "TEXT", "019",
     ExpressionLevel.LATENT, "Team hierarchy model", "Team structure")
_map("role_set", "team", 1, "user_roles", "role", "TEXT", "019",
     ExpressionLevel.LATENT, "Available roles", "Team permissions")
_map("project_templates", "team", 1, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.LATENT, "Project templates for teams", "Fast onboarding")
_map("team_billing_model", "team", 4, "subscriptions", "plan", "TEXT", "005",
     ExpressionLevel.ACTIVE, "Team billing model", "Fair pricing")
_map("team_permissions", "team", 1, "user_roles", "role", "TEXT", "019",
     ExpressionLevel.LATENT, "Team permission model", "Access control")


# === BILLING GENES (4) ===
_map("billing_model", "billing", 2, "subscriptions", "plan", "TEXT", "005",
     ExpressionLevel.CRITICAL, "Billing model (credits/subscription/hybrid)", "Fair pricing")
_map("nonprofit_discount", "billing", 94, "subscriptions", "discount", "REAL", "005",
     ExpressionLevel.ACTIVE, "Nonprofit discount percentage", "Social responsibility")
_map("credit_refund_policy", "billing", 3, "credit_ledger", "type", "TEXT", "008",
     ExpressionLevel.ACTIVE, "Credit refund policy", "Fair value exchange")
_map("value_guarantee", "billing", 1, "credit_ledger", "type", "TEXT", "008",
     ExpressionLevel.CRITICAL, "Value guarantee level", "Trust")


# === SAFETY GENES (4) — FROZEN ===
_map("max_credit_burn_per_session", "safety", 50, "users", "credits_remaining", "INTEGER", "002",
     ExpressionLevel.CRITICAL, "Max credits burnable per session", "Financial safety")
_map("min_usability_score", "safety", 0.5, "generations", "metadata", "TEXT", "001",
     ExpressionLevel.CRITICAL, "Minimum usability score", "Quality floor")
_map("max_response_time_ms", "safety", 5000, "pipeline_runs", "status", "TEXT", "001",
     ExpressionLevel.CRITICAL, "Max acceptable response time", "User experience floor")
_map("data_sovereignty", "safety", 1, "users", "id", "TEXT", "002",
     ExpressionLevel.CRITICAL, "Data sovereignty level", "Privacy")


# === UI GENES (2) ===
_map("responsive_breakpoint_px", "ui", 500, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.ACTIVE, "CSS responsive breakpoint", "Mobile accessibility")
_map("content_density", "ui", 0.316, "projects", "metadata", "TEXT", "001",
     ExpressionLevel.ACTIVE, "UI content density", "Information clarity")


def get_dna_schema_map() -> dict[str, GeneSchemaMapping]:
    """Get the full DNA-to-schema mapping."""
    return DNA_SCHEMA_MAP


def get_genes_by_table(table: str) -> list[GeneSchemaMapping]:
    """Get all genes mapped to a specific table."""
    return [g for g in DNA_SCHEMA_MAP.values() if g.table == table]


def get_genes_by_expression(level: ExpressionLevel) -> list[GeneSchemaMapping]:
    """Get all genes at a specific expression level."""
    return [g for g in DNA_SCHEMA_MAP.values() if g.expression_level == level]


def get_semantic_clusters() -> dict[str, list[str]]:
    """Get genes grouped by semantic cluster (category + expression level)."""
    clusters = {}
    for gene_name, mapping in DNA_SCHEMA_MAP.items():
        cluster = f"{mapping.category}:{mapping.expression_level.name.lower()}"
        clusters.setdefault(cluster, []).append(gene_name)
    return clusters


def export_semantic_memory_cloud(output_path: str = "simulation/glassbox/semantic_memory_cloud.json"):
    """Export the full DNA-to-schema mapping as a coherent, visual JSON.
    
    This is the semantic memory cloud — a visual layer showing how
    architectural DNA maps to database schemas and user needs.
    """
    # Group genes by semantic cluster
    clusters = get_semantic_clusters()
    
    # Group genes by table
    tables = {}
    for mapping in DNA_SCHEMA_MAP.values():
        tables.setdefault(mapping.table, []).append(mapping.to_dict())
    
    # Group genes by expression level
    expression_levels = {}
    for level in ExpressionLevel:
        genes = get_genes_by_expression(level)
        expression_levels[level.name.lower()] = {
            "count": len(genes),
            "genes": [g.gene_name for g in genes],
        }
    
    cloud = {
        "title": "Semantic Memory Cloud — DNA to Schema Mapping",
        "description": "How architectural genome (DNA) maps to database schemas. Each gene = a schema field. Mutations = migrations. Expression level = activation.",
        "stats": {
            "total_genes": len(DNA_SCHEMA_MAP),
            "tables_covered": len(tables),
            "semantic_clusters": len(clusters),
            "expression_levels": {k: v["count"] for k, v in expression_levels.items()},
        },
        "semantic_clusters": clusters,
        "tables": {t: {"gene_count": len(gs), "genes": gs} for t, gs in tables.items()},
        "expression_levels": expression_levels,
        "genes": {name: m.to_dict() for name, m in DNA_SCHEMA_MAP.items()},
    }
    
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(cloud, f, indent=2)
    
    print(f"Semantic Memory Cloud exported: {output_path}")
    print(f"  Genes mapped: {len(DNA_SCHEMA_MAP)}")
    print(f"  Tables covered: {len(tables)}")
    print(f"  Semantic clusters: {len(clusters)}")
    level_strs = [f'{k}={v["count"]}' for k, v in expression_levels.items()]
    print(f"  Expression levels: {', '.join(level_strs)}")
    
    return cloud


if __name__ == "__main__":
    cloud = export_semantic_memory_cloud()
    
    print("\n=== DNA-to-Schema Mapping Summary ===")
    print(f"\nExpression levels:")
    for level in ExpressionLevel:
        genes = get_genes_by_expression(level)
        print(f"  {level.name}: {len(genes)} genes")
    
    print(f"\nTop tables by gene count:")
    table_counts = {}
    for m in DNA_SCHEMA_MAP.values():
        table_counts[m.table] = table_counts.get(m.table, 0) + 1
    for table, count in sorted(table_counts.items(), key=lambda x: -x[1])[:10]:
        print(f"  {table}: {count} genes")
