import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { searchWgsnReports } from './wgsnSearch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SNIPPET_DIR = path.resolve(__dirname, '../../data/wgsn_snippets');

async function ensureSnippetDir() {
  await fs.mkdir(SNIPPET_DIR, { recursive: true });
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeSnippetName(reportId, pageNumbers) {
  const rangeLabel = pageNumbers.join('_');
  const hash = crypto.createHash('md5').update(`${reportId}-${rangeLabel}`).digest('hex').slice(0, 8);
  return `${reportId}-${rangeLabel}-${hash}.pdf`;
}

function normalizeSnippetText(text, limit = 320) {
  if (!text) {
    return '';
  }

  let result = text;
  let previous;
  const pattern = /\b([A-Za-z])\s+(?=[A-Za-z]\b)/g;
  do {
    previous = result;
    result = result.replace(pattern, '$1');
  } while (result !== previous);

  result = result.replace(/\s+/g, ' ').trim();

  if (result.length > limit) {
    return `${result.slice(0, limit - 1).trim()}…`;
  }

  return result;
}

function formatPageRanges(pageNumbers) {
  if (!pageNumbers?.length) {
    return '';
  }

  const ranges = [];
  let start = pageNumbers[0];
  let prev = pageNumbers[0];

  for (let i = 1; i < pageNumbers.length; i += 1) {
    const current = pageNumbers[i];
    if (current === prev + 1) {
      prev = current;
      continue;
    }

    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = current;
    prev = current;
  }

  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges.join(', ');
}

function collectPageNumbers(entries, maxPages) {
  const pageSet = new Set();

  for (const entry of entries) {
    const startPage = Math.max(1, entry.startPage || entry.start_page || entry.start || 0);
    const endPage = Math.max(startPage, entry.endPage || entry.end_page || entry.end || startPage);

    for (let page = startPage; page <= endPage; page += 1) {
      pageSet.add(page);
      if (pageSet.size >= maxPages) {
        return Array.from(pageSet).sort((a, b) => a - b);
      }
    }
  }

  return Array.from(pageSet).sort((a, b) => a - b);
}

async function createSnippetPdf(reportId, sourcePath, pageNumbers) {
  if (!sourcePath) {
    return null;
  }

  await ensureSnippetDir();
  const sanitizedName = sanitizeSnippetName(reportId, pageNumbers);
  const snippetPath = path.join(SNIPPET_DIR, sanitizedName);

  if (!(await fileExists(snippetPath))) {
    const pdfBytes = await fs.readFile(sourcePath);
    const sourceDoc = await PDFDocument.load(pdfBytes);
    const snippetDoc = await PDFDocument.create();
    const zeroBasedPages = pageNumbers
      .map(page => Math.max(0, page - 1))
      .filter((value, index, arr) => arr.indexOf(value) === index)
      .sort((a, b) => a - b);
    let copiedPages;
    try {
      copiedPages = await snippetDoc.copyPages(sourceDoc, zeroBasedPages);
    } catch (error) {
      console.warn(`Failed to copy pages for ${reportId}:`, error.message);
      return null;
    }
    copiedPages.forEach(page => {
      snippetDoc.addPage(page);
    });

    const snippetBytes = await snippetDoc.save();
    await fs.writeFile(snippetPath, snippetBytes);
  }

  const buffer = await fs.readFile(snippetPath);
  return {
    snippetPath,
    base64: buffer.toString('base64'),
    sizeBytes: buffer.length
  };
}

function groupResultsByReport(results) {
  const grouped = new Map();
  for (const result of results) {
    if (!result.reportId) {
      continue;
    }
    if (!grouped.has(result.reportId)) {
      grouped.set(result.reportId, []);
    }
    grouped.get(result.reportId).push(result);
  }
  return grouped;
}

export async function buildWgsnEvidencePackage(query, options = {}) {
  const searchLimit = options.searchLimit ?? 6;
  const maxReports = options.maxReports ?? 2;
  const maxChunksPerReport = options.maxChunksPerReport ?? 2;
  const maxPagesPerReport = options.maxPagesPerReport ?? 4;

  const results = await searchWgsnReports(query, { limit: searchLimit });
  if (!results || results.length === 0) {
    return null;
  }

  const grouped = groupResultsByReport(results);
  const attachments = [];
  const summaryBlocks = [];

  for (const [reportId, entries] of grouped.entries()) {
    if (attachments.length >= maxReports) {
      break;
    }

    const sortedEntries = entries.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const selectedEntries = sortedEntries.slice(0, maxChunksPerReport);
    const pageNumbers = collectPageNumbers(selectedEntries, maxPagesPerReport);

    if (!pageNumbers.length) {
      continue;
    }

    const sourcePath = sortedEntries[0]?.sourcePath;
    const title = sortedEntries[0]?.reportTitle || 'WGSN Report';

    const snippet = await createSnippetPdf(reportId, sourcePath, pageNumbers);
    if (!snippet) {
      continue;
    }

    attachments.push({
      reportId,
      title,
      pageNumbers,
      inlineData: {
        mimeType: 'application/pdf',
        data: snippet.base64
      }
    });

    const bulletLines = selectedEntries
      .map(entry => normalizeSnippetText(entry.text))
      .filter(Boolean)
      .map(text => `• ${text}`);

    summaryBlocks.push(
      [`Report: ${title} (pages ${formatPageRanges(pageNumbers)})`, ...bulletLines].join('\n')
    );
  }

  if (!attachments.length) {
    return null;
  }

  const hintLines = attachments.map(
    attachment => `- ${attachment.title} (pages ${formatPageRanges(attachment.pageNumbers)})`
  );

  return {
    inlineParts: attachments.map(attachment => ({ inlineData: attachment.inlineData })),
    hintText: `Attached ${attachments.length} WGSN PDF excerpt(s):\n${hintLines.join('\n')}`,
    summaryBlock: summaryBlocks.join('\n\n'),
    attachments
  };
}
