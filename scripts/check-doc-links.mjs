#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'test-results']);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (ignoredDirectories.has(entry.name)) return [];
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolutePath);
    return entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? [absolutePath] : [];
  });
}

function headingAnchors(markdown) {
  const counts = new Map();
  const anchors = new Set();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const base = match[2]
      .replace(/<[^>]+>/g, '')
      .replace(/[`*_~]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s/g, '-');
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  }
  return anchors;
}

const markdownFiles = [
  'README.md',
  'CODING_STANDARDS.md',
  'AGENTS.md',
].map((relativePath) => path.join(repoRoot, relativePath)).filter(fs.existsSync).concat(
  walk(path.join(repoRoot, 'docs')),
  walk(path.join(repoRoot, 'load-testing')),
  walk(path.join(repoRoot, 'meteorjs_migration')),
  walk(path.join(repoRoot, 'production_setup')),
  walk(path.join(repoRoot, 'ssoserver')),
);
const anchorsByFile = new Map();
const errors = [];

for (const markdownPath of markdownFiles) {
  const markdown = fs.readFileSync(markdownPath, 'utf8');
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(markdown)) !== null) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.split(/\s+["']/)[0];
    if (!target || /^(?:https?:|mailto:|tel:)/i.test(target)) continue;

    const [rawFilePart, rawFragment = ''] = target.split('#', 2);
    let filePart;
    let fragment;
    try {
      filePart = decodeURIComponent(rawFilePart);
      fragment = decodeURIComponent(rawFragment).toLowerCase();
    } catch {
      errors.push(`${path.relative(repoRoot, markdownPath)}: invalid URL encoding in ${target}`);
      continue;
    }

    const targetPath = filePart
      ? path.resolve(path.dirname(markdownPath), filePart)
      : markdownPath;
    if (!fs.existsSync(targetPath)) {
      errors.push(`${path.relative(repoRoot, markdownPath)}: missing ${target}`);
      continue;
    }

    if (fragment && fs.statSync(targetPath).isFile() && targetPath.toLowerCase().endsWith('.md')) {
      if (!anchorsByFile.has(targetPath)) {
        anchorsByFile.set(targetPath, headingAnchors(fs.readFileSync(targetPath, 'utf8')));
      }
      if (!anchorsByFile.get(targetPath).has(fragment)) {
        errors.push(`${path.relative(repoRoot, markdownPath)}: missing heading #${fragment} in ${path.relative(repoRoot, targetPath)}`);
      }
    }
  }
}

if (errors.length) {
  console.error(`Documentation link check failed (${errors.length}):`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(`Documentation link check passed (${markdownFiles.length} Markdown files).`);
}
