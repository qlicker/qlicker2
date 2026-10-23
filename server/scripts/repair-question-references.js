#!/usr/bin/env node
import mongoose from 'mongoose';
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import Session from '../src/models/Session.js';
import Course from '../src/models/Course.js';
import {
  repairSessionQuestionReferences, getQuestionRepairActions, applyQuestionRepairDecision,
} from '../src/services/questionReferenceRepair.js';

const cleanText = (value) => String(value || '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

function parseArgs(argv) {
  const options = { apply: false, interactive: false, json: false, filter: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--apply') options.apply = true;
    else if (arg === '--interactive') options.interactive = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--session' || arg === '--course') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires an ID`);
      options.filter[arg === '--session' ? '_id' : 'courseId'] = value;
    } else throw new Error('Unknown command option. Run with --help.');
  }
  if (options.interactive && (options.json || options.apply)) throw new Error('Interactive mode cannot be combined with --json or --apply.');
  return options;
}

export function formatQuestionRepairReport(report, index) {
  const duplicates = (report.replacements || []).filter((item) => item.reason === 'duplicate').map((item) => item.position);
  const foreign = (report.replacements || []).filter((item) => item.reason === 'foreign').map((item) => item.position);
  const lines = [
    `${index}. Course: ${cleanText(report.courseName)}${report.courseDetails ? ` (${cleanText(report.courseDetails)})` : ''}`,
    `   Session: ${cleanText(report.sessionName)} [${cleanText(report.sessionStatus)}]`,
    `   Course ID: ${cleanText(report.courseId)} | Session ID: ${cleanText(report.sessionId)}`,
  ];
  if (duplicates.length) lines.push(`   Repeated question positions: ${duplicates.join(', ')}. These positions share an answer with an earlier question.`);
  if (foreign.length) lines.push(`   Questions borrowed by reference from a library/another session: positions ${foreign.join(', ')}.`);
  if (report.missingIds?.length) lines.push(`   Missing question documents: ${report.missingIds.length}. Restore or recreate the missing content before repair.`);
  lines.push(`   History: ${report.responseCount || 0} response records on these questions; ${report.gradeCount || 0} linked grade records.`);
  lines.push(report.status === 'would-repair'
    ? '   Ready to create independent copies: unused hidden session.'
    : '   Review the repair and grading choices before changing this session.');
  return lines.join('\n');
}

