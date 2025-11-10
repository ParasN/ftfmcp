const express = require('express');
const fs = require('fs');
const path = require('path');
const { BigQuery } = require('@google-cloud/bigquery');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { z } = require('zod');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const app = express();
const port = process.env.MCP_PORT || 3002;
const httpPaths = Array.from(new Set([process.env.MCP_HTTP_PATH || '/', '/mcp']));
const ssePaths = Array.from(new Set([process.env.MCP_SSE_PATH || '/', '/sse']));
const sseMessagesPath = process.env.MCP_SSE_MESSAGES_PATH || '/messages';
const sseSessions = new Map();

const bigquery = new BigQuery({
  projectId: process.env.GCP_PROJECT_ID
});

const mcpConfigPath = path.join(
  __dirname,
  '../../backend/config/query_to_table_mapping_for_mcp.json'
);

app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

async function loadTableMappings() {
  const data = await fs.promises.readFile(mcpConfigPath, 'utf8');
  const mcpConfig = JSON.parse(data);
  const allTables = mcpConfig.query_mappings.flatMap(mapping => mapping.tables || []);

  const uniqueTables = allTables.reduce((acc, table) => {
    if (!table?.dataset || !table?.table) {
      return acc;
    }
    const tableIdentifier = `${table.dataset}.${table.table}`;
    if (!acc[tableIdentifier]) {
      acc[tableIdentifier] = {
        name: table.table,
        dataset: table.dataset,
        description: table.reason
      };
    }
    return acc;
  }, {});

  return Object.values(uniqueTables);
}

async function runSqlQuery(query) {
  const [job] = await bigquery.createQueryJob({ query });
  const [rows] = await job.getQueryResults();
  return rows;
}

async function fetchTableSchema(dataset, table) {
  const [metadata] = await bigquery.dataset(dataset).table(table).getMetadata();
  return metadata.schema;
}

async function runForecastJob(params) {
  const {
    datasetId,
    tableId,
    dateColumn,
    valueColumn,
    horizonDays = 30
  } = params;

  const projectId = bigquery.projectId;
  const modelName = `${datasetId}.forecast_model_${Date.now()}`;

  try {
    const createModelQuery = `
      CREATE OR REPLACE MODEL \`${projectId}.${modelName}\`
      OPTIONS(
        model_type='ARIMA_PLUS',
        time_series_timestamp_col='${dateColumn}',
        time_series_data_col='${valueColumn}',
        auto_arima=TRUE,
        data_frequency='AUTO_FREQUENCY',
        horizon=${horizonDays}
      ) AS
      SELECT ${dateColumn}, ${valueColumn}
      FROM \`${projectId}.${datasetId}.${tableId}\`
      WHERE ${dateColumn} IS NOT NULL AND ${valueColumn} IS NOT NULL
      ORDER BY ${dateColumn}
    `;

    const [createJob] = await bigquery.createQueryJob({ query: createModelQuery, location: 'US' });
    await createJob.getQueryResults();

    const forecastQuery = `
      SELECT
        *
      FROM
        ML.FORECAST(MODEL \`${projectId}.${modelName}\`,
                    STRUCT(${horizonDays} AS horizon, 0.95 AS confidence_level))
    `;

    const [forecastJob] = await bigquery.createQueryJob({ query: forecastQuery, location: 'US' });
    const [forecastRows] = await forecastJob.getQueryResults();

    await bigquery
      .createQueryJob({ query: `DROP MODEL IF EXISTS \`${projectId}.${modelName}\``, location: 'US' })
      .catch(err => {
        console.warn('Failed to cleanup model:', err.message);
      });

    return {
      forecast: forecastRows,
      horizonDays,
      model: 'ARIMA_PLUS',
      totalForecasted: forecastRows.length
    };
  } catch (error) {
    await bigquery
      .createQueryJob({ query: `DROP MODEL IF EXISTS \`${projectId}.${modelName}\``, location: 'US' })
      .catch(() => {});
    throw error;
  }
}

