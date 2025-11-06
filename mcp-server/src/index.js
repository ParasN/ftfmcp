const express = require('express');
const fs = require('fs');
const path = require('path');
const { BigQuery } = require('@google-cloud/bigquery');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const app = express();
const port = process.env.MCP_PORT || 3002;

const bigquery = new BigQuery({
  projectId: process.env.GCP_PROJECT_ID
});

app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/tables', (req, res) => {
    const mcpConfigPath = path.join(__dirname, '../../backend/config/query_to_table_mapping_for_mcp.json');
    fs.readFile(mcpConfigPath, 'utf8', (err, data) => {
        if (err) {
            console.error("Error reading MCP config file:", err);
            return res.status(500).json({ error: 'Failed to load table mappings.' });
        }
        try {
            const mcpConfig = JSON.parse(data);
            const allTables = mcpConfig.query_mappings.flatMap(mapping => mapping.tables);

            const uniqueTables = allTables.reduce((acc, table) => {
                const tableIdentifier = `${table.dataset}.${table.table}`;
                if (!acc[tableIdentifier]) {
                    acc[tableIdentifier] = {
                        name: table.table,
                        dataset: table.dataset,
                        description: table.reason, // Using reason as the description
                    };
                }
                return acc;
            }, {});

            res.status(200).json(Object.values(uniqueTables));
        } catch (parseErr) {
            console.error("Error parsing MCP config file:", parseErr);
            res.status(500).json({ error: 'Failed to parse table mappings.' });
        }
    });
});


app.post('/query', async (req, res) => {
    const { query } = req.body;
    if (!query) {
        return res.status(400).json({ error: 'Query is required.' });
    }
    try {
        const [job] = await bigquery.createQueryJob({ query });
        const [rows] = await job.getQueryResults();
        res.status(200).json(rows);
    } catch (error) {
        console.error('Failed to run query:', error);
        res.status(500).json({ error: 'Failed to run query.' });
    }
});

app.post('/forecast', async (req, res) => {
    const { datasetId, tableId, dateColumn, valueColumn, horizonDays = 30 } = req.body;
    if (!datasetId || !tableId || !dateColumn || !valueColumn) {
        return res.status(400).json({ error: 'datasetId, tableId, dateColumn and valueColumn are required.' });
    }

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

        const cleanupQuery = `DROP MODEL IF EXISTS \`${projectId}.${modelName}\``;
        await bigquery.createQueryJob({ query: cleanupQuery, location: 'US' }).catch(err => {
            console.warn('Failed to cleanup model:', err.message);
        });

        res.status(200).json({
            forecast: forecastRows,
            horizonDays: horizonDays,
            model: 'ARIMA_PLUS',
            totalForecasted: forecastRows.length
        });
    } catch (error) {
        console.error('Failed to run forecast:', error);
        const cleanupQuery = `DROP MODEL IF EXISTS \`${projectId}.${modelName}\``;
        await bigquery.createQueryJob({ query: cleanupQuery, location: 'US' }).catch(() => {});
        res.status(500).json({ error: 'Failed to run forecast.' });
    }
});

app.get('/tables/:dataset/:table/schema', async (req, res) => {
    const { dataset, table } = req.params;
    try {
        const [metadata] = await bigquery.dataset(dataset).table(table).getMetadata();
        res.status(200).json(metadata.schema);
    } catch (error) {
        console.error(`Failed to get schema for ${dataset}.${table}:`, error);
        res.status(500).json({ error: `Failed to get schema for table ${dataset}.${table}.` });
    }
});

app.listen(port, () => {
  console.log(`MCP Server listening on port ${port}`);
});
