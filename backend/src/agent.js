import { GoogleGenerativeAI, GoogleGenerativeAIFetchError } from '@google/generative-ai';
import path from 'node:path';
import axios from 'axios';
import { getQueryRoutingSuggestion } from './queryRouter.js';
import { buildResponseFormatHint, validateResponseAgainstTemplate, getResponseSchema } from './responseSchema.js';
import { MoodboardGenerator } from './moodboardGenerator.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MOODBOARD_TRIGGER_KEYWORD = 'MOODBOARD_RA';
const RA_INPUT_PATH = path.resolve(__dirname, '../config/mock_ra_input.json');
const MCP_SERVER_URL = 'http://localhost:3002';
const RATE_LIMIT_DELAY_MS = 60000;

const tools = [
  {
    name: 'get_available_tables',
    description: 'Lists all available tables that can be queried. Use this to discover what data is available.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_schema_for_table',
    description: 'Gets the schema for a specific table. Use this to understand the structure of a table before querying it.',
    parameters: {
      type: 'object',
      properties: {
        dataset: {
          type: 'string',
          description: 'The dataset of the table'
        },
        table: {
          type: 'string',
          description: 'The name of the table'
        }
      },
      required: ['dataset', 'table']
    }
  },
  {
    name: 'run_query',
    description: 'Executes a SQL query against BigQuery and returns the results. Use this to answer questions about the data.',
    parameters: {
      type: 'object',
      properties: {
        sqlQuery: {
          type: 'string',
          description: 'The SQL query to execute'
        }
      },
      required: ['sqlQuery']
    }
  },
  {
    name: 'forecast',
    description: 'Creates a time series forecast using BigQuery ML ARIMA_PLUS model. Use this when asked to predict or forecast future trends based on historical time series data.',
    parameters: {
      type: 'object',
      properties: {
        datasetId: {
          type: 'string',
          description: 'The ID of the dataset containing the table with time series data'
        },
        tableId: {
          type: 'string',
          description: 'The ID of the table with time series data'
        },
        dateColumn: {
          type: 'string',
          description: 'The name of the column containing timestamp/date values'
        },
        valueColumn: {
          type: 'string',
          description: 'The name of the column containing the values to forecast'
        },
        horizonDays: {
          type: 'number',
          description: 'Number of days to forecast into the future (default: 30)'
        }
      },
      required: ['datasetId', 'tableId', 'dateColumn', 'valueColumn']
    }
  }
];

function formatRoutingHint(suggestion) {
  if (!suggestion) {
    return '';
  }

  const confidence = typeof suggestion.confidence === 'number' ? suggestion.confidence : 0;
  const lines = [];

  if (suggestion.queryType) {
    lines.push(`Query type match: ${suggestion.queryType}`);
  } else {
    lines.push('Query type match: none');
  }

  lines.push(`Routing confidence: ${confidence.toFixed(2)}`);

  if (suggestion.tables && suggestion.tables.length > 0) {
    lines.push('Recommended tables (in priority order):');
    for (const table of suggestion.tables) {
      const priorityText = table.priority !== null && table.priority !== undefined ? `priority ${table.priority}` : 'default priority';
      const reasonText = table.reason ? ` - ${table.reason}` : '';
      lines.push(`- ${table.dataset}.${table.table} (${priorityText})${reasonText}`);
    }
  }

  if (suggestion.fallbackApplied) {
    lines.push(`Fallback applied (${suggestion.fallbackBehavior?.action || 'unspecified action'})`);
  }

  return lines.join('\n');
}

function extractWhereConditions(sqlQuery) {
  if (typeof sqlQuery !== 'string') {
    return [];
  }

  const whereMatch = sqlQuery.match(/where\s+([\s\S]+?)(group\s+by|order\s+by|limit|$)/i);
  if (!whereMatch) {
    return [];
  }

  const normalizedClause = whereMatch[1]
    .replace(/\s+/g, ' ')
    .replace(/\s+\)/g, ')')
    .trim();

  return normalizedClause
    .split(/\band\b/gi)
    .map(condition => condition.trim())
    .filter(Boolean);
}

