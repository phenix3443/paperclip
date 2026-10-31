import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('.github/scripts/check-pr-lockfile.mjs');
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'merged-lockfile-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, {cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-b','root'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid'); git('config','commit.gpgsign','false');
  const commit = text => {writeFileSync(join(cwd,'pnpm-lock.yaml'),text);git('add','.');git('commit','-m','fixture');return git('rev-parse','HEAD');};
  commit('root\n'); git('checkout','-b','mirror'); const trusted=commit('upstream\n');
  git('checkout','-b','develop','root');writeFileSync(join(cwd,'fork.txt'),'fork');git('add','.');git('commit','-m','fork');const base=git('rev-parse','HEAD');
  const run = (trust=trusted) => spawnSync(process.execPath,[script,'--origin',base,git('rev-parse','HEAD'),trust],{cwd,encoding:'utf8'});
  return {git,commit,run,trusted};
}
test('accepts exact lock bytes inherited from a real trusted merge',t=>{const h=fixture(t);h.git('merge','--no-ff','mirror','-m','merge');assert.equal(h.run().status,0);});
test('rejects local lock edits after a trusted merge',t=>{const h=fixture(t);h.git('merge','--no-ff','mirror','-m','merge');h.commit('local\n');assert.equal(h.run().status,1);});
test('rejects copied upstream lock bytes without upstream ancestry',t=>{const h=fixture(t);h.commit('upstream\n');assert.equal(h.run().status,1);});
test('rejects PR-controlled symbolic trust',t=>{const h=fixture(t);h.git('merge','--no-ff','mirror','-m','merge');assert.equal(h.run('mirror').status,1);});
