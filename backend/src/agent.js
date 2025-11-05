import { GoogleGenerativeAI } from '@google/generative-ai';
import path from 'node:path';
import { listDatasets, listTables, getTableSchema, runQuery, forecast } from './bigquery.js';
import { getQueryRoutingSuggestion } from './queryRouter.js';
import { buildResponseFormatHint, validateResponseAgainstTemplate, getResponseSchema } from './responseSchema.js';
import { MoodboardGenerator } from './moodboardGenerator.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MOODBOARD_TRIGGER_KEYWORD = 'MOODBOARD_RA';
const RA_INPUT_PATH = path.resolve(__dirname, '../config/mock_ra_input.json');

const tools = [
  {
    name: 'list_datasets',
    description: 'Lists all available BigQuery datasets in the project. Use this to discover what datasets are available.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'list_tables',
    description: 'Lists all tables in a specific BigQuery dataset. Use this to see what tables are available in a dataset.',
    parameters: {
      type: 'object',
      properties: {
        datasetId: {
          type: 'string',
          description: 'The ID of the dataset to list tables from'
        }
      },
      required: ['datasetId']
    }
  },
  {
    name: 'get_table_schema',
    description: 'Gets the schema and metadata for a specific table. Use this to understand the structure of a table before querying it.',
    parameters: {
      type: 'object',
      properties: {
        datasetId: {
          type: 'string',
          description: 'The ID of the dataset containing the table'
        },
        tableId: {
          type: 'string',
          description: 'The ID of the table to get schema for'
        }
      },
      required: ['datasetId', 'tableId']
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
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results to return (default: 100)'
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
    guidance.recommendedActions.push(
      'Inspect the schema and adjust the query to broaden the search scope.'
    );
  }

  return guidance;
}

export class AgenticOrchestrator {
  constructor(apiKey) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.conversationHistory = [];
    this.routingHistory = [];
    this.moodboardGenerator = new MoodboardGenerator();
    this.pendingMoodboard = null;
  }

  async executeToolCall(toolName, args, routingSuggestion) {
    switch (toolName) {
      case 'list_datasets':
        return await listDatasets();
      case 'list_tables':
        return await listTables(args.datasetId);
      case 'get_table_schema':
        return await getTableSchema(args.datasetId, args.tableId);
      case 'run_query': {
        const result = await runQuery(args.sqlQuery, args.maxResults || 100);
        if (!result || result.totalRows > 0) {
          return result;
        }

        return {
          ...result,
          retryGuidance: buildNoResultGuidance(args.sqlQuery, routingSuggestion)
        };
      }
      case 'forecast':
        return await forecast(
          args.datasetId,
          args.tableId,
          args.dateColumn,
          args.valueColumn,
          args.horizonDays || 30
        );
      default:
        throw new Error(`Unknown tool: ${toolName}`);
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
2. Use list_datasets to see available datasets if needed
3. Use list_tables to see tables in relevant datasets
4. Use get_table_schema to understand table structure before querying
5. Smartly create the accurate query that retrieves the required data
6. Use run_query to execute SQL queries and get answers
7. If a query returns zero rows or incomplete coverage, iteratively adjust the SQL—loosen filters, try alternate attribute spellings, or switch to other recommended tables—before concluding no data exists.
8. Cross reference, link, and process between multiple relevant tables to fetch and synthesize the required information
9. Present results in a clear, conversational way

Always explain what you're doing and why. If you need to run multiple queries or explore the schema, explain your reasoning.

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
      let response = await chat.sendMessage(pendingMessage);
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


        response = await chat.sendMessage(functionResponses);
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
