# Autonomous Dev Team — Architecture Spec

> Referenced by CLAUDE.md. This is the "CTO-in-a-Box" pipeline that turns a non-technical founder's vision into a deployed app through a 4-step autonomous workflow.

## The Problem

Non-technical founders have brilliant ideas but hit a technical wall: they can describe what they want in a ChatGPT prompt, but can't turn that into a working architecture. Existing tools (Lovable, Bolt, Replit) solve the *code generation* part but skip the *thinking* part — research, validation, design, and planning happen in the founder's head, which is exactly where things fall apart.

## The Solution: 4-Step Autonomous Pipeline

Bicameral acts as a "team of AI developers" that works like a real software team. Each step is a specialized agent with its own context window, tools, and outputs. The pipeline is orchestrated as a durable workflow on Cloudflare.

```
Founder Vision
     ↓
┌─────────────────────────────────────────────────────┐
│  STEP 1: PROMPT COMPANION (Ideation)                 │
│  Agent: Architect (Command A)                       │
│  Input: Natural language description                 │
│  Output: Structured project brief (JSON)             │
│  Tools: Cohere Structured Outputs, template matching │
└──────────────────────┬──────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────┐
│  STEP 2: RESEARCH DISCOVERED (Validation)            │
│  Agent: Researcher (Command R7B + Rerank)           │
│  Input: Project brief                               │
│  Output: Validated tech stack, patterns, risks      │
│  Tools: CERL research loop, web search, Embed v4    │
└──────────────────────┬──────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────┐
│  STEP 3: DESIGN COHERENT (Blueprinting)               │
│  Agent: Designer (Command A)                         │
│  Input: Project brief + research findings            │
│  Output: System blueprint (components, schema, API) │
│  Tools: Cohere Structured Outputs, template registry │
└──────────────────────┬──────────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────────┐
│  STEP 4: ARCHITECTURE IMPLEMENTED (Execution)         │
│  Agent: Coder (North Mini Code → R7B → Command A)    │
│  Input: System blueprint                             │
│  Output: Deployed app + live preview URL             │
│  Tools: 3-tier preview, error feedback loop, deploy  │
└─────────────────────────────────────────────────────┘
```

## How This Maps to Industry Research

### Lovable/Bolt Architecture (Beam.cloud analysis)
The core loop is NOT "LLM writes code." It's: **plan → edit files → run in sandbox → collect errors → iterate until working**. The sandbox, error feedback loop, and file system management are what make these apps work — not the model alone.

Bicameral implements this same loop in Step 4, with the 3-tier preview system providing the sandbox layer.

### Blueprint2Code (Frontiers academic paper)
A 4-agent pipeline that mirrors human programming: **Preview → Blueprint → Coding → Debugging**. Each agent has a specific role and they collaborate through a unified control strategy. Achieved 96.3% pass@1 on HumanEval.

Bicameral's 4 steps map directly: Prompt Companion = Preview, Research = Blueprint planning, Design = Blueprint, Implementation = Coding + Debugging.

### Addy Osmani's Code Agent Orchestra
The shift from **conductor** (one agent, synchronous, context window ceiling) to **orchestrator** (multiple agents, asynchronous, each with own context). Key patterns:
- **Subagents**: Parent decomposes task, spawns specialists for each piece, manages dependency graph
- **Agent Teams**: Shared task list with auto dependency resolution, peer-to-peer messaging, file locking
- **Hierarchical subagents**: Feature leads spawn their own specialists (teams of teams)

Bicameral uses the subagent pattern: the Pipeline Orchestrator (Durable Object) spawns 4 specialized agents sequentially, passing structured outputs between them. For complex projects, Step 4 can spawn parallel subagents (frontend, backend, tests) with file locking.

### Replit Agent 4
Four pillars: Design Freely, Build Together, Ship Anything, Move Faster. Can work autonomously for up to 200 minutes. Uses parallel agents + infinite design canvas.

Bicameral's Step 3 (Design) produces a visual blueprint that the founder can review and tweak before Step 4 starts coding — same "design while agent builds" concept, but with a gated approval step.

## Technical Implementation on Cloudflare

### Orchestration Layer

