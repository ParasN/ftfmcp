# Ask FTF — Project Overview

A full‑stack, agentic analytics application that turns natural language into data‑backed, visual, and actionable outputs. It blends market data (BigQuery) with runway/forecast insights (WGSN), and can generate exportable artifacts like moodboard PDFs and Ajio‑ready hashtag collections.


## 1) Executive Summary
- Conversational analytics across trends, lifecycle timing, sales performance, and attributes.
- Dual‑source intelligence: aligns BigQuery signals with WGSN excerpts, highlighting confidence and divergence.
- Artifact generation: brand‑aware moodboard PDFs and campaign‑ready hashtag bundles.
- Consistent, exec‑ready narratives via response templates; clear data provenance in every answer.


## 2) Architecture & Orchestration
- Frontend: React app with WebSocket streaming UI (`frontend/src/App.jsx`).
- Backend API: Express server (`backend/src/index.js`) managing chat, conversations, file serving.
- Agent: Gemini function‑calling orchestrator (`backend/src/agent.js`) that routes and executes tools.
- MCP Tool Server: BigQuery + ML utilities behind stable HTTP tools (`mcp-server/src/index.js`).
- WGSN Store & Search: Local JSON store and retrieval over ingested PDFs (`backend/src/wgsn/*`).
- Static Assets: Generated moodboard PDFs served from `backend/generated/moodboards` via `/api/moodboards/...`.

High‑level flow:
1. User sends a message from the frontend; WebSocket streams partial results back.
2. Agent classifies intent and selects a response schema and table recommendations.
3. Agent calls tools via MCP (list tables, schemas, SQL, forecast) and queries WGSN evidence.
4. Agent validates the final Markdown against the required sections; auto‑corrects if needed.
5. Attachments (e.g., PDFs, WGSN snippets) are returned and persisted with the conversation.


## 3) Components
- Frontend (`frontend/src/App.jsx`)
  - WebSocket streaming for partial model text, tool calls, and rate‑limit countdowns.
  - Multi‑conversation UI with persistence, moodboard previews, and PDF download links.
- Backend (`backend/src/index.js`)
  - REST APIs: conversations, chat, history, health; serves moodboard files.
  - Initializes credentials via `.env` (Gemini key, GCP project), ensures directories.
- Agent (`backend/src/agent.js`)
  - Gemini model: `gemini-2.5-flash` with function declarations.
  - Tool loop, aggregation, retry/backoff on 429, output validation, and moodboard pipeline.
- MCP server (`mcp-server/src/index.js`)
  - Tools: `list_tables`, `get_table_schema`, `run_query`, `run_forecast`.
  - BigQuery ML (ARIMA_PLUS) for forecasting; temp models are created/dropped per request.
- WGSN services (`backend/src/wgsn/*`)
  - `wgsnStore.js`: JSON store management for ingested reports.
  - `wgsnSearch.js`: tokenization + scoring (coverage, recency, density) to rank chunks.
  - `wgsnSnippetService.js`: builds page‑range snippet PDFs and evidence packages.
- Response schema utilities (`backend/src/responseSchema.js`)
  - Loads schemas from `backend/config/responseSchemas.json`.
  - Builds format hints and validates required sections in the final Markdown.


## 4) Smart Query Routing
- Config‑first mapping (`backend/config/query_to_table_mapping_for_mcp.json`) classifies queries to `query_type`.
- Keyword scoring → confidence → prioritized table set (e.g., `trend_scores`, `stl_trend`, `edited_options_bestsellers_data`).
- Fallback when confidence is low (e.g., default tables `stl_trend`, `trend_scores`).
- Agent injects a routing hint and the selected response schema to steer SQL and narrative structure.

Key code: `backend/src/queryRouter.js` (tokenization, scoring, fallback), used by `Agent` during chat.

What you get
- Intent‑aligned tables and reasons (visible to the model via a routing hint) so SQL starts in the right place.
- Safe defaults when ambiguous, plus guidance on how to refine the question.

Examples
- “Top midi dress trends this month” → trend discovery, trend_scores + stl_trend + stl_media.
- “Stage and momentum for cargo skirts” → lifecycle, stl_trend + trend_scores.
- “Best‑selling necklines under ₹1999” → performance + attribute tables.

