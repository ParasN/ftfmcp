
import { GoogleGenerativeAI } from '@google/generative-ai';
import { listDatasets, listTables, getTableSchema, runQuery, forecast } from './bigquery.js';
import { getQueryRoutingSuggestion } from './queryRouter.js';

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
    this.responseFormats = {};
  }

  async initializeResponseFormats() {
    const fs = await import('fs');
    const jsonData = fs.readFileSync('./src/response_formats.json', 'utf-8');
    this.responseFormats = JSON.parse(jsonData);
  }

  async chat(userMessage) {
    if (Object.keys(this.responseFormats).length === 0) {
      await this.initializeResponseFormats();
    }

    const routingSuggestion = getQueryRoutingSuggestion(userMessage);
    const routingHint = formatRoutingHint(routingSuggestion);

    const combinedMessage = routingHint
      ? `${userMessage}\n\n[ROUTING_HINT]\n${routingHint}\n[/ROUTING_HINT]\n\nUse the suggested tables when applicable.`
      : userMessage;

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
      systemInstruction: `You are a helpful assistant that helps users explore and query their Google BigQuery data.\n\nWhen a user asks a question:\n1. First, understand what data they're asking about\n2. Use list_datasets to see available datasets if needed\n3. Use list_tables to see tables in relevant datasets\n4. Use get_table_schema to understand table structure before querying\n5. Use run_query to execute SQL queries and get answers\n6. Present results in a clear, conversational way\n\nAlways explain what you're doing and why. If you need to run multiple queries or explore the schema, do that, link multiple tables if need be to fetch the required info. never say no data.explain your reasoning.\n\nWhen providing a final answer, you MUST use the structured response format provided below. Select the most appropriate schema based on the user's query and fill in the placeholders with the data you have gathered.\n\n${JSON.stringify(this.responseFormats, null, 2)}`
    });

    const chat = model.startChat({
      history: this.conversationHistory.slice(0, -1)
    });

    let response = await chat.sendMessage(combinedMessage);
    let toolCalls = [];
    let finalText = '';

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

        toolCalls.push(toolCall);
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

    return {
      text: finalText,
      toolCalls: toolCalls,
      routingSuggestion
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
