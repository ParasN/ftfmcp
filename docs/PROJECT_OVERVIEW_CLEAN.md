# Ask FTF — Product Overview

A full‑stack, agentic analytics application that turns natural language into data‑backed, visual, and actionable outputs. It blends market data (BigQuery) with runway/forecast insights (WGSN), and can generate exportable artifacts like moodboard PDFs and Ajio‑ready hashtag collections.


## 1) Executive Summary
- Conversational analytics across trends, lifecycle timing, sales performance, and attributes.
- Dual‑source intelligence aligns BigQuery signals with WGSN excerpts, highlighting confidence and divergence.
- Artifact generation includes brand‑aware moodboard PDFs and campaign‑ready hashtag bundles.
- Responses follow consistent templates with clear data provenance.


## 2) Architecture & Orchestration
- Frontend with WebSocket streaming for partial results and tool transparency.
- Backend API managing chat, conversations, health, and asset serving.
- Agent orchestrator using function‑calling to route, query, and synthesize results.
- Tool server layer that exposes table/schema/SQL/forecast tools; keeps credentials isolated.
- WGSN store and search to retrieve ranked excerpts from ingested reports.
- Generated moodboard PDFs served via a static route for direct download.

High‑level flow:
1. User sends a message; WebSocket streams partial results back.
2. Agent classifies intent, selects a response schema, and recommends tables.
3. Agent calls tools (list tables, fetch schema, run SQL, forecast) and retrieves WGSN evidence.
4. Output is validated against required sections; auto‑corrections run if anything is missing.
5. Attachments (e.g., PDFs, WGSN snippets) are returned and persisted with the conversation.


## 3) Components
- Frontend: streaming UI, multi‑conversation management, moodboard previews, and download links.
- Backend: REST endpoints for conversations, chat, history, health; serves moodboard files.
- Agent: tool loop, aggregation, rate‑limit backoff, output validation, and moodboard pipeline.
- Tool server: table discovery, schema access, SQL execution, and forecasting via BigQuery ML.
- WGSN services: report store, relevance scoring, snippet PDF extraction.
- Response schema engine: loads templates and validates final Markdown.


## 4) Smart Query Routing
- Config‑first mapping classifies queries into a query type.
- Keyword scoring drives a confidence score and a prioritized table set.
- Safe fallback tables are used when intent is ambiguous.
- The agent injects a routing hint and a matching response template to steer SQL and the narrative.

What you get
- Intent‑aligned recommended tables and reasoning so SQL starts in the right place.
- Safe defaults when ambiguous, plus guidance on how to refine the question.

Examples
- “Top midi dress trends this month” → trend discovery, trend metrics + trend entities + media.
- “Stage and momentum for cargo skirts” → lifecycle, lifecycle and momentum tables.
- “Best‑selling necklines under ₹1999” → performance + attribute tables.

Iterative querying and no‑result handling
- If zero rows are returned, the agent suggests relaxing specific filters, trying synonyms/format variants, or switching to alternate tables by priority.
- WHERE clause parsing and string literal extraction power precise hints (e.g., hyphen vs. space, pluralization).


## 5) Response Template Enforcement
- Templates are defined per query type and injected as guidance.
- Final Markdown is validated for required sections; missing parts trigger a brief corrective pass.
- Ensures consistent sections: alignment tables, hashtag collections, action matrices, and provenance.
- Emphasizes dual‑source responses (BigQuery + WGSN) with confidence and divergence notes where applicable.

Supported query types and outputs
- Trend discovery/exploration: Market vs. forecast alignment, visuals, confidence, action matrix.
- Lifecycle & timing: Current stage, journey timeline, stage breakdown, BUY/WAIT/AVOID.
- Performance & sales: Fast/slow movers, sell‑through and discount exposure, summary stats, actions.
- Attribute deep dive: Distribution of print/pattern/color/sleeve/neck/fit with visuals.
- Hashtag collections: 3–5 tags with focus, product lens, attribute mix, market/forecast signal, and visual links.
- Moodboard summary: RA snapshot, brand DNA anchors, trend alignment matrix, palette + hashtag hooks, PDF link.


## 6) BigQuery Integration via Tool Server
- Decoupled tool layer: the agent calls stable HTTP tools rather than handling credentials directly.
- Tools available: list tables, get table schema, run SQL, and run forecasts.
- Forecasts use BigQuery ML (ARIMA_PLUS) with temporary models; results are returned and the model is dropped.


