import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.resolve(__dirname, '../config/responseSchemas.json');

let cachedConfig = null;

function loadConfig() {
  if (!cachedConfig) {
    const fileContent = readFileSync(CONFIG_PATH, 'utf-8');
    cachedConfig = JSON.parse(fileContent);
  }
  return cachedConfig;
}

export function getResponseSchema(queryType) {
  const config = loadConfig();
  const schemas = config.schemas || {};
  const resolvedSchema = (queryType && schemas[queryType]) ? schemas[queryType] : schemas.default || {};

  return {
    schemaKey: (queryType && schemas[queryType]) ? queryType : 'default',
    formatVersion: config.format_version || resolvedSchema.version || 1,
    common: config.common || {},
    ...resolvedSchema
  };
}

export function buildResponseFormatHint(schemaConfig) {
  if (!schemaConfig) {
    return '';
  }

  const { common = {}, template_lines: templateLines = [], query_type: queryType, version } = schemaConfig;
  const { guidelines = [], reminder } = common;
  const template = templateLines.join('\n');

  const lines = [
    `Markdown template (version ${version || schemaConfig.formatVersion || 1}) for query type "${queryType || 'generic'}":`,
    reminder ? `- Reminder: ${reminder}` : null,
    guidelines.length > 0 ? `- Guidelines:\n  - ${guidelines.join('\n  - ')}` : null,
    '',
    template
  ];

  return lines.filter(Boolean).join('\n');
}

export function validateResponseAgainstTemplate(responseText, schemaConfig) {
  if (!schemaConfig) {
    return { valid: true, missingSections: [] };
  }

  const requiredSections = schemaConfig.required_sections || [];
  const missingSections = requiredSections.filter(section => !responseText.includes(section));

  return {
    valid: missingSections.length === 0,
    missingSections
  };
}