Iterative querying and no‑result handling
- If zero rows are returned, the agent suggests: relaxing individual WHERE filters, trying synonyms/format variants, or switching to alternate tables by priority.
- WHERE clause parsing and string literal extraction power concrete hints (e.g., hyphen vs. space, pluralization).
- Code: `extractWhereConditions`, `extractStringLiterals`, `buildNoResultGuidance` in `backend/src/agent.js`.


## 5) Response Template Enforcement
- Templates are defined per `query_type` in `backend/config/responseSchemas.json`.
- Agent injects a schema hint; on completion, validates required sections and retries with a corrective prompt if missing.
- Ensures consistent sections: alignment tables, hashtag collections, action matrices, and provenance.
- Dual‑source emphasis (when applicable): surface both BigQuery and WGSN, with confidence and divergence notes.

Key code: `backend/src/responseSchema.js` (get schema, build hint, validate), and enforcement loop in `backend/src/agent.js`.

Supported query types and outputs
- Trend discovery/exploration: Market vs. forecast alignment tables, visuals, confidence, action matrix.
- Lifecycle & timing: Current stage, journey timeline, stage breakdown, BUY/WAIT/AVOID with rationale.
- Performance & sales: Fast/slow movers, sell‑through and discount exposure, summary stats, action items.
- Attribute deep dive: Distribution of print/pattern/color/sleeve/neck/fit with taxonomy‑aligned labels and visuals.
- Hashtag collections: 3–5 tags with focus, product lens, attribute mix, BQ/WGSN signal, and visual links.
- Moodboard summary: RA snapshot, brand DNA anchors, trend alignment matrix, palette + hashtag hooks, PDF link.


## 6) BigQuery Integration via MCP
- Decoupled tool layer: agent calls HTTP tools rather than handling credentials directly.
- Tools
  - `list_tables`: from curated config (tables whitelisted for the agent)
  - `get_table_schema`: fetch table schema from BigQuery
  - `run_query`: execute standard SQL
  - `run_forecast`: build a temporary ARIMA_PLUS model and return `ML.FORECAST` results
- Implementation: `mcp-server/src/index.js` using `@google-cloud/bigquery` and BigQuery ML.


## 7) Dual‑Source Intelligence (WGSN + Market)
- When queries cover trends/attributes/lifecycle, agent performs WGSN search alongside SQL.
- Ranks relevant PDF chunks by token overlap, recency boost, and coverage.
- Produces page‑range snippet PDFs and a summary block; injects citations and snippets into the prompt.
- Templates require WGSN+BQ views and highlight alignment vs. divergence with confidence callouts.

Key code: `backend/src/wgsn/wgsnSearch.js`, `backend/src/wgsn/wgsnSnippetService.js`, integrations in `backend/src/agent.js`.

User‑visible behavior
- Citations list report title and page ranges; if nothing relevant exists, the response states it explicitly.
- Visuals pair market top sellers with runway references when available.
- Confidence callouts indicate degree of agreement between sources.


## 8) Moodboard Generation (RA → PDF)
- Trigger: Message contains `MOODBOARD_RA` with RA JSON (or falls back to `backend/config/mock_ra_input.json`).
- Pipeline
  1. Build base payload with RA + Brand DNA and approach weights.
  2. Inject context for the LLM; parse the returned Trend Alignment Matrix.
  3. Score trends (cohort/attribute overlaps), compute brand alignment.
  4. Fetch unique JPEGs; layout a two‑page PDF with text + images.
  5. Persist file to `backend/generated/moodboards`; serve at `/api/moodboards/...`.
- Frontend shows tiles/palette and exposes the download link.

Key code: `backend/src/moodboardGenerator.js`, parsing in `backend/src/agent.js`.

Feature notes
- Heuristic scoring blends approach weights + brand DNA overlaps (palette, lifecycle filters, cohort) to prioritize trends.
- Image pipeline enforces JPEG type, size limits, and a max tile count; captions include “name • lifecycle • momentum”.
- The generated PDF is attached in the chat and served at `/api/moodboards/...`; frontend renders tiles/palette preview.


## 9) Hashtag Generation (Ajio Collections)
- Intent routes to `trend_hashtag_collections`.
- Builds 3–5 unique, campaign‑ready hashtags with rationale, product lens, attribute mix, data signals, and visuals.
- Sources
  - Trends: `nextwave.trend_scores`, `nextwave.stl_trend`
  - Products: `nextwave.edited_options_bestsellers_data`, `nextwave.bestseller_data_attributes`
  - Taxonomy: `nextwave.taxonomy_data`, `nextwave.taxonomy_table_data`