```typescript
// GenerationOrchestrator Durable Object
// State machine: idle → ideating → researching → designing → implementing → deployed → error

export class GenerationOrchestrator extends DurableObject {
  async runPipeline(prompt: string, userId: string) {
    // Step 1: Ideation
    const brief = await this.runArchitect(prompt);
    this.broadcast('step:complete', { step: 1, brief });
    
    // Step 2: Research
    const research = await this.runResearcher(brief);
    this.broadcast('step:complete', { step: 2, research });
    
    // Step 3: Design
    const blueprint = await this.runDesigner(brief, research);
    this.broadcast('step:complete', { step: 3, blueprint });
    
    // Gate: Founder reviews blueprint before implementation
    await this.waitForApproval('review_blueprint');
    
    // Step 4: Implementation
    const deployment = await this.runCoder(blueprint);
    this.broadcast('step:complete', { step: 4, deployment });
  }
}
```

### Agent Definitions

#### Agent 1: Architect (Prompt Companion)
```typescript
// Model: Command A (needs reasoning for complex prompts)
// Input: "I want an app that helps dog owners find nearby parks"
// Output: Structured project brief

const ARCHITECT_SYSTEM = `You are the Architect agent in a software development team.
Your job is to take a non-technical founder's vision and turn it into a 
structured project brief. You must think like a senior product manager 
and technical architect combined.

Use the generate_project_brief tool to produce your output.`;

const tools = [{
  name: "generate_project_brief",
  description: "Generate a structured project brief from a vision description",
  parameter_definition: {
    type: "object",
    properties: {
      app_name: { type: "string" },
      app_type: { type: "string", enum: ["web", "mobile", "fullstack"] },
      target_users: { type: "string" },
      core_features: { 
        type: "array", 
        items: { type: "string" } 
      },
      data_models: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            fields: { type: "array", items: { type: "string" } }
          }
        }
      },
      tech_preferences: { type: "string" },
      complexity: { type: "string", enum: ["simple", "moderate", "complex"] },
      estimated_components: { type: "number" },
    },
    required: ["app_name", "app_type", "core_features", "data_models"]
  }
}];
```

#### Agent 2: Researcher (Research Discovered)
```typescript
// Model: Command R7B (fast, cheap, good for research)
// Tools: Web search, Embed v4 (lattice), Rerank v4
// Input: Project brief from Agent 1
// Output: Validated tech stack + patterns + risk assessment

const RESEARCHER_SYSTEM = `You are the Research agent in a software development team.
Your job is to validate the project brief by researching:
1. Best tech stack for this type of app
2. Similar existing projects and their architecture
3. Common pitfalls and risks for this domain
4. Recommended libraries and services

Use the submit_research tool to produce your findings.`;
```

#### Agent 3: Designer (Design Coherent)

> **🎨 Design Reference:** The Designer agent should reference the design specs in `design/` when creating the system blueprint:
> - `design/01-ia-screen-inventory.html` — Screen taxonomy (62 total, 24 MVP). Use this to estimate the component count in the blueprint and ensure all required screens are covered.
> - `design/04-component-library.html` — Existing component specifications (buttons, inputs, cards, modals, navigation, tables, code editors, lattice controls, chat widgets, pipeline progress indicators). Reference these patterns when designing the component tree.
> - `design/02-user-flows.html` — User journey maps (onboarding, project creation, pipeline execution, blueprint review, deployment). Validate that the blueprint's routing supports all flows.
> - `design/03-design-system-tokens.html` — Design tokens (Indigo/Violet/Pink spectrum, Inter/Space Grotesk/Fira Code typography, spacing scale, shadows, animation timing). Include these in the blueprint's deploy config.
> - `design/06-hifi-responsive-layouts.html` — Responsive breakpoints and layout grids. Ensure the blueprint accounts for mobile/tablet/desktop layouts.
> These are reference-only (non-destructive). The Designer agent reads them for pattern matching, not modification.

```typescript
// Model: Command A (needs reasoning for system design)
// Input: Project brief + research findings
// Output: Complete system blueprint (JSON)

const DESIGNER_SYSTEM = `You are the Design agent in a software development team.
Your job is to create a complete system blueprint from the project brief 
and research findings. This blueprint will be used by the Code agent to 
generate actual code.

Your blueprint must include:
- Component tree (what files to create)
- Database schema (tables, columns, relationships)
- API routes (endpoints, methods, request/response)
- Authentication strategy
- Environment variables needed
- Deployment configuration