function extractStringLiterals(sqlQuery) {
  if (typeof sqlQuery !== 'string') {
    return [];
  }

  const literals = new Set();
  const regex = /'([^']+)'/g;
  let match;

  while ((match = regex.exec(sqlQuery)) !== null) {
    const candidate = match[1]?.trim();
    if (candidate) {
      literals.add(candidate);
    }
  }

  return Array.from(literals);
}

function buildLiteralVariations(value) {
  const variations = new Set();

  const compact = value.replace(/\s+/g, '');
  if (compact && compact !== value) {
    variations.add(compact);
  }

  const dashed = value.replace(/\s+/g, '-');
  if (dashed && dashed !== value) {
    variations.add(dashed);
  }

  const spaced = value.replace(/[-_]+/g, ' ');
  if (spaced && spaced !== value) {
    variations.add(spaced);
  }

  const snake = value.replace(/\s+/g, '_');
  if (snake && snake !== value) {
    variations.add(snake);
  }

  const plural = value.endsWith('s') ? value.slice(0, -1) : `${value}s`;
  if (plural && plural !== value) {
    variations.add(plural);
  }

  return Array.from(variations);
}

function buildNoResultGuidance(sqlQuery, routingSuggestion) {
  const guidance = {
    message: 'No rows returned. Iterate on the SQL until you surface relevant data.',
    recommendedActions: []
  };

  const conditions = extractWhereConditions(sqlQuery);
  if (conditions.length > 0) {
    guidance.recommendedActions.push(
      'Relax or temporarily remove individual WHERE filters to broaden the result set.'
    );

    guidance.filterHints = conditions.map(condition => `Consider loosening: ${condition}`);
  }

  const literals = extractStringLiterals(sqlQuery);
  if (literals.length > 0) {
    const alternativeValues = literals
      .map(value => ({
        original: value,
        alternates: buildLiteralVariations(value)
      }))
      .filter(entry => entry.alternates.length > 0);

    if (alternativeValues.length > 0) {
      guidance.recommendedActions.push(
        'Try synonyms or formatting variations for attribute filters that use equality or LIKE conditions.'
      );
      guidance.alternativeValues = alternativeValues;
    }
  }

  const alternateTables = (routingSuggestion?.tables || [])
    .map(table => `${table.dataset}.${table.table}${table.reason ? ` (${table.reason})` : ''}`);

  if (alternateTables.length > 0) {
    guidance.recommendedActions.push(
      'Query another recommended table that might contain the attribute or image you need.'
    );
    guidance.alternateTables = alternateTables;
  }

  if (guidance.recommendedActions.length === 0) {
    guidance.message = 'Query returned no results. Consider rephrasing your question or exploring the available tables with `get_available_tables`.';
  }

  return guidance;
}

function cloneHistoryEntries(history) {
  if (!Array.isArray(history)) {
    return [];
  }
  return JSON.parse(JSON.stringify(history));
}

