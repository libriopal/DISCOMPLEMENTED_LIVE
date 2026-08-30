-- Memory Lattice retrieval loop (graph-RAG for the pipeline agents).
-- lattice_nodes previously stored only a short label + embedding — enough
-- to render the lattice visually, not enough for findSimilarPatterns() to
-- give an agent anything substantive to work from. Adds the actual
-- ingested content (truncated the same way ingestAgentOutput() truncates
-- before embedding) so retrieval can inject real prior context, not just
-- a title.
ALTER TABLE lattice_nodes ADD COLUMN content TEXT;