Use the generate_blueprint tool to produce your output.`;

const blueprintTool = {
  name: "generate_blueprint",
  parameter_definition: {
    type: "object",
    properties: {
      components: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            type: { type: "string", enum: ["page", "component", "api", "util", "schema", "config"] },
            description: { type: "string" },
            dependencies: { type: "array", items: { type: "string" } }
          }
        }
      },
      database: {
        type: "object",
        properties: {
          tables: { type: "array", items: { type: "object" } },
          relationships: { type: "array", items: { type: "object" } }
        }
      },
      api_routes: { type: "array", items: { type: "object" } },
      auth_strategy: { type: "string" },
      env_vars: { type: "array", items: { type: "string" } },
      deploy_config: { type: "object" }
    },
    required: ["components", "database", "api_routes"]
  }
};
```

#### Agent 4: Coder (Architecture Implemented)
```typescript
// Model: North Mini Code (free) → R7B ($0.0375/1M) → Command A ($2.50/1M)
// Input: System blueprint from Agent 3
// Output: Deployed app
// Loop: generate code → run in preview → collect errors → fix → repeat

const CODER_SYSTEM = `You are the Code agent in a software development team.
You receive a complete system blueprint and must implement it.

For each component in the blueprint:
1. Write the file
2. Install dependencies if needed
3. Run the preview
4. If errors occur, read them and fix the code
5. Repeat until the preview is clean

Use the provided tools:
- write_file: Create or update a file
- install_package: Install an npm package  
- run_preview: Start the preview server
- read_logs: Get error logs from the preview
- read_file: Read an existing file

Work through components in dependency order: config → schema → utils → api → components → pages.
`;
```

### Error Feedback Loop (The Secret Sauce)

The beam.cloud analysis found that the error feedback loop is what makes AI app builders actually work — not the model quality. The pattern is:

```
Code agent writes files
     ↓
Sandbox runs the app (Tier 1/2/3 preview)
     ↓
Errors collected from sandbox logs
     ↓
Errors fed back to code agent as context
     ↓
Agent fixes the code
     ↓
Repeat until clean or max iterations reached
```

```typescript
async runCoder(blueprint: Blueprint): Promise<Deployment> {
  const MAX_ITERATIONS = 5;
  let iteration = 0;
  let errors: string[] = [];
  
  while (iteration < MAX_ITERATIONS) {
    // Generate or fix code based on blueprint + errors
    const files = await this.callCohere({
      model: this.selectModel(blueprint.complexity),
      messages: [
        { role: 'system', content: CODER_SYSTEM },
        { role: 'user', content: JSON.stringify(blueprint) },
        ...(errors.length > 0 
          ? [{ role: 'system', content: `Previous errors:\n${errors.join('\n')}\n\nFix these and regenerate.` }]
          : [])
      ],
      tools: [writeFileTool, installPackageTool, runPreviewTool, readLogsTool],
    });
    
    // Write files to sandbox
    await this.writeToSandbox(files);
    
    // Run preview
    const previewResult = await this.runPreview();
    
    if (previewResult.success) {
      return { url: previewResult.url, status: 'deployed' };
    }
    
    // Collect errors for next iteration
    errors = previewResult.errors;
    iteration++;
    
    this.broadcast('iteration:complete', { 
      iteration, 
      errors: errors.length 
    });
  }
  
  // Max iterations reached — deploy what we have + show errors
  return { url: previewResult.url, status: 'partial', warnings: errors };
}
```

### Human-in-the-Loop Gates

Non-technical founders need checkpoints where they can review and redirect. The pipeline has 2 gates:

1. **After Step 3 (Design)**: Founder sees the blueprint (component tree, data schema, API routes) and can approve, modify, or restart. This prevents the team from building the wrong thing.

2. **After Step 4 (Implementation)**: Founder sees the live preview and can request changes through natural language (triggers a new coder agent iteration with the feedback).