// Agent orchestrates Gemini conversations and MCP tool usage.
export class Agent {
  constructor(apiKey, streamCallback = null) {
    this.conversationHistory = [];
    this.routingHistory = [];
    this.genAI = new GoogleGenerativeAI(apiKey || process.env.GEMINI_API_KEY);
    this.moodboardGenerator = new MoodboardGenerator();
    this.pendingMoodboard = null;
    this.streamCallback = streamCallback;
    // Convenience flag indicating whether streaming is enabled.
    this.isStreaming = !!this.streamCallback;

    const initialPrompt = `You are a BigQuery specialist and a data analyst.
Your goal is to help users answer questions by writing and executing SQL queries against a BigQuery database.

You have a set of tools to discover tables, view their schemas, and run queries.

Key principles:
- Explore before you query: Use 'get_available_tables' and 'get_schema_for_table' to understand the data landscape before writing complex queries.
- Iterate and refine: If a query returns no results, don't give up. Systematically relax filters, try alternative tables, and use the guidance provided to find the data.
- Be proactive: When appropriate, suggest follow-up checks, alternate tables, or additional columns that might help locate relevant data.
- Be precise: Pay close attention to column names, table names, and formatting.
- Provide reasoning: When proposing SQL, briefly explain why you chose that approach and what you'd change if results are empty.

Always strive to return a final answer to the user, even if it takes several steps.`;

    this.model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: { functionDeclarations: tools },
      systemInstruction: initialPrompt,
    });
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  isRateLimitError(error) {
    if (!error) {
      return false;
    }

    if (error instanceof GoogleGenerativeAIFetchError && Number(error.status) === 429) {
      return true;
    }

    const status = Number(error.status ?? error.response?.status);
    if (!Number.isNaN(status) && status === 429) {
      return true;
    }

    const statusText = (error.statusText ?? error.response?.statusText ?? '').toLowerCase();
    if (statusText.includes('too many requests')) {
      return true;
    }

    const message = (error.message || '').toLowerCase();
    return message.includes('429') ||
      message.includes('quota exceeded') ||
      message.includes('rate limit') ||
      message.includes('too many requests');
  }

  parseRetryDelayValue(value) {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 600 ? value : value * 1000;
    }

    if (typeof value === 'string') {
      const match = value.match(/([0-9.]+)/);
      if (match) {
        const seconds = parseFloat(match[1]);
        if (!Number.isNaN(seconds)) {
          return seconds * 1000;
        }
      }
      return null;
    }

    if (typeof value === 'object') {
      if (value.retryDelay) {
        return this.parseRetryDelayValue(value.retryDelay);
      }

      const seconds = value.seconds ?? value.Seconds;
      if (seconds !== undefined) {
        const secondsNum = Number(seconds);
        const nanos = Number(value.nanos ?? value.Nanos ?? 0);
        if (!Number.isNaN(secondsNum)) {
          const msFromSeconds = secondsNum * 1000;
          const msFromNanos = Number.isNaN(nanos) ? 0 : Math.floor(nanos / 1e6);
          return msFromSeconds + msFromNanos;
        }
      }
    }

    return null;
  }

  getRateLimitDelayMs(error) {
    const detailSources = [
      Array.isArray(error?.errorDetails) ? error.errorDetails : null,
      Array.isArray(error?.response?.errorDetails) ? error.response.errorDetails : null,
      Array.isArray(error?.response?.error?.details) ? error.response.error.details : null
    ].filter(Boolean);

    for (const details of detailSources) {
      for (const detail of details) {
        const parsed = this.parseRetryDelayValue(detail?.retryDelay ?? detail);
        if (parsed) {
          return Math.max(parsed, RATE_LIMIT_DELAY_MS);
        }
      }
    }

    const message = typeof error?.message === 'string' ? error.message : '';
    const messageMatch = message.match(/retry(?:\s(?:in|after))?\s([0-9.]+)s/i) ||
      message.match(/retryDelay[^0-9]*([0-9.]+)s/i);

    if (messageMatch) {
      const seconds = parseFloat(messageMatch[1]);
      if (!Number.isNaN(seconds)) {
        return Math.max(seconds * 1000, RATE_LIMIT_DELAY_MS);
      }
    }

    return RATE_LIMIT_DELAY_MS;
  }

  async runWithRateLimitRetry(action, context = 'Gemini request') {
    // Keep retrying indefinitely until quota is available again.
    for (;;) {
      try {
        return await action();
      } catch (error) {
        if (!this.isRateLimitError(error)) {
          throw error;
        }

        const delayMs = this.getRateLimitDelayMs(error);
        const delaySeconds = (delayMs / 1000).toFixed(1);
        console.warn(`[Agent] Gemini rate limit hit during ${context}. Retrying in ${delaySeconds}s.`);

        // Send rate limit notification to frontend
        if (this.streamCallback) {
          this.streamCallback({
            type: 'rate_limit',
            payload: {
              retryIn: parseFloat(delaySeconds),
              message: `Rate limit hit. Retrying in ${delaySeconds}s...`
            }
          });
        }

        await this.delay(delayMs);
      }
    }
  }

  parseJsonBlock(text) {
    if (!text) {
      return null;
    }

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return null;
    }

    const candidate = text.slice(firstBrace, lastBrace + 1);

    try {
      const parsed = JSON.parse(candidate);
      return parsed;
    } catch (error) {
      return null;
    }
  }

  loadRaInput() {
    try {
      const raw = readFileSync(RA_INPUT_PATH, 'utf-8');
      return JSON.parse(raw);
    } catch (error) {
      console.error('Failed to load RA input:', error);
      return null;
    }
  }

  generateAttributeCombinations(raInput) {
    if (!raInput || !raInput.attributes) {
      return [];
    }

    // Support both the new RA input shape and the older shape:
    // - colors may be at raInput.colors (new) or raInput.attributes.colors (old)
    // - patterns may be at raInput.attributes.pattern or raInput.attributes.patterns
    // - materials/fabrics may be at raInput.attributes.fabric or raInput.attributes.materials
    const colors = raInput.colors || raInput.attributes?.colors || [];
    const patterns = raInput.attributes?.pattern || raInput.attributes?.patterns || [];
    const materials = raInput.attributes?.fabric || raInput.attributes?.materials || [];
    const bricks = raInput.bricks || [];
    const combinations = [];

    const maxCombinations = 5;
    const combinationsPerType = Math.ceil(maxCombinations / Math.max(1, patterns.length));

    for (let i = 0; i < patterns.length && combinations.length < maxCombinations; i++) {
      const pattern = patterns[i];

      for (let j = 0; j < combinationsPerType && combinations.length < maxCombinations; j++) {
        // Use Math.max to avoid modulo by zero; selections will be filtered later if empty
        const colorIndex = (i * combinationsPerType + j) % Math.max(1, colors.length);
        const materialIndex = (i * combinationsPerType + j) % Math.max(1, materials.length);

        const selectedColors = colors.length
          ? [colors[colorIndex], colors[(colorIndex + 1) % colors.length]].filter(Boolean)
          : [];

        combinations.push({
          id: `trend-${i + 1}-${j + 1}`,
          colors: selectedColors,
          pattern: pattern,
          material: materials[materialIndex] || null,
          bricks: bricks,
          // priceRange may be provided either at attributes.priceRange or top-level priceRange
          priceRange: raInput.attributes?.priceRange || raInput.priceRange || null
        });
      }
    }

    return combinations.slice(0, maxCombinations);
  }

  buildMoodboardQueryInstructions(raInput, combinations) {
    const lines = [
      '[MOODBOARD_GENERATION_TASK]',
      '',
      `Trigger keyword detected: ${MOODBOARD_TRIGGER_KEYWORD}`,
      '',
      '# Overview',
      'You are generating a moodboard by querying BigQuery tables to find trends and products that match the given attribute combinations.',
      '',
      '# Range Architecture Input',
      `- RA ID: ${raInput.id || 'Unspecified'}`,
      `- Brand: ${raInput.brand || 'Unspecified'}`,
      `- Delivery Month: ${raInput.month || 'Unspecified'}`,
      `- Bricks: ${(raInput.bricks || []).join(', ') || 'None'}`,
      `- Colors: ${(raInput.colors || []).join(', ') || 'None'}`,
      `- Patterns: ${(raInput.attributes?.pattern || []).join(', ') || 'None'}`,
      `- Fabrics: ${(raInput.attributes?.fabric || []).join(', ') || 'None'}`,
      `- Price Range: ${raInput.attributes?.priceRange || 'Unspecified'}`,
      '',
      '# Attribute Combinations (Trends)',
      'The following attribute combinations have been generated from the RA input. Each combination represents a potential trend to explore:',
      ''
    ];

    combinations.forEach((combo, idx) => {
      lines.push(`## Combination ${idx + 1}: ${combo.id}`);
      lines.push(`- Colors: ${combo.colors.join(', ')}`);
      lines.push(`- Pattern: ${combo.pattern}`);
      lines.push(`- Material: ${combo.material}`);
      lines.push(`- Bricks: ${combo.bricks.join(', ')}`);
      lines.push(`- Price Range: ${combo.priceRange || 'Any'}`);
      lines.push('');
    });

    lines.push(
      '# Your Task',
      '',
      '1. **Query BigQuery Tables**: For each attribute combination above, use the BigQuery tools (get_table_schema, run_query) to:',
      '   - Find trends matching the color, pattern, and material attributes',
      '   - Retrieve trend names, lifecycle stages, momentum, scores, and visual URLs',
      '   - Look for products in the specified bricks',
      '   - Filter by the price range if applicable',
      '',
      '2. **Build SQL Queries**: Create SQL queries that:',
      '   - JOIN multiple tables if needed to get complete trend information',
      '   - Filter by the attribute values (colors, patterns, materials)',
      '   - Filter by bricks if applicable',
      '   - Order by trend scores or momentum to get the best matches',
      '   - LIMIT results to top 1-2 trends per combination',
      '',
      '3. **Extract Key Information**: From the query results, extract:',
      '   - Trend Name',
      '   - Lifecycle Stage (Emerging, Growth, Maturity, Decline)',
      '   - Momentum (Rising, Accelerating, Sustaining, Slowing)',
      '   - Trend Score (numeric value)',
      '   - "Why It Fits" narrative (explain how this trend matches the attribute combination and brand DNA)',
      '   - Visual URL (image/media link)',
      '',
      '4. **Generate Moodboard Output**: Return a markdown section with the heading "#### 🔗 Trend Alignment Matrix" followed by a table:',
      '```',
      '#### 🔗 Trend Alignment Matrix',
      '',
      '| Trend Name | Lifecycle | Momentum | Score | Why It Fits | Visual |',
      '|------------|-----------|----------|-------|-------------|--------|',
      '| [name] | [lifecycle] | [momentum] | [score] | [explanation] | [url or description] |',
      '```',
      '',
      '# Important Notes',
      '- Use the recommended tables from the ROUTING_HINT',
      '- Ensure SQL queries are syntactically correct for BigQuery',
      '- If exact attribute matches are not found, look for similar or related attributes',
      '- Reference the specific attribute combination in the "Why It Fits" explanation',
      '- If no visual URL is available in the data, describe what the visual should show',
      '- MUST include the heading "#### 🔗 Trend Alignment Matrix" exactly as shown above',
      '',
      '[/MOODBOARD_GENERATION_TASK]'
    );

    return lines.join('\n');
  }

  parseTrendMatrix(markdownText) {
    const rows = [];
    if (!markdownText) {
      return rows;
    }

    const sectionAnchor = '#### 🔗 Trend Alignment Matrix';
    const anchorIndex = markdownText.indexOf(sectionAnchor);
    if (anchorIndex === -1) {
      return rows;
    }

    const tableStart = markdownText.indexOf('|', anchorIndex);
    if (tableStart === -1) {
      return rows;
    }

    const tableBlock = markdownText.slice(tableStart).split('\n\n')[0];
    const tableLines = tableBlock
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('|'));

    if (tableLines.length <= 2) {
      return rows;
    }

    for (const line of tableLines.slice(2)) {
      const cells = line
        .split('|')
        .map(cell => cell.trim())
        .filter(Boolean);

      if (cells.length < 6) {
        continue;
      }

      const [trendName, lifecycle, momentum, scoreCell, whyItFits, visualCell] = cells;

      const scoreMatch = scoreCell?.match(/-?\d+(\.\d+)?/);
      const score = scoreMatch ? Number(scoreMatch[0]) : null;

      let visualUrl = null;
      const linkMatch = visualCell?.match(/\((https?:[^\s)]+)\)/i);
      if (linkMatch) {
        visualUrl = linkMatch[1];
      } else if (visualCell?.startsWith('http')) {
        visualUrl = visualCell.split(/\s+/)[0];
      }

      rows.push({
        name: trendName || null,
        lifecycle: lifecycle || null,
        momentum: momentum || null,
        score,
        whyItFits: whyItFits || '',
        visualUrl
      });
    }

    return rows;
  }

  aggregateParts(existingParts, newParts) {
    for (const newPart of newParts) {
      if (newPart.functionCall) {
        const existing = existingParts.find(p => p.functionCall && p.functionCall.name === newPart.functionCall.name);
        if (existing) {
          // This is a simplified aggregation. A more robust implementation might be needed
          // depending on how the API streams function call arguments.
          Object.assign(existing.functionCall.args, newPart.functionCall.args);
        } else {
          existingParts.push(newPart);
        }
      } else if (newPart.text) {
        const existingText = existingParts.find(p => p.text);
        if (existingText) {
          existingText.text += newPart.text;
        } else {
          existingParts.push(newPart);
        }
      }
    }
    return existingParts;
  }

  async executeToolCall(toolName, args = {}) {
    switch (toolName) {
      case 'get_available_tables': {
        const response = await axios.get(`${MCP_SERVER_URL}/tables`);
        return response.data;
      }
      case 'get_schema_for_table': {
        const response = await axios.get(`${MCP_SERVER_URL}/tables/${args.dataset}/${args.table}/schema`);
        return response.data;
      }
      case 'run_query': {
        const response = await axios.post(`${MCP_SERVER_URL}/query`, { query: args.sqlQuery });
        return response.data;
      }
      case 'forecast': {
        const response = await axios.post(`${MCP_SERVER_URL}/forecast`, args);
        return response.data;
      }
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  async prepareMoodboardContext(userMessage) {
    const hasTriggerKeyword = typeof userMessage === 'string' &&
      userMessage.toUpperCase().includes(MOODBOARD_TRIGGER_KEYWORD);

    if (!hasTriggerKeyword) {
      return null;
    }

    let raInput = null;

    try {
      const lines = userMessage.split('\n');
      const triggerLineIndex = lines.findIndex(line =>
        line.toUpperCase().includes(MOODBOARD_TRIGGER_KEYWORD)
      );

      if (triggerLineIndex !== -1 && triggerLineIndex < lines.length - 1) {
        const jsonContent = lines.slice(triggerLineIndex + 1).join('\n');
        raInput = JSON.parse(jsonContent);
      }
    } catch (err) {
      console.log('Could not parse RA input from message, falling back to file');
    }

    if (!raInput) {
      raInput = this.loadRaInput();
    }

    if (!raInput) {
      return {
        routingSuggestion: null,
        error: 'Failed to load RA input. Please ensure mock_ra_input.json exists or provide valid JSON in the message.'
      };
    }

    const approach = 'cohort-based';
    const brandDNA = raInput.brand
      ? this.moodboardGenerator.getBrandDNA(raInput.brand)
      : null;

    const payload = this.moodboardGenerator.buildBasePayload(raInput, brandDNA, approach);

    const combinations = this.generateAttributeCombinations(raInput);
    const contextBlock = this.buildMoodboardQueryInstructions(raInput, combinations);

    const routingSuggestion = getQueryRoutingSuggestion('trend analysis lifecycle momentum scores attributes');
    const schemaConfig = getResponseSchema('moodboard_generation');

    return {
      routingSuggestion: {
        ...routingSuggestion,
        queryType: 'moodboard_generation',
        confidence: 1,
        matchedKeywords: ['moodboard', 'trend', 'attributes'],
        responseSchema: schemaConfig
      },
      payload,
      raInput,
      combinations,
      contextBlock
    };
  }

  async chat(userMessage) {
    this.pendingMoodboard = null;

    const moodboardPreparation = await this.prepareMoodboardContext(userMessage);

    let routingSuggestion;
    let augmentedMessage = userMessage;

    if (moodboardPreparation) {
      routingSuggestion = moodboardPreparation.routingSuggestion;
      augmentedMessage = `${userMessage}\n\n${moodboardPreparation.contextBlock}`;
      // If the moodboard preparation produced a payload, include it in the message
      if (moodboardPreparation.payload) {
        try {
          const payloadStr = JSON.stringify(moodboardPreparation.payload, null, 2);
          augmentedMessage = `${augmentedMessage}\n\n[MOODBOARD_PAYLOAD]\n${payloadStr}\n[/MOODBOARD_PAYLOAD]`;
        } catch (err) {
          // If payload can't be stringified, include a fallback note
          augmentedMessage = `${augmentedMessage}\n\n[MOODBOARD_PAYLOAD]\n<unserializable payload>\n[/MOODBOARD_PAYLOAD]`;
        }
      }
      this.pendingMoodboard = moodboardPreparation;
    } else {
      routingSuggestion = getQueryRoutingSuggestion(userMessage);
    }

    const routingHint = formatRoutingHint(routingSuggestion);
    const schemaHint = routingSuggestion.responseSchema ? buildResponseFormatHint(routingSuggestion.responseSchema) : '';

    const hintBlocks = [];

    if (routingHint) {
      hintBlocks.push(`[ROUTING_HINT]\n${routingHint}\n[/ROUTING_HINT]\nUse the suggested tables when applicable.`);
    }

    if (schemaHint) {
      hintBlocks.push(`[RESPONSE_FORMAT]\n${schemaHint}\n[/RESPONSE_FORMAT]\nReturn the JSON payload exactly once using this structure.`);
    }

    const combinedMessage = [augmentedMessage, ...hintBlocks].join('\n\n');

    this.conversationHistory.push({
      role: 'user',
      parts: [{ text: combinedMessage }]
    });

    this.routingHistory.push({
      userMessage,
      routingSuggestion
    });

    const model = this.genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{
        functionDeclarations: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }))
      }],
      systemInstruction: `You are a helpful assistant that helps users explore and query their Google BigQuery data.

When a user asks a question:
1. First, understand what data they're asking about
1. Next, use 'get_available_tables' to see what data is available.
2. Next, use 'get_schema_for_table' on the most relevant table(s) to understand their structure.
3. Then, smartly construct the accurate query that retrieves the required data to answer the user's question.
4. Execute the query using the 'run_query' tool.
5. If a query returns zero rows or incomplete coverage, iteratively adjust the SQL—loosen filters, try alternate attribute spellings, or switch to other recommended tables—before concluding no data exists.
6. Cross reference, link, and process between multiple relevant tables to fetch and synthesize the required information
7. Present results in a clear, conversational way

Always explain what you're doing and why.

RESPONSE FORMAT RULES:
1. Always respond in Markdown using the exact template provided in the [RESPONSE_FORMAT] hint.
2. Restate the user's query in the dedicated section before providing findings.
3. Preserve all headings, table columns, emojis, and bullet formatting shown in the template.
4. Populate tables with the most relevant data available; if data is missing, look up other tables where the data can be found from and link with that table. State "No data" only if you have exhausted all options.
5. Provide hashtags for similar trends in the end. Bundle the similar trends into a collection and give that collection a name.
5. After the main sections, include the concluding footnote specified in the template.
6. Do not output JSON, code fences, or alternative layouts unless explicitly asked.
7. If no [RESPONSE_FORMAT] hint is supplied, use the default \"📌 Data Insights Summary\" template from the shared guidelines.`
    });


    const chat = model.startChat({
      history: this.conversationHistory.slice(0, -1)
    });

    const MAX_FORMAT_RETRIES = 1;
    let attempt = 0;
    let pendingMessage = combinedMessage;
    let finalText = '';
    let aggregatedToolCalls = [];
    let validationResult = { valid: true, missingSections: [] };

    while (attempt <= MAX_FORMAT_RETRIES) {
      const streamResult = await this.runWithRateLimitRetry(
        () => chat.sendMessageStream(pendingMessage),
        'streaming Gemini response'
      );
      const iterator = streamResult?.stream ?? streamResult;
      if (!iterator || typeof iterator[Symbol.asyncIterator] !== 'function') {
        throw new Error('Gemini streaming interface did not provide an async iterator.');
      }

      let response = null;
      let streamedParts = [];

      for await (const chunk of iterator) {
        if (this.streamCallback) {
          this.streamCallback(chunk);
        }

        const parts = chunk?.candidates?.[0]?.content?.parts ?? [];
        streamedParts = this.aggregateParts(streamedParts, parts);
      }

      const resolved = await streamResult.response;
      response = resolved?.response ? resolved : { response: resolved };

      const candidate = response.response?.candidates?.[0] ?? null;
      const finalParts = streamedParts.length > 0
        ? streamedParts
        : (candidate?.content?.parts ?? []);

      if (candidate) {
        candidate.content = candidate.content || {};
        candidate.content.parts = finalParts;
      } else {
        response.response = response.response || {};
        response.response.candidates = [
          {
            content: {
              parts: finalParts
            }
          }
        ];
      }


      const iterationToolCalls = [];

      while (response.response.candidates[0].content.parts.some(part => part.functionCall)) {
        const functionCalls = response.response.candidates[0].content.parts
          .filter(part => part.functionCall)
          .map(part => part.functionCall);

        const functionResponses = [];

        for (const functionCall of functionCalls) {
          const toolCall = {
            name: functionCall.name,
            args: functionCall.args,
            result: null,
            error: null
          };

          try {
            const result = await this.executeToolCall(functionCall.name, functionCall.args, routingSuggestion);
            toolCall.result = result;
            
            functionResponses.push({
              functionResponse: {
                name: functionCall.name,
                response: { result }
              }
            });
          } catch (error) {
            toolCall.error = error.message;
            
            functionResponses.push({
              functionResponse: {
                name: functionCall.name,
                response: { error: error.message }
              }
            });
          }

          iterationToolCalls.push(toolCall);
        }

        this.conversationHistory.push({
          role: 'model',
          parts: response.response.candidates[0].content.parts
        });

        this.conversationHistory.push({
          role: 'function',
          parts: functionResponses
        });


        response = await this.runWithRateLimitRetry(
          () => chat.sendMessage(functionResponses),
          'sending Gemini tool response payload'
        );
      }

      finalText = response.response.text();

      this.conversationHistory.push({
        role: 'model',
        parts: [{ text: finalText }]
      });

      aggregatedToolCalls = aggregatedToolCalls.concat(iterationToolCalls);

      const schemaConfig = routingSuggestion.responseSchema;

      if (!schemaConfig) {
        validationResult = { valid: true, missingSections: [] };
        break;
      }

      validationResult = validateResponseAgainstTemplate(finalText, schemaConfig);

      if (validationResult.valid) {
        break;
      }

      if (attempt === MAX_FORMAT_RETRIES) {
        const missingList = validationResult.missingSections.join('; ');
        finalText = `${finalText}\n\nWARNING: Response did not match required template sections. Missing: ${missingList}`;
        break;
      }

      attempt += 1;

      const correctionPrompt = [
        `Your previous response did not follow the required Markdown template for "${schemaConfig.query_type}".`,
        `Missing sections: ${validationResult.missingSections.join(', ')}`,
        'Please resend the answer using the exact headings, tables, and bullet styles from the [RESPONSE_FORMAT] hint. Keep the template structure intact.'
      ].join('\n');

      this.conversationHistory.push({
        role: 'user',
        parts: [{ text: correctionPrompt }]
      });

      pendingMessage = correctionPrompt;
    }

    let attachments = [];
    let payload = null;

    if (this.pendingMoodboard) {
      const trendRows = this.parseTrendMatrix(finalText);
      this.moodboardGenerator.applyTrendMatrix(
        this.pendingMoodboard.payload,
        trendRows,
        this.pendingMoodboard.payload.approach
      );

      const pdfPath = await this.moodboardGenerator.renderPdfFromPayload(this.pendingMoodboard.payload);
      if (pdfPath) {
        attachments = [
          {
            type: 'application/pdf',
            path: `/api/moodboards/${path.basename(pdfPath)}`,
            absolutePath: pdfPath
          }
        ];
      }

      payload = {
        ra: this.pendingMoodboard.payload.ra,
        brandDNA: this.pendingMoodboard.payload.brandDNA,
        moodboard: this.pendingMoodboard.payload
      };

      this.pendingMoodboard = null;
    }

    return {
      text: finalText,
      toolCalls: aggregatedToolCalls,
      routingSuggestion,
      formatValidation: validationResult,
      attachments,
      payload
    };
  }

  loadConversationHistory(history) {
    this.conversationHistory = cloneHistoryEntries(history);
  }

  getConversationHistorySnapshot() {
    return cloneHistoryEntries(this.conversationHistory);
  }

  resetConversation() {
    this.conversationHistory = [];
  }

  getHistory() {
    return this.conversationHistory;
  }

  getRoutingHistory() {
    return this.routingHistory;
  }
}
