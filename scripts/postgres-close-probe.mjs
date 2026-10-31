import net from 'node:net';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const postgres = (await import(pathToFileURL(process.argv[2]))).default;
const closeFirst = process.argv[3] !== 'live';
const sockets = new Set();
const auth = Buffer.from('5200000008000000005a0000000549', 'hex');
const reply = Buffer.from('3100000004320000000454000000060000430000000d53454c4543542030005a0000000549', 'hex');
const server = net.createServer(s => {
  sockets.add(s);
  let greeted = false;
  s.on('data', () => { s.write(greeted ? reply : auth); greeted = true; });
  s.on('error', () => {});
  s.on('close', () => sockets.delete(s));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let notifyClose;
const closed = new Promise(r => { notifyClose = r; });
const sql = postgres({ host: '127.0.0.1', port: server.address().port,
  user: 'probe', database: 'probe', max: 1, connect_timeout: 2,
  idle_timeout: 0, onclose: notifyClose });
try {
  const reserved = await sql.reserve();
  if (closeFirst) {
    for (const s of sockets) s.destroy();
    await closed;
  }
  const result = await reserved.unsafe('select 1').then(
    () => 'OK', e => e.code);
  console.log(result);
  assert.equal(result, closeFirst ? 'CONNECTION_CLOSED' : 'OK');
  await new Promise(r => setImmediate(() => setImmediate(r)));
  reserved.release();
} finally {
  await sql.end({ timeout: 1 });
  for (const s of sockets) s.destroy();
  await new Promise(r => server.close(r));
}
