import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.resolve(__dirname, '../config/query_to_table_mapping_for_mcp.json');

let cachedConfig = null;

function loadConfig() {
  if (!cachedConfig) {
    const fileContent = readFileSync(CONFIG_PATH, 'utf-8');
    cachedConfig = JSON.parse(fileContent);
  }
  return cachedConfig;
}

function sanitize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function getTokenSet(text) {
  return new Set(sanitize(text).split(' ').filter(Boolean));
}

function keywordMatches(queryForms, keyword) {
  const keywordSanitized = sanitize(keyword);
  if (!keywordSanitized) {
    return false;
  }

  const keywordTokens = keywordSanitized.split(' ');

  // Direct string match against provided query forms.
  for (const form of queryForms) {
    if (form.includes(keywordSanitized)) {
      return true;
    }
  }

  // If the keyword is a single token, check token presence.
  if (keywordTokens.length === 1) {
    return queryForms.some(form => form.split(' ').includes(keywordTokens[0]));
  }

  // For multi-token keywords, ensure all tokens exist in the query token set.
  const queryTokenSet = getTokenSet(queryForms[0] ?? '');
  return keywordTokens.every(token => queryTokenSet.has(token));
}

export function getQueryRoutingSuggestion(userQuery) {
  const config = loadConfig();
  const fallbackBehavior = config.fallback_behavior || {};
  const confidenceThreshold = typeof config.confidence_threshold === 'number' ? config.confidence_threshold : 0.6;
  const maxTables = Math.max(1, config.max_tables_per_query || 3);

  const queryForms = [
    sanitize(userQuery),
    userQuery.toLowerCase()
  ];

  let bestMatch = null;

  for (const mapping of config.query_mappings || []) {
    const matchedKeywords = new Set();

    for (const keyword of mapping.keywords || []) {
      if (keywordMatches(queryForms, keyword)) {
        matchedKeywords.add(keyword.toLowerCase());
      }
    }

    if (matchedKeywords.size === 0) {
      continue;
    }

    const denominator = Math.min(5, (mapping.keywords || []).length || 5);
    const score = Math.min(1, matchedKeywords.size / denominator);

    if (
      !bestMatch ||
      score > bestMatch.score ||
      (score === bestMatch.score && (mapping.priority ?? Infinity) < (bestMatch.mapping.priority ?? Infinity))
    ) {
      bestMatch = {
        mapping,
        matchedKeywords: Array.from(matchedKeywords),
        score
      };
    }
  }

  if (!bestMatch || bestMatch.score < confidenceThreshold) {
    return {
      queryType: null,
      confidence: bestMatch ? bestMatch.score : 0,
      tables: (fallbackBehavior.default_tables || []).slice(0, maxTables).map(tableId => ({
        dataset: 'nextwave',
        table: tableId,
        priority: null,
        reason: 'Fallback default table'
      })),
      matchedKeywords: bestMatch ? bestMatch.matchedKeywords : [],
      fallbackApplied: true,
      fallbackBehavior
    };
  }

  const sortedTables = (bestMatch.mapping.tables || [])
    .slice()
    .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))
    .slice(0, maxTables);

  return {
    queryType: bestMatch.mapping.query_type,
    confidence: bestMatch.score,
    tables: sortedTables,
    matchedKeywords: bestMatch.matchedKeywords,
    fallbackApplied: false,
    fallbackBehavior
  };
}
