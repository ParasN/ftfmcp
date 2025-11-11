#!/usr/bin/env node

const { existsSync, mkdirSync, rmSync, cpSync } = require('node:fs');
const { resolve } = require('node:path');

const projectRoot = process.cwd();
const distDir = resolve(projectRoot, 'frontend/dist');
const publicDir = resolve(projectRoot, 'backend/public');

if (!existsSync(distDir)) {
  console.error('frontend/dist was not found. Run "npm run build --workspace=frontend" first.');
  process.exit(1);
}

rmSync(publicDir, { recursive: true, force: true });
mkdirSync(publicDir, { recursive: true });
cpSync(distDir, publicDir, { recursive: true });

console.log(`Copied frontend build assets from ${distDir} to ${publicDir}`);
