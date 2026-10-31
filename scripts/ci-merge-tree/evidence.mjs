import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const FIELDS = Object.freeze({
  companies: ['id', 'created_at', 'updated_at'],
  agents: ['id', 'company_id', 'status', 'created_at', 'updated_at'],
  issues: ['id', 'company_id', 'assignee_agent_id', 'parent_id', 'status', 'conversation_state', 'created_at', 'updated_at'],
  issue_comments: ['id', 'company_id', 'issue_id', 'author_agent_id', 'author_user_id', 'created_by_run_id', 'author_type', 'conversation_session_generation', 'created_at', 'updated_at'],
  heartbeat_runs: ['id', 'company_id', 'agent_id', 'issue_id', 'retry_of_run_id', 'status', 'error_code', 'exit_code', 'started_at', 'finished_at', 'created_at'],
  chat_endpoints: ['id', 'company_id', 'assigned_agent_id', 'status', 'created_at', 'updated_at'],
  chat_conversations: ['id', 'company_id', 'endpoint_id', 'issue_id', 'state', 'created_at', 'updated_at'],
  chat_message_links: ['id', 'company_id', 'endpoint_id', 'conversation_id', 'comment_id', 'delivery_id', 'publication_id', 'direction', 'created_at'],
  chat_deliveries: ['id', 'company_id', 'endpoint_id', 'conversation_id', 'state', 'created_at', 'updated_at'],
  chat_actions: ['id', 'company_id', 'endpoint_id', 'conversation_id', 'delivery_id', 'status', 'created_at', 'updated_at'],
  chat_publications: ['id', 'company_id', 'endpoint_id', 'conversation_id', 'issue_id', 'comment_id', 'state', 'created_at', 'updated_at'],
});
const STATES = new Set(['active', 'idle', 'waiting', 'completed', 'failed', 'cancelled', 'running',
  'pending', 'queued', 'received', 'processing', 'processed', 'retry', 'in_progress', 'in_review',
  'backlog', 'todo', 'done', 'blocked', 'paused', 'archived', 'revoked', 'awaiting_consent', 'streaming',
  'user', 'agent', 'system', 'succeeded', 'timed_out', 'interrupted', 'draft', 'verifying', 'attention',
  'unavailable', 'endpoint_removed', 'filtered', 'published', 'delivery_unknown', 'issued', 'inbound', 'outbound']);
const ERROR_CODES = new Set(JSON.parse(readFileSync(new URL('./error-codes.json', import.meta.url), 'utf8')));

export function projectFixture() {
  const aliases = new Map();
  const alias = value => {
    if (value === null || value === undefined) return null;
    const key = String(value);
    if (!aliases.has(key)) aliases.set(key, `fixture-${aliases.size + 1}`);
    return aliases.get(key);
  };
  return (table, rows) => {
    if (!FIELDS[table]) throw new Error('projection_table_denied');
    return rows.map(row => Object.fromEntries(FIELDS[table].filter(key => key in row).map(key => {
      const value = row[key];
      if (key === 'id' || key.endsWith('_id')) return [key, alias(value)];
      if (value === null) return [key, null];
      if (key === 'exit_code' || key === 'conversation_session_generation') return [key, Number.isSafeInteger(value) ? value : '[redacted]'];
      if (key === 'error_code') return [key, ERROR_CODES.has(value) ? value : { redacted: true, alias: alias(value) }];
      if (key.endsWith('_at')) {
        const date = new Date(value);
        return [key, Number.isNaN(date.getTime()) ? '[redacted]' : date.toISOString()];
      }
      return [key, STATES.has(value) ? value : '[redacted]'];
    })));
  };
}

export function safeLog(input, sourceFiles = new Set()) {
  return String(input).split(/\r?\n/).map(line => {
    const signatures = [];
    if (/lock timeout/i.test(line)) signatures.push('lock_timeout');
    if (/deadlock detected/i.test(line)) signatures.push('deadlock_detected');
    if (/AssertionError|expect\(|expected|toBe\(|toEqual\(|toMatchObject\(/i.test(line)) signatures.push('assertion_failure');
    if (/timeout|timed out/i.test(line)) signatures.push('timeout');
    for (const code of ['ERR_PNPM_OUTDATED_LOCKFILE', 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH', 'ERR_PNPM_FETCH_404', 'ERR_PNPM_FETCH_403', 'ERR_PNPM_NO_MATCHING_VERSION']) {
      if (line.includes(code)) signatures.push(code);
    }
    const locations = [...line.matchAll(/(?:server|tests|packages|scripts)\/[A-Za-z0-9_./-]+\.(?:ts|mjs|js):\d+(?::\d+)?/g)]
      .map(match => match[0]).filter(value => sourceFiles.has(value.replace(/:\d+(?::\d+)?$/, '')));
    return JSON.stringify({ signatures, locations, redactedCharacters: line.length });
  }).join('\n');
}

export function sealStage(root, limit = 100 * 1024 * 1024) {
  const allowed = new Set(['identity.json', 'environment.json', 'commands.json', 'selection.json',
    'database.jsonl', 'status.json', 'instrumentation.json', 'capture-gaps.json', 'projection.jsonl', 'assertions.jsonl',
    'stdout.jsonl', 'stderr.jsonl', 'service-stdout.jsonl', 'service-stderr.jsonl', 'trace.zip', 'report.json', 'report.html']);
  let size = 0;
  const files = [];
  for (const name of readdirSync(root).sort()) {
    if (name === 'manifest.json') {
      const prior = lstatSync(path.join(root, name));
      if (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1) throw new Error('stage_file_denied');
      continue;
    }
    if (!allowed.has(name)) throw new Error('stage_entry_denied');
    const file = path.join(root, name);
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('stage_file_denied');
    size += info.size;
    if (size > limit) throw new Error('stage_cap_exceeded');
    files.push({ name, size: info.size, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
  }
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schema: 1, bytes: size, files }, null, 2));
  return files;
}