```typescript
// WebSocket broadcast keeps founder informed in real-time
this.broadcast('step:start', { step: 1, label: 'Prompt Companion' });
// ... agent works ...
this.broadcast('step:progress', { step: 1, progress: 0.5, message: 'Analyzing your vision...' });
// ... agent finishes ...
this.broadcast('step:complete', { step: 1, brief: result });

// Gate: Wait for founder approval before proceeding
if (step === 3) {
  this.broadcast('gate:awaiting_approval', { 
    blueprint, 
    message: 'Review your architecture blueprint. Approve to start building.' 
  });
  const approval = await this.waitForApproval('review_blueprint', 24 * 60 * 60 * 1000); // 24hr timeout
  if (!approval.approved) {
    // Founder requested changes — restart from their feedback
    return this.runPipeline(approval.feedback, userId);
  }
}
```

### Memory Lattice Integration

Each pipeline run enriches the Memory Lattice:
- Step 2 research gets embedded as lattice nodes (technologies, patterns, risks)
- Step 3 blueprint gets embedded (component patterns, schema patterns)
- Step 4 errors and fixes get embedded (debugging patterns, common pitfalls)

Over time, the lattice becomes a knowledge base that makes future generations faster and more accurate. A founder building a "marketplace app" benefits from every previous marketplace app the system has helped build.

```typescript
// After each step, embed findings into the lattice
async enrichLattice(step: number, output: any) {
  const embedding = await this.cohereEmbed(JSON.stringify(output));
  await this.vectorize.insert({
    id: `run_${this.runId}_step_${step}`,
    values: embedding,
    metadata: { step, projectType: output.app_type, timestamp: Date.now() }
  });
}
```

## Competitive Positioning

| Feature | Bicameral | Lovable | Bolt.new | Replit Agent |
|---------|-----------|---------|----------|--------------|
| Research/Validation step | ✅ CERL + Rerank | ❌ | ❌ | ❌ |
| Blueprint approval gate | ✅ | ❌ | ❌ | ❌ |
| Design step (before coding) | ✅ | ❌ | ❌ | ✅ (canvas) |
| Error feedback loop | ✅ | ✅ | ✅ | ✅ |
| Knowledge accumulation | ✅ Lattice | ❌ | ❌ | ❌ |
| Free tier | ✅ North Mini Code | Limited | Limited | $0.50 deposit |
| Cost per generation | ~$0.0015 | Higher | Higher | Higher |
| Infrastructure | Cloudflare (free) | Own infra | Own infra | Own infra |
| Non-technical founder UX | 4-step wizard | Chat | Chat | Chat + canvas |

Bicameral's key differentiator: it's the only platform that does **research and design BEFORE coding**. Competitors jump straight from prompt to code, which is why their output often needs 10+ iterations to get right. Bicameral's 4-step pipeline front-loads the thinking, so the code generation has a validated blueprint to work from.

## Workflow File Structure

```
src/server/
├── pipeline/
│   ├── orchestrator.ts      # GenerationOrchestrator DO
│   ├── agents/
│   │   ├── architect.ts      # Step 1: Prompt Companion
│   │   ├── researcher.ts     # Step 2: Research Discovered
│   │   ├── designer.ts       # Step 3: Design Coherent
│   │   └── coder.ts         # Step 4: Architecture Implemented
│   ├── tools/
│   │   ├── write-file.ts    # Write file to sandbox
│   │   ├── run-preview.ts   # Trigger preview tier
│   │   ├── read-logs.ts     # Collect sandbox errors
│   │   └── web-search.ts   # CERL web search
│   └── gates.ts             # Human approval gates
├── cohere/
│   └── client.ts            # Direct fetch() to Cohere v2
├── do/
│   ├── generation.ts        # GenerationOrchestrator DO
│   ├── lattice.ts           # LatticeManager DO  
│   └── research.ts          # ResearchSession DO
└── routes/
    ├── generate.ts          # POST /api/generate (starts pipeline)
    ├── pipeline.ts          # GET /api/pipeline/:id (status/SSE)
    └── approve.ts           # POST /api/pipeline/:id/approve (gate)
```

## Implementation Priority

This pipeline should be implemented as Phase 5 (Generation Pipeline) in the implementation-phases.md, after:
- Phase 1: Scaffolding ✅
- Phase 2: Auth + Database ✅  
- Phase 3: Cohere Integration ✅
- Phase 4: Frontend Shell ✅
- **Phase 5: Autonomous Dev Team Pipeline** ← THIS
- Phase 6: Memory Lattice
- Phase 7: CERL Research
- Phase 8: Governance + Live Chat
- Phase 9: Deploy + Test
