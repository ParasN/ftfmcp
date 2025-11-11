import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_STORE_PATH = (() => {
  const configured = process.env.WGSN_REPORT_STORE;
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(__dirname, '../../', configured);
  }
  return path.resolve(__dirname, '../../data/wgsnReports.json');
})();

export const WGSN_STORE_SCHEMA_VERSION = 1;

async function ensureParentDir(targetPath) {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
}

async function ensureStoreFile(storePath = DEFAULT_STORE_PATH) {
  try {
    await fs.access(storePath);
  } catch {
    await ensureParentDir(storePath);
    const now = new Date().toISOString();
    const initialPayload = {
      schemaVersion: WGSN_STORE_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      reports: []
    };
    await fs.writeFile(storePath, JSON.stringify(initialPayload, null, 2), 'utf-8');
  }
}

export function resolveStorePath(customPath) {
  return customPath ? path.resolve(customPath) : DEFAULT_STORE_PATH;
}

export async function readStore(storePath = DEFAULT_STORE_PATH) {
  const resolvedPath = resolveStorePath(storePath);
  await ensureStoreFile(resolvedPath);
  const raw = await fs.readFile(resolvedPath, 'utf-8');
  const parsed = JSON.parse(raw);

  return {
    schemaVersion: parsed.schemaVersion || WGSN_STORE_SCHEMA_VERSION,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    reports: Array.isArray(parsed.reports) ? parsed.reports : []
  };
}

export async function writeStore(store, storePath = DEFAULT_STORE_PATH) {
  const resolvedPath = resolveStorePath(storePath);
  await ensureParentDir(resolvedPath);
  const now = new Date().toISOString();
  const payload = {
    schemaVersion: WGSN_STORE_SCHEMA_VERSION,
    createdAt: store.createdAt || now,
    updatedAt: now,
    reports: store.reports || []
  };

  await fs.writeFile(resolvedPath, JSON.stringify(payload, null, 2), 'utf-8');
  return payload;
}

export async function upsertReport(report, storePath = DEFAULT_STORE_PATH) {
  const store = await readStore(storePath);
  const nextReports = [...store.reports];
  const existingIndex = nextReports.findIndex(existing =>
    (report.checksum && existing.checksum === report.checksum) ||
    existing.id === report.id
  );

  let wasUpdated = false;

  if (existingIndex >= 0) {
    nextReports[existingIndex] = report;
    wasUpdated = true;
  } else {
    nextReports.push(report);
  }

  await writeStore(
    {
      ...store,
      reports: nextReports
    },
    storePath
  );

  return {
    report,
    wasUpdated
  };
}

export async function listReports(storePath = DEFAULT_STORE_PATH) {
  const store = await readStore(storePath);
  return store.reports;
}

export async function getReportById(reportId, storePath = DEFAULT_STORE_PATH) {
  if (!reportId) {
    return null;
  }

  const reports = await listReports(storePath);
  return reports.find(report => report.id === reportId) || null;
}