- Visuals: `nextwave.stl_media`, `nextwave.fashion_eye_images`, `nextwave.options_listing_partitioned`
- Enforces provenance and Ajio‑ready formatting.

Quality bar and examples
- Names are unique, readable, and non‑overlapping across a bundle; each includes a concise rationale and product lens.
- Example asks: “Hashtag ideas for SS denim campaign”, “Trend landing page tags for streetwear”.


## 10) Forecasting & Time‑Series
- Agent calls `forecast` when prediction intent is detected.
- MCP builds a temporary ARIMA_PLUS model and returns forecast rows (point + intervals) at 95% confidence.
- Agent weaves results into narrative/tables; provenance lists input table and window.

Examples
- “Forecast trend score for oversized shirts next 30 days.”
- “Project sell‑through trajectory for women’s denim over 45 days.”


## 11) Conversations, Streaming, and Resilience
- Conversations: `backend/src/conversationStore.js` persists messages and model history per conversation; CRUD APIs.
- Streaming: WebSocket sends chunked text, function calls, and final payloads; frontend aggregates reasoning and chunks.
- Rate limits: Agent detects 429s, parses retry hints, and streams countdowns to the UI before retrying.
- Attachments: Moodboard PDFs and WGSN snippet PDFs are attached and rendered in the chat.

User experience and guarantees
- Final outputs are validated against the selected template; missing sections trigger an automatic corrective pass.
- Every answer ends with a Data Provenance section listing exact tables and WGSN sources.
- The UI shows function calls and partial text in real time, plus a visible retry timer on rate limits.


## 12) Configuration
- Env (`.env`)
  - `GCP_PROJECT_ID`, `GEMINI_API_KEY`, `PORT`, `MCP_PORT`, etc.
- Routing config: `backend/config/query_to_table_mapping_for_mcp.json`
  - Query types, keywords, recommended tables, fallbacks.
- Response schemas: `backend/config/responseSchemas.json`
  - Template lines, required sections, guidelines.
- WGSN store: `backend/data/wgsnReports.json` (override via `WGSN_REPORT_STORE`).


## 13) Running Locally
- Prereqs: Node 18+, gcloud SDK, BigQuery access, Gemini API key.
- Setup
  - `cp .env.example .env` and fill values.
  - `npm install` (root installs backend/frontend/mcp server deps).
- Dev
  - `npm run dev` → backend (3001), frontend (5173), MCP (3002).
- WGSN ingest (optional but recommended)
  - `npm run wgsn:ingest --workspace=backend -- --file /absolute/path/to/report.pdf --tags womenswear,denim --title "Denim Macro Trends FY24"`

Common troubleshooting
- Initialization errors usually indicate missing `GCP_PROJECT_ID` or `GEMINI_API_KEY` in `.env`.
- If rate limits occur, the UI shows a countdown; the agent automatically retries after backoff.
- If a moodboard PDF lacks images, verify image URLs are JPEG and within size limits (see `moodboardGenerator`).
- For empty query results, follow the in‑response guidance to relax filters and try alternate tables.


## 14) Data Provenance & Governance
- Every answer includes a “Data Provenance” section with tables and WGSN reports.
- Table access is curated by config to keep routing explainable and safe.
- Clear separation of duties: the agent never holds cloud credentials; MCP performs gated operations.


## 15) Roadmap
- Data: Expand mappings, unify taxonomy joins, richer cohort analytics.
- Quality: Golden outputs per query type; SQL/result checks; better no‑result iteration hints.
- Performance: Schema/table cache; memoized WGSN results.
- Reliability: Observability for tool calls, retries, and latency; alerting.
- Product: Report packs, richer charting, inline galleries; streamlined hashtag workflows.
- Security: Role‑based tooling, table allowlists, enhanced provenance.


---

If you’re exploring the code, start at:
- Backend entry: `backend/src/index.js`
- Agent orchestration: `backend/src/agent.js`
- Tool routing: `backend/src/queryRouter.js`
- Response schemas: `backend/src/responseSchema.js`
- MCP server tools: `mcp-server/src/index.js`
- Frontend UI: `frontend/src/App.jsx`
