import { listReports, resolveStorePath } from './wgsnStore.js';

const DEFAULT_RESULT_LIMIT = 5;

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length > 2);
}

function computeRecencyBoost(ingestedAt) {
  if (!ingestedAt) {
    return 0;
  }

  const parsed = Date.parse(ingestedAt);
  if (Number.isNaN(parsed)) {
    return 0;
  }

  const msSince = Date.now() - parsed;
  const days = msSince / (1000 * 60 * 60 * 24);

  if (days <= 30) {
    return 1;
  }
  if (days <= 180) {
    return 0.5;
  }
  if (days <= 365) {
    return 0.25;
  }

  return 0;
}

function countOccurrences(text, token) {
  if (!text || !token) {
    return 0;
  }

  const regex = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function scoreChunk(chunk, tokens, report) {
  const normalizedText = chunk.text?.toLowerCase() ?? '';
  if (!normalizedText) {
    return { score: 0, highlights: [] };
  }

  let rawMatches = 0;
  let coverageHits = 0;
  const highlights = new Set();

  tokens.forEach(token => {
    const occurrences = countOccurrences(normalizedText, token);
    if (occurrences > 0) {
      rawMatches += occurrences;
      coverageHits += 1;
      highlights.add(token);
    }
  });

  if (rawMatches === 0) {
    return { score: 0, highlights: [] };
  }

  const coverageScore = coverageHits / tokens.length;
  const keywordOverlap = (chunk.keywords || []).reduce((count, keyword) => (
    count + (tokens.includes(keyword.toLowerCase()) ? 1 : 0)
  ), 0);

  const recencyBoost = computeRecencyBoost(report.ingestedAt);
  const keywordBoost = keywordOverlap * 0.75;
  const coverageBoost = coverageScore * 2;
  const densityScore = chunk.tokenEstimate
    ? Math.min(1, chunk.tokenEstimate / 800)
    : 0;

  const score = rawMatches * 0.6 + keywordBoost + coverageBoost + recencyBoost + densityScore;

  return {
    score,
    highlights: Array.from(highlights)
  };
}

export async function searchWgsnReports(query, options = {}) {
  if (!query || typeof query !== 'string') {
    throw new Error('searchWgsnReports requires a textual query.');
  }

  const tokens = tokenize(query);
  if (!tokens.length) {
    throw new Error('Unable to derive tokens from the provided query.');
  }

  const limit = Math.min(Math.max(options.limit ?? DEFAULT_RESULT_LIMIT, 1), 20);
  const minScore = options.minScore ?? 0;
  const storePath = resolveStorePath(options.storePath);
  const reports = await listReports(storePath);

  const tagFilter = options.tags
    ? new Set(
        (Array.isArray(options.tags) ? options.tags : String(options.tags).split(','))
          .map(tag => tag.trim().toLowerCase())
          .filter(Boolean)
      )
    : null;

  const scoredChunks = [];

  reports.forEach(report => {
    if (!Array.isArray(report.chunks) || report.chunks.length === 0) {
      return;
    }

    if (tagFilter && !(report.tags || []).some(tag => tagFilter.has(tag.toLowerCase()))) {
      return;
    }

    report.chunks.forEach(chunk => {
      const { score, highlights } = scoreChunk(chunk, tokens, report);
      if (score >= minScore) {
        scoredChunks.push({
          score,
          highlights,
          reportId: report.id,
          reportTitle: report.title,
          reportSummary: report.summary,
          tags: report.tags || [],
          topics: report.topics || [],
          chunkId: chunk.id,
          text: chunk.text,
          startPage: chunk.startPage,
          endPage: chunk.endPage,
          keywords: chunk.keywords || [],
          ingestedAt: report.ingestedAt,
          sourcePath: report.sourcePath,
          tokenEstimate: chunk.tokenEstimate
        });
      }
    });
  });

  scoredChunks.sort((a, b) => b.score - a.score);

  return scoredChunks.slice(0, limit);
}

export async function listWgsnReportsMetadata(options = {}) {
  const storePath = resolveStorePath(options.storePath);
  const reports = await listReports(storePath);

  return reports.map(report => ({
    id: report.id,
    title: report.title,
    tags: report.tags || [],
    topics: report.topics || [],
    summary: report.summary,
    ingestedAt: report.ingestedAt,
    numPages: report.numPages,
    chunkCount: Array.isArray(report.chunks) ? report.chunks.length : 0
  }));
}
