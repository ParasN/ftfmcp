import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pdfParse from 'pdf-parse';
import { resolveStorePath, upsertReport } from './wgsnStore.js';

const DEFAULT_CHUNK_SIZE = 1400;
const DEFAULT_MIN_CHUNK_SIZE = 400;
const DEFAULT_OVERLAP_SENTENCES = 2;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'are', 'was', 'were', 'from', 'that', 'this', 'have', 'has', 'had', 'into', 'your',
  'our', 'their', 'they', 'them', 'can', 'will', 'about', 'such', 'more', 'than', 'also', 'each', 'over', 'been', 'when',
  'where', 'what', 'which', 'between', 'through', 'across', 'towards', 'toward', 'these', 'those', 'upon', 'within',
  'while', 'after', 'before', 'because', 'though', 'however', 'very', 'some', 'most', 'many', 'per', 'via', 'use', 'used',
  'using'
]);

function normalizeWhitespace(text = '') {
  return text
    .replace(/\u0000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitIntoSegments(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return [];
  }

  const sentenceRegex = /(?<=[.!?;:])\s+(?=[A-Z0-9])/g;
  const sentences = normalized.split(sentenceRegex).map(segment => segment.trim()).filter(Boolean);

  if (sentences.length > 4) {
    return sentences;
  }

  if (normalized.length <= 800) {
    return [normalized];
  }

  const chunkSize = 800;
  const output = [];
  for (let i = 0; i < normalized.length; i += chunkSize) {
    output.push(normalized.slice(i, i + chunkSize));
  }

  return output;
}

function estimateTokenCount(text) {
  if (!text) {
    return 0;
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

function extractKeywords(text, maxKeywords = 8) {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2 && !STOPWORDS.has(token));

  const frequency = tokens.reduce((acc, token) => {
    acc[token] = (acc[token] || 0) + 1;
    return acc;
  }, {});

  return Object.entries(frequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([token]) => token);
}

function buildChunksFromPages(pageTexts, options = {}) {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const minChunkSize = options.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE;
  const overlapSentences = options.overlapSentences ?? DEFAULT_OVERLAP_SENTENCES;

  const chunks = [];
  let sentenceBuffer = [];
  let charCount = 0;

  const flushChunk = (endPage) => {
    if (!sentenceBuffer.length) {
      return;
    }

    const text = sentenceBuffer.map(entry => entry.text).join(' ').trim();
    if (!text) {
      sentenceBuffer = [];
      charCount = 0;
      return;
    }

    const startPage = sentenceBuffer[0].page;
    const chunk = {
      text,
      startPage,
      endPage: endPage ?? sentenceBuffer[sentenceBuffer.length - 1].page,
      keywords: extractKeywords(text),
      tokenEstimate: estimateTokenCount(text),
      charCount: text.length
    };

    chunks.push(chunk);

    if (overlapSentences > 0) {
      sentenceBuffer = sentenceBuffer.slice(-overlapSentences);
      charCount = sentenceBuffer.reduce((sum, entry) => sum + entry.text.length + 1, 0);
    } else {
      sentenceBuffer = [];
      charCount = 0;
    }
  };

  pageTexts.forEach((pageText, index) => {
    const pageNumber = index + 1;
    const segments = splitIntoSegments(pageText);

    segments.forEach(segment => {
      const entry = { text: segment, page: pageNumber };
      sentenceBuffer.push(entry);
      charCount += segment.length + 1;

      if (charCount >= chunkSize) {
        flushChunk(pageNumber);
      }
    });
  });

  if (sentenceBuffer.length > 0 && (charCount >= minChunkSize || chunks.length === 0)) {
    flushChunk(sentenceBuffer[sentenceBuffer.length - 1].page);
  }

  return chunks;
}

function fallbackPageSplit(text) {
  if (!text) {
    return [];
  }

  const byFormFeed = text.split('\f').map(part => part.trim()).filter(Boolean);
  if (byFormFeed.length > 1) {
    return byFormFeed;
  }

  return text.split(/\n{3,}/).map(part => part.trim()).filter(Boolean);
}

async function extractPdfPages(buffer) {
  const pageTexts = [];
  const parsed = await pdfParse(buffer, {
    pagerender: async pageData => {
      const textContent = await pageData.getTextContent();
      const rawText = textContent.items.map(item => item.str).join(' ');
      const normalized = normalizeWhitespace(rawText);
      pageTexts[pageData.pageIndex] = normalized;
      return normalized;
    }
  });

  if (pageTexts.length === 0 && parsed.text) {
    const fallbackPages = fallbackPageSplit(parsed.text);
    fallbackPages.forEach((pageText, idx) => {
      pageTexts[idx] = normalizeWhitespace(pageText);
    });
  }

  return {
    pageTexts: pageTexts.filter(Boolean),
    numPages: parsed.numpages || pageTexts.length,
    info: parsed.info || {},
    metadata: parsed.metadata?.metadata || null,
    text: parsed.text || ''
  };
}

function buildReportId(fileName) {
  const slug = path
    .parse(fileName)
    .name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'report';

  return `wgsn-${slug}-${Date.now().toString(36)}`;
}

function deriveSummary(chunks, maxChars = 420) {
  if (!chunks.length) {
    return '';
  }

  const combined = chunks.slice(0, 2).map(chunk => chunk.text).join(' ');
  if (combined.length <= maxChars) {
    return combined;
  }

  return `${combined.slice(0, maxChars - 1).trim()}…`;
}

function aggregateTopicKeywords(chunks, maxKeywords = 12) {
  const frequency = new Map();
  chunks.forEach(chunk => {
    (chunk.keywords || []).forEach(keyword => {
      frequency.set(keyword, (frequency.get(keyword) || 0) + 1);
    });
  });

  return Array.from(frequency.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([keyword]) => keyword);
}

function coerceTags(tags) {
  if (!tags) {
    return [];
  }

  if (Array.isArray(tags)) {
    return tags.map(tag => String(tag).trim()).filter(Boolean);
  }

  return String(tags)
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean);
}

export async function ingestWgsnReport(filePath, options = {}) {
  if (!filePath) {
    throw new Error('A PDF path is required to ingest a WGSN report.');
  }

  const resolvedPath = path.resolve(filePath);
  const stats = await fs.stat(resolvedPath).catch(() => null);

  if (!stats || !stats.isFile()) {
    throw new Error(`File not found: ${resolvedPath}`);
  }

  if (!resolvedPath.toLowerCase().endsWith('.pdf')) {
    throw new Error('WGSN ingestion currently supports only PDF files.');
  }

  const buffer = await fs.readFile(resolvedPath);
  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
  const parsedPdf = await extractPdfPages(buffer);

  if (!parsedPdf.pageTexts.length) {
    throw new Error('No extractable text was found in the supplied PDF.');
  }

  const chunkOptions = {
    chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
    minChunkSize: options.minChunkSize ?? DEFAULT_MIN_CHUNK_SIZE,
    overlapSentences: options.overlapSentences ?? DEFAULT_OVERLAP_SENTENCES
  };

  const chunks = buildChunksFromPages(parsedPdf.pageTexts, chunkOptions);

  if (!chunks.length) {
    throw new Error('Failed to produce meaningful chunks from the PDF content.');
  }

  const reportId = options.reportId || buildReportId(resolvedPath);
  const now = new Date().toISOString();
  const summary = options.summary || deriveSummary(chunks);
  const topics = aggregateTopicKeywords(chunks);

  const reportRecord = {
    id: reportId,
    title: options.title || parsedPdf.info?.Title || path.parse(resolvedPath).name,
    summary,
    tags: coerceTags(options.tags),
    checksum,
    sourcePath: resolvedPath,
    fileName: path.basename(resolvedPath),
    ingestedAt: now,
    numPages: parsedPdf.numPages,
    metadata: {
      author: parsedPdf.info?.Author || null,
      subject: parsedPdf.info?.Subject || null,
      keywords: parsedPdf.info?.Keywords || null,
      creator: parsedPdf.info?.Creator || null,
      producer: parsedPdf.info?.Producer || null,
      creationDate: parsedPdf.info?.CreationDate || null,
      modDate: parsedPdf.info?.ModDate || null
    },
    topics,
    chunks: chunks.map((chunk, idx) => ({
      id: `${reportId}-chunk-${String(idx + 1).padStart(3, '0')}`,
      index: idx,
      text: chunk.text,
      startPage: chunk.startPage,
      endPage: chunk.endPage,
      keywords: chunk.keywords,
      tokenEstimate: chunk.tokenEstimate,
      charCount: chunk.charCount
    }))
  };

  const { report, wasUpdated } = await upsertReport(reportRecord, options.storePath);

  return {
    report,
    storePath: resolveStorePath(options.storePath),
    wasUpdated,
    chunkCount: report.chunks.length,
    checksum
  };
}
