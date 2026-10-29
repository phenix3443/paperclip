import assert from 'node:assert/strict';

export const snapshotSql = `with recursive activity as materialized (
  select pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) as blockers
  from pg_stat_activity where pid <> pg_backend_pid()
), relevant(pid) as (
  select pid from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()
  union select unnest(a.blockers) from activity a join relevant r on r.pid = a.pid
), groups as (
  select l.pid, l.locktype, l.mode, l.granted, count(*)::int as count
  from pg_locks l join relevant r on r.pid = l.pid
  group by l.pid, l.locktype, l.mode, l.granted
), ranked as (
  select *, row_number() over (partition by pid order by locktype, mode, granted) as position from groups
), limited as (select pid from relevant order by pid limit 128)
select (select count(*)::int from relevant) as total,
  coalesce(jsonb_agg(jsonb_build_object('pid', r.pid, 'state', a.state,
    'wait_event_type', a.wait_event_type, 'wait_event', a.wait_event, 'blockers', a.blockers,
    'lockGroupTotal', (select count(*)::int from groups g where g.pid = r.pid),
    'lockGroups', coalesce((select jsonb_agg(jsonb_build_object('locktype', g.locktype, 'mode', g.mode, 'granted', g.granted, 'count', g.count) order by g.position)
      from ranked g where g.pid = r.pid and g.position <= 32), '[]'::jsonb)) order by r.pid), '[]'::jsonb) as records
from limited r left join activity a on a.pid = r.pid`;

const technical = (value) => value === null || (typeof value === 'string' && /^[A-Za-z0-9_ ()-]{1,80}$/.test(value));
const keys = (value, allowed) => value && Object.keys(value).every((key) => allowed.includes(key));
export function validateSnapshot(snapshot) {
  assert.ok(keys(snapshot, ['total', 'records']));
  assert.ok(Number.isSafeInteger(snapshot.total) && snapshot.total >= 0);
  assert.ok(Array.isArray(snapshot.records) && snapshot.records.length <= 128);
  const pids = new Set();
  for (const row of snapshot.records) {
    assert.ok(keys(row, ['pid', 'state', 'wait_event_type', 'wait_event', 'blockers', 'lockGroupTotal', 'lockGroups']));
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0 && !pids.has(row.pid));pids.add(row.pid);
    assert.ok(['active', 'idle', 'idle in transaction', 'idle in transaction (aborted)', 'fastpath function call', 'disabled'].includes(row.state));
    for (const name of ['state', 'wait_event_type', 'wait_event']) assert.ok(technical(row[name]));
    assert.ok(Array.isArray(row.blockers) && row.blockers.length <= 128 && row.blockers.every((pid) => Number.isSafeInteger(pid) && pid >= 0));
    assert.ok(Number.isSafeInteger(row.lockGroupTotal) && row.lockGroupTotal >= 0);
    assert.ok(Array.isArray(row.lockGroups) && row.lockGroups.length <= 32 && row.lockGroups.length <= row.lockGroupTotal);
    const groups = new Set();
    for (const group of row.lockGroups) {
      assert.ok(keys(group, ['locktype', 'mode', 'granted', 'count']));
      assert.ok(typeof group.locktype === 'string' && technical(group.locktype));
      assert.ok(typeof group.mode === 'string' && technical(group.mode));
      assert.equal(typeof group.granted, 'boolean');
      assert.ok(Number.isSafeInteger(group.count) && group.count > 0);
      const identity = JSON.stringify([group.locktype, group.mode, group.granted]);
      assert.ok(!groups.has(identity));groups.add(identity);
    }
  }
  const returned = snapshot.records.length;
  const lockGroupTotal = snapshot.records.reduce((sum, row) => sum + row.lockGroupTotal, 0);
  const lockGroupReturned = snapshot.records.reduce((sum, row) => sum + row.lockGroups.length, 0);
  const missingBlockers = [...new Set(snapshot.records.flatMap((row) => row.blockers).filter((pid) => !pids.has(pid)))].sort((a,b) => a-b);
  assert.ok(returned <= snapshot.total && lockGroupReturned <= lockGroupTotal);
  return { total: snapshot.total, returned, lockGroupTotal, lockGroupReturned, missingBlockers,
    complete: returned === snapshot.total && lockGroupReturned === lockGroupTotal && missingBlockers.length === 0,
    records: snapshot.records };
}
