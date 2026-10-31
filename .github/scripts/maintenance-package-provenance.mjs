import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = 'phenix3443/paperclip';
const repositoryId = 1420915320;
const ref = 'refs/heads/fix/maintenance-rework-151';
const workflowPath = '.github/workflows/deploy-packages.yml';

function requireMatch(condition, field) {
  if (!condition) throw new Error(`Invalid maintenance provenance: ${field}`);
}

export function maintenanceProvenance({ context, event, run, workflow, branch, jobs }) {
  requireMatch(context.repository === repository && context.repository_id === String(repositoryId), 'repository');
  requireMatch(context.event_name === 'push' && context.ref === ref && context.ref_protected === true, 'trusted protected push');
  requireMatch(/^[0-9a-f]{40}$/.test(context.sha), 'full source SHA');
  requireMatch(context.workflow_ref === `${repository}/${workflowPath}@${ref}` && context.workflow_sha === context.sha, 'workflow source');
  const runId = Number(context.run_id);
  const runAttempt = Number(context.run_attempt);
  requireMatch(/^[1-9][0-9]*$/.test(context.run_id) && Number.isSafeInteger(runId), 'run ID');
  requireMatch(/^[1-9][0-9]*$/.test(context.run_attempt) && Number.isSafeInteger(runAttempt), 'run attempt');
  for (const identity of [event.repository, run.repository, run.head_repository]) {
    requireMatch(identity?.id === repositoryId && identity?.full_name === repository, 'repository API identity');
  }
  requireMatch(event.ref === ref && event.after === context.sha && event.deleted === false, 'push payload');
  requireMatch(run.id === runId && run.run_attempt === runAttempt && run.event === 'push', 'run attempt API identity');
  requireMatch(run.head_sha === context.sha && run.head_branch === ref.slice('refs/heads/'.length), 'run source');
  requireMatch(run.path === workflowPath && workflow.path === workflowPath && run.workflow_id === workflow.id && Number.isSafeInteger(workflow.id) && workflow.id > 0, 'workflow API identity');
  requireMatch(branch.protected === true && branch.commit?.sha === context.sha, 'protected tip');
  const matchingJobs = jobs.filter(job => job.name === 'packages');
  requireMatch(matchingJobs.length === 1, 'attempt packages job');
  const job = matchingJobs[0];
  requireMatch(job.run_id === runId && job.head_sha === context.sha && job.status === 'in_progress' && Number.isSafeInteger(job.id) && job.id > 0, 'attempt job API identity');
  return {
    version: 1, repository, repositoryId, headRepositoryId: run.head_repository.id,
    ref, sha: context.sha, workflowPath, workflowSha: context.workflow_sha,
    workflowId: workflow.id, runId, runAttempt, jobId: job.id,
  };
}

async function githubApi(endpoint) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub provenance API ${endpoint}: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const env = process.env;
  const context = {
    repository: env.GITHUB_REPOSITORY, repository_id: env.GITHUB_REPOSITORY_ID,
    event_name: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF,
    ref_protected: env.GITHUB_REF_PROTECTED === 'true', sha: env.GITHUB_SHA,
    workflow_ref: env.GITHUB_WORKFLOW_REF, workflow_sha: env.GITHUB_WORKFLOW_SHA,
    run_id: env.GITHUB_RUN_ID, run_attempt: env.GITHUB_RUN_ATTEMPT,
  };
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  requireMatch(/^[1-9][0-9]*$/.test(context.run_id) && /^[1-9][0-9]*$/.test(context.run_attempt), 'run coordinates');
  const attemptPath = `actions/runs/${context.run_id}/attempts/${context.run_attempt}`;
  const [run, currentRun, workflow, branch, page] = await Promise.all([
    githubApi(attemptPath), githubApi(`actions/runs/${context.run_id}`),
    githubApi('actions/workflows/deploy-packages.yml'),
    githubApi('branches/fix%2Fmaintenance-rework-151'),
    githubApi(`${attemptPath}/jobs?per_page=100`),
  ]);
  requireMatch(currentRun.id === run.id && currentRun.run_attempt === run.run_attempt, 'current attempt');
  requireMatch(Array.isArray(page.jobs) && page.total_count === page.jobs.length, 'complete attempt job evidence');
  const provenance = maintenanceProvenance({ context, event, run, workflow, branch, jobs: page.jobs });
  const manifestPath = path.join(process.env.PACKAGES_DIR, 'payload-packages.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  requireMatch(manifest.repo === repository && manifest.sha === context.sha && !Object.hasOwn(manifest, 'ciProvenance'), 'native manifest');
  manifest.ciProvenance = provenance;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
