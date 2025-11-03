import { BigQuery } from '@google-cloud/bigquery';

let bigqueryClient = null;

export function initializeBigQuery(projectId) {
  bigqueryClient = new BigQuery({ 
    projectId 
  });
  return bigqueryClient;
}

export function getBigQueryClient() {
  if (!bigqueryClient) {
    throw new Error('BigQuery client not initialized');
  }
  return bigqueryClient;
}


export async function listDatasets() {
  const client = getBigQueryClient();
  const [datasets] = await client.getDatasets();
  return datasets.map(dataset => ({
    id: dataset.id,
    location: dataset.location,
    metadata: dataset.metadata
  }));
}

export async function listTables(datasetId) {
  const client = getBigQueryClient();
  const dataset = client.dataset(datasetId);
  const [tables] = await dataset.getTables();
  return tables.map(table => ({
    id: table.id,
    datasetId: datasetId,
    fullId: `${datasetId}.${table.id}`
  }));
}

export async function getTableSchema(datasetId, tableId) {
  const client = getBigQueryClient();
  const dataset = client.dataset(datasetId);
  const table = dataset.table(tableId);
  const [metadata] = await table.getMetadata();
  
  return {
    schema: metadata.schema,
    numRows: metadata.numRows,
    numBytes: metadata.numBytes,
    creationTime: metadata.creationTime,
    lastModifiedTime: metadata.lastModifiedTime,
    description: metadata.description
  };
}

export async function runQuery(sqlQuery, maxResults = 100) {
  const client = getBigQueryClient();
  
  const options = {
    query: sqlQuery,
    location: 'US',
    maxResults: maxResults
  };

  const [job] = await client.createQueryJob(options);
  const [rows] = await job.getQueryResults();
  
  return {
    rows: rows,
    totalRows: rows.length,
    jobId: job.id
  };
}

export async function forecast(datasetId, tableId, dateColumn, valueColumn, horizonDays = 30) {
  const client = getBigQueryClient();
  const projectId = client.projectId;
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
    
    console.log('Creating forecast model...');
    const [createJob] = await client.createQueryJob({ query: createModelQuery, location: 'US' });
    await createJob.getQueryResults();
    
    const forecastQuery = `
      SELECT
        *
      FROM
        ML.FORECAST(MODEL \`${projectId}.${modelName}\`,
                    STRUCT(${horizonDays} AS horizon, 0.95 AS confidence_level))
    `;
    
    console.log('Generating forecast...');
    const [forecastJob] = await client.createQueryJob({ query: forecastQuery, location: 'US' });
    const [forecastRows] = await forecastJob.getQueryResults();
    
    const cleanupQuery = `DROP MODEL IF EXISTS \`${projectId}.${modelName}\``;
    await client.createQueryJob({ query: cleanupQuery, location: 'US' }).catch(err => {
      console.warn('Failed to cleanup model:', err.message);
    });
    
    return {
      forecast: forecastRows,
      horizonDays: horizonDays,
      model: 'ARIMA_PLUS',
      totalForecasted: forecastRows.length
    };
  } catch (error) {
    const cleanupQuery = `DROP MODEL IF EXISTS \`${projectId}.${modelName}\``;
    await client.createQueryJob({ query: cleanupQuery, location: 'US' }).catch(() => {});
    throw error;
  }
}