export async function runInteractiveRepairs(reports, { ask, write = console.log } = {}) {
  let repaired = 0;
  let skipped = 0;
  for (let index = 0; index < reports.length; index += 1) {
    const report = reports[index];
    write(`\n${formatQuestionRepairReport(report, index + 1)}`);
    const state = await getQuestionRepairActions(report.sessionId);
    if (state.report.status === 'unchanged') { write('Already repaired; skipping.'); continue; }
    const labels = {
      copy: 'Create independent question copies. Preserve positions and points; no answers or grades are changed.',
      'remove-keep-grades': 'Remove repeated positions; keep the first occurrence and its answers. Keep all stored grades exactly as they are. Totals may still reflect the old question count until reviewed.',
      'remove-recalculate': 'Remove repeated positions and recalculate automatic grades for the reduced question count. Preserve manual marks and manual overall grades. Automatic totals and participation can change.',
    };
    if (state.questionIds) {
      const removed = state.questionIds.length - new Set(state.questionIds).size;
      if (removed) write(`Removing duplicates changes the session from ${state.questionIds.length} positions to ${state.questionIds.length - removed}.`);
    }
    for (const block of state.blocks || []) write(block);
    if (!state.actions.length) {
      write('No automatic repair is available. Shared answers across sessions or missing content require individual review.');
      skipped += 1;
      continue;
    }
    state.actions.forEach((action, choice) => write(`  ${choice + 1}) ${labels[action]}`));
    write('  0) Skip this session (default)\n  q) Quit');
    let choice;
    while (true) {
      const answer = (await ask('Choice: ')).trim().toLowerCase();
      if (answer === 'q') return { repaired, skipped: skipped + reports.length - index };
      if (!answer || answer === '0') break;
      if (/^[1-9]\d*$/.test(answer) && Number(answer) <= state.actions.length) {
        choice = state.actions[Number(answer) - 1];
        break;
      }
      write('Choose a listed number, 0 to skip, or q to quit.');
    }
    if (!choice) { skipped += 1; continue; }
    write(`Selected: ${labels[choice]}`);
    const confirmation = await ask(`Type REPAIR to change "${cleanText(report.sessionName)}" in "${cleanText(report.courseName)}": `);
    if (confirmation.trim() !== 'REPAIR') { write('Skipped.'); skipped += 1; continue; }
    const result = await applyQuestionRepairDecision({
      sessionId: report.sessionId, action: choice, expectedQuestionIds: state.questionIds,
    });
    if (result.status !== 'repaired') {
      write('The session changed or is no longer eligible. Stop and run the diagnostic again before reopening the app.');
      return { repaired, skipped, failed: true };
    }
    repaired += 1;
    write('Repair completed.');
    for (const warning of result.grading?.warnings || []) write(`Grading: ${warning}`);
  }
  return { repaired, skipped };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/repair-question-references.js [--interactive] [--session ID] [--course ID] [--json]');
    console.log('Default: read-only diagnostic of all sessions with course/session names.');
    console.log('Production: use ./repair-question-references.sh from production_setup.');
    console.log('--apply remains available for unattended repair of unused hidden drafts only.');
    return;
  }
  for (const relative of ['../../.env', '../.env']) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) { loadEnv({ path, quiet: true }); break; }
  }
  const uri = process.env.MONGO_URI
    || (process.env.MONGO_PORT ? `mongodb://localhost:${process.env.MONGO_PORT}/qlicker` : '');
  if (!uri) throw new Error('Set MONGO_URI or MONGO_PORT.');
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const summary = { mode: options.apply ? 'apply' : 'dry-run', scanned: 0, statuses: {} };
  const affected = [];
  const courseCache = new Map();
  try {
    if (!options.json) console.log('Scanning all matching sessions for duplicate or foreign question references...');
    for await (const session of Session.collection.find(options.filter, { projection: { _id: 1 } })) {
      const report = await repairSessionQuestionReferences({ sessionId: session._id, apply: options.apply });
      summary.scanned += 1;
      summary.statuses[report.status] = (summary.statuses[report.status] || 0) + 1;
      if (report.status === 'unchanged') continue;
      if (!courseCache.has(report.courseId)) {
        courseCache.set(report.courseId, await Course.collection.findOne({ _id: report.courseId }));
      }
      const course = courseCache.get(report.courseId);
      report.courseName = course?.name || '(course document missing)';
      report.courseDetails = [course?.deptCode, course?.courseNumber, course?.section, course?.semester].filter(Boolean).join(' ');
      affected.push(report);
      console.log(options.json ? JSON.stringify(report) : `\n${formatQuestionRepairReport(report, affected.length)}`);
    }
    if (options.json) console.log(JSON.stringify({ summary }));
    else {
      console.log(`\nScanned ${summary.scanned} sessions. Found ${affected.length} ${affected.length === 1 ? 'session' : 'sessions'} needing review.`);
      if (!affected.length) console.log('No duplicate or foreign question references found.');
      if (!options.apply && !options.interactive) console.log('Diagnostic only: no data was changed.');
    }
    if (options.interactive && affected.length) {
      console.log('\nHistorical shared answers cannot be separated by position. Choose how each assessment should count them.');
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const result = await runInteractiveRepairs(affected, { ask: (prompt) => terminal.question(prompt) });
        console.log(`\nRepaired ${result.repaired}; skipped ${result.skipped}. Run the diagnostic again to review remaining cases.`);
        if (result.failed || result.skipped) process.exitCode = 2;
      } finally { terminal.close(); }
    } else if ((options.json || options.apply) && (!summary.scanned || summary.statuses['manual-review'] || summary.statuses.conflict)) {
      process.exitCode = 2;
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    console.error(`Operation failed (${error.name}). If repairing, keep the app offline: some automatic grades may have been updated. Run the diagnostic again before retrying.`);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}