## 7) Dual‑Source Intelligence (WGSN + Market)
- For trends/attributes/lifecycle, WGSN search runs alongside SQL.
- Relevant PDF chunks are ranked by token overlap, recency, and coverage.
- Page‑range snippet PDFs and summary bullets are attached; responses cite report titles and page ranges.
- Templates require WGSN + BigQuery views, and highlight alignment vs. divergence with confidence callouts.

User‑visible behavior
- Citations list report title and page ranges; if nothing is relevant, the response states it explicitly.
- Visuals pair market top sellers with runway references when available.
- Confidence callouts indicate degree of agreement between sources.


## 8) Moodboard Generation (RA → PDF)
- Trigger: message contains `MOODBOARD_RA` with RA JSON (or uses configured mock input if not supplied).
- Pipeline:
  1) Build base payload with RA + Brand DNA and approach weights.
  2) Inject context; parse the returned Trend Alignment Matrix.
  3) Score trends (cohort/attribute overlaps) and compute brand alignment.
  4) Fetch unique JPEGs; layout a two‑page PDF with text + images.
  5) Persist file and expose a download link.
- Frontend shows tiles/palette and exposes the download link; the PDF is attached to the conversation.

Feature notes
- Heuristic scoring blends approach weights + brand DNA overlaps (palette, lifecycle filters, cohort) to prioritize trends.
- Image pipeline enforces JPEG type, size limits, and a max tile count; captions include “name • lifecycle • momentum”.


## 9) Hashtag Generation (Ajio Collections)
- Intent routes to hashtag collections; similar trends are bundled to avoid redundancy.
- Builds 3–5 unique, campaign‑ready hashtags with rationale, product lens, attribute mix, data signals, and visuals.
- Enforces provenance and Ajio‑ready formatting.

Quality bar and examples
- Names are unique, readable, and non‑overlapping across a bundle; each includes a concise rationale and product lens.
- Example asks: “Hashtag ideas for SS denim campaign”, “Trend landing page tags for streetwear”.


## 10) Forecasting & Time‑Series
- The agent runs a forecast when prediction intent is detected.
- Temporary ARIMA_PLUS models generate forecasts with confidence intervals; models are discarded afterwards.
- Results are woven into the narrative/tables with clear provenance for the input series and time window.

Examples
- “Forecast trend score for oversized shirts next 30 days.”
- “Project sell‑through trajectory for women’s denim over 45 days.”


## 11) Conversations, Streaming, and Resilience
- Conversations: per‑thread message and model‑history persistence with create/rename/delete/reset.
- Streaming: chunked text, function calls, and final payloads; the UI aggregates reasoning and chunks.
- Rate limits: automatic detection and backoff with a visible countdown; retry resumes the stream.
- Attachments: moodboard PDFs and WGSN snippet PDFs are surfaced directly in the chat.

User experience and guarantees
- Final outputs are validated against the selected template; missing sections trigger an automatic corrective pass.
- Every answer ends with a Data Provenance section listing exact tables and WGSN sources.
- The UI shows function calls and partial text in real time, plus a visible retry timer on rate limits.


## 12) Configuration
- Environment variables for project ID, model key, ports, and optional paths.
- Routing configuration defines query types, keywords, recommended tables, and fallbacks.
- Response schemas define template lines, required sections, and global guidelines.
- WGSN store path is configurable; reports can be re‑ingested and updated.


## 13) Running Locally
- Prerequisites: Node 18+, Google Cloud SDK, BigQuery access, and a Gemini API key.
- Setup: create a .env file, install dependencies, and start dev servers for backend, frontend, and tool server.
- WGSN ingest (optional but recommended): run the ingest script with a local PDF, tags, and title to unlock dual‑source answers.

Common troubleshooting
- Initialization errors usually indicate missing environment variables.
- If rate limits occur, the UI shows a countdown; the agent automatically retries after backoff.
- If a moodboard PDF lacks images, verify image URLs are JPEG and within size limits.
- For empty query results, follow the in‑response guidance to relax filters and try alternate tables.


## 14) Data Provenance & Governance
- Every answer includes a “Data Provenance” section with tables and WGSN reports.
- Table access is curated by configuration to keep routing explainable and safe.
- Clear separation of duties: the agent never holds cloud credentials; the tool layer performs gated operations.


## 15) Roadmap
- Data: expand mappings, unify taxonomy joins, and enrich cohort analytics.
- Quality: golden outputs per query type; SQL/result checks; better no‑result iteration hints.
- Performance: cache schema/table discovery; memoize WGSN results.
- Reliability: observability for tool calls, retries, and latency; alerting.
- Product: report packs, richer charting, inline galleries; streamlined hashtag workflows.
- Security: role‑based tooling, table allowlists, enhanced provenance.

