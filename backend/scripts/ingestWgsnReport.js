#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { ingestWgsnReport } from '../src/wgsn/wgsnIngestion.js';

function printUsage() {
  console.log(`Ingest a WGSN PDF report into the local knowledge store.

Usage:
  node backend/scripts/ingestWgsnReport.js --file <path-to-pdf> [options]

Options:
  --file, -f             Absolute or relative path to the PDF report (required)
  --title                Optional friendly title to override the PDF metadata title
  --tags                 Comma-separated tags (e.g. "menswear,denim,fw24")
  --store                Override the destination JSON store (defaults to backend/data/wgsnReports.json)
  --chunk-size           Target characters per chunk (default 1400)
  --min-chunk-size       Minimum characters to flush the final chunk (default 400)
  --overlap              Number of sentences to overlap between chunks (default 2)
  --help, -h             Show this help text
`);
}

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    switch (token) {
      case '--file':
      case '-f':
        args.file = argv[++i];
        break;
      case '--title':
        args.title = argv[++i];
        break;
      case '--tags':
        args.tags = argv[++i];
        break;
      case '--store':
        args.storePath = argv[++i];
        break;
      case '--chunk-size':
        args.chunkSize = Number(argv[++i]);
        break;
      case '--min-chunk-size':
        args.minChunkSize = Number(argv[++i]);
        break;
      case '--overlap':
        args.overlapSentences = Number(argv[++i]);
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        // Ignore unknown tokens but allow positional paths.
        if (!token.startsWith('-') && !args.file) {
          args.file = token;
        }
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (!args.file) {
    printUsage();
    console.error('\nError: --file argument is required.');
    process.exit(1);
  }

  try {
    const result = await ingestWgsnReport(args.file, {
      title: args.title,
      tags: args.tags,
      storePath: args.storePath,
      chunkSize: Number.isFinite(args.chunkSize) ? args.chunkSize : undefined,
      minChunkSize: Number.isFinite(args.minChunkSize) ? args.minChunkSize : undefined,
      overlapSentences: Number.isFinite(args.overlapSentences) ? args.overlapSentences : undefined
    });

    const relativeStore = path.relative(process.cwd(), result.storePath);
    console.log(
      `${result.wasUpdated ? 'Updated' : 'Ingested'} WGSN report "${result.report.title}" ` +
      `(chunks: ${result.chunkCount})`
    );
    console.log(`Stored in: ${relativeStore}`);
  } catch (error) {
    console.error('Failed to ingest WGSN report:', error.message);
    process.exit(1);
  }
}

main();