function createMcpServer() {
  const server = new McpServer({
    name: 'ftfmcp-bigquery',
    version: '1.0.0'
  });

  server.registerTool(
    'list_tables',
    {
      title: 'List Tables',
      description: 'Lists dataset/table pairs defined in query_to_table_mapping_for_mcp.json'
    },
    async () => {
      const tables = await loadTableMappings();
      return {
        content: [{ type: 'text', text: JSON.stringify(tables, null, 2) }],
        structuredContent: tables
      };
    }
  );

  server.registerTool(
    'get_table_schema',
    {
      title: 'Get Table Schema',
      description: 'Returns the schema for a specific BigQuery table',
      inputSchema: {
        dataset: z.string().min(1, 'dataset is required').describe('BigQuery dataset ID'),
        table: z.string().min(1, 'table is required').describe('BigQuery table ID')
      }
    },
    async ({ dataset, table }) => {
      const schema = await fetchTableSchema(dataset, table);
      return {
        content: [{ type: 'text', text: JSON.stringify(schema, null, 2) }],
        structuredContent: schema
      };
    }
  );

  server.registerTool(
    'run_query',
    {
      title: 'Run SQL Query',
      description: 'Executes a SQL query against BigQuery',
      inputSchema: {
        query: z.string().min(1, 'query is required').describe('Standard SQL query text')
      }
    },
    async ({ query }) => {
      const rows = await runSqlQuery(query);
      return {
        content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
        structuredContent: rows
      };
    }
  );

  server.registerTool(
    'run_forecast',
    {
      title: 'Run Forecast',
      description: 'Builds a temporary ARIMA model for the specified dataset/table and projects values',
      inputSchema: {
        datasetId: z.string().min(1, 'datasetId is required').describe('Dataset containing the table'),
        tableId: z.string().min(1, 'tableId is required').describe('Table with the time series data'),
        dateColumn: z.string().min(1, 'dateColumn is required').describe('Timestamp column'),
        valueColumn: z.string().min(1, 'valueColumn is required').describe('Metric column to forecast'),
        horizonDays: z
          .number()
          .int()
          .positive()
          .max(365)
          .optional()
          .describe('Optional forecast horizon in days (default 30)')
      }
    },
    async args => {
      const result = await runForecastJob(args);
      return {
        content: [
          {
            type: 'text',
            text: `Forecast complete for ${args.datasetId}.${args.tableId} (${result.totalForecasted} rows)`
          }
        ],
        structuredContent: result
      };
    }
  );

  return server;
}

async function handleStreamableRequest(req, res) {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  const server = createMcpServer();

  try {
    res.on('close', () => {
      transport.close();
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error'
        },
        id: null
      });
    }
  } finally {
    server.close().catch(() => {});
    transport.close();
  }
}

function isSseRequest(req) {
  return (req.headers.accept || '').includes('text/event-stream');
}

async function handleSseRequest(req, res, next) {
  if (!isSseRequest(req)) {
    return next();
  }

  try {
    const transport = new SSEServerTransport(sseMessagesPath, res);
    const server = createMcpServer();
    sseSessions.set(transport.sessionId, { transport, server });

    res.on('close', () => {
      transport.close();
      server.close().catch(() => {});
      sseSessions.delete(transport.sessionId);
    });

    await server.connect(transport);
  } catch (error) {
    console.error('Error establishing SSE connection:', error);
    if (!res.headersSent) {
      res.status(500).end();
    }
  }
}

httpPaths.forEach(pathname => {
  app.post(pathname, handleStreamableRequest);
});

ssePaths.forEach(pathname => {
  app.get(pathname, handleSseRequest);
});

app.post(sseMessagesPath, async (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId || !sseSessions.has(sessionId)) {
    return res.status(400).send('No transport found for sessionId');
  }

  const session = sseSessions.get(sessionId);
  try {
    await session.transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error('Error handling SSE message:', error);
    if (!res.headersSent) {
      res.status(500).send('Internal server error');
    }
  }
});

app.get('/tables', async (req, res) => {
  try {
    const tables = await loadTableMappings();
    res.status(200).json(tables);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error('MCP config file not found:', error);
    } else {
      console.error('Error parsing MCP config file:', error);
    }
    res.status(500).json({ error: 'Failed to load table mappings.' });
  }
});

app.post('/query', async (req, res) => {
  const { query } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'Query is required.' });
  }
  try {
    const rows = await runSqlQuery(query);
    res.status(200).json(rows);
  } catch (error) {
    console.error('Failed to run query:', error);
    res.status(500).json({ error: 'Failed to run query.' });
  }
});

app.post('/forecast', async (req, res) => {
  const { datasetId, tableId, dateColumn, valueColumn } = req.body;
  if (!datasetId || !tableId || !dateColumn || !valueColumn) {
    return res
      .status(400)
      .json({ error: 'datasetId, tableId, dateColumn and valueColumn are required.' });
  }

  try {
    const result = await runForecastJob(req.body);
    res.status(200).json(result);
  } catch (error) {
    console.error('Failed to run forecast:', error);
    res.status(500).json({ error: 'Failed to run forecast.' });
  }
});

app.get('/tables/:dataset/:table/schema', async (req, res) => {
  const { dataset, table } = req.params;
  try {
    const schema = await fetchTableSchema(dataset, table);
    res.status(200).json(schema);
  } catch (error) {
    console.error(`Failed to get schema for ${dataset}.${table}:`, error);
    res.status(500).json({ error: `Failed to get schema for table ${dataset}.${table}.` });
  }
});

app.listen(port, () => {
  console.log(`MCP Server listening on port ${port}`);
});
