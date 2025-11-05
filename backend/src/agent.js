import { GoogleGenerativeAI } from '@google/generative-ai';
import { listDatasets, listTables, getTableSchema, runQuery, forecast } from './bigquery.js';
import { getQueryRoutingSuggestion } from './queryRouter.js';
import { buildResponseFormatHint, validateResponseAgainstTemplate } from './responseSchema.js';

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

async function executeToolCall(toolName, args) {
  switch (toolName) {
    case 'list_datasets':
      return await listDatasets();
    case 'list_tables':
      return await listTables(args.datasetId);
    case 'get_table_schema':
      return await getTableSchema(args.datasetId, args.tableId);
    case 'run_query':
      return await runQuery(args.sqlQuery, args.maxResults || 100);
    case 'forecast':
      return await forecast(args.datasetId, args.tableId, args.dateColumn, args.valueColumn, args.horizonDays || 30);
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

export class AgenticOrchestrator {
  constructor(apiKey) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.conversationHistory = [];
    this.routingHistory = [];
  }

  async chat(userMessage) {
    const routingSuggestion = getQueryRoutingSuggestion(userMessage);
    const routingHint = formatRoutingHint(routingSuggestion);
    const schemaHint = routingSuggestion.responseSchema ? buildResponseFormatHint(routingSuggestion.responseSchema) : '';

    const hintBlocks = [];

    if (routingHint) {
      hintBlocks.push(`[ROUTING_HINT]\n${routingHint}\n[/ROUTING_HINT]\nUse the suggested tables when applicable.`);
    }

    if (schemaHint) {
      hintBlocks.push(`[RESPONSE_FORMAT]\n${schemaHint}\n[/RESPONSE_FORMAT]\nReturn the JSON payload exactly once using this structure.`);
    }

    const combinedMessage = [userMessage, ...hintBlocks].join('\n\n');

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
5. Smartly create the accurate query that retreives the required data
6. Use run_query to execute SQL queries and get answers
7. Cross reference, link, and process between multiple relevant tables to fetch and synthesize the required information
8. Present results in a clear, conversational way

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
            const result = await executeToolCall(functionCall.name, functionCall.args);
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

    return {
      text: finalText,
      toolCalls: aggregatedToolCalls,
      routingSuggestion,
      formatValidation: validationResult
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
