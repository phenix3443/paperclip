const net = require("node:net");
const readline = require("node:readline");

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const holds = new Set((process.env.GATE_HOLD || "").split(",").filter(Boolean));
const held = { initialize: [], shutdown: [] };
const released = new Set();
if (process.env.GATE_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => {});

const control = net.createConnection(process.env.GATE_SOCKET);
const report = (event) => control.write(`${JSON.stringify({ event, pid: process.pid })}\n`);
report("spawned");
readline.createInterface({ input: control }).on("line", (line) => {
  const { release, crash } = JSON.parse(line);
  if (crash) process.exit(1);
  if (!release) return;
  released.add(release);
  for (const reply of held[release].splice(0)) reply();
});

let hostCalls = 0;
const hostPending = new Map();
function callHost(method, params) {
  const id = `host-${++hostCalls}`;
  return new Promise((resolve, reject) => {
    hostPending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function getData(message) {
  const { key, params = {} } = message.params || {};
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  const fail = (error) => send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error && error.message) } });
  const stateParams = { scopeKind: "instance", stateKey: "kept" };
  if (key === "state-write") callHost("state.set", { ...stateParams, value: params.value }).then(() => reply({ written: true }), fail);
  else if (key === "state-read") callHost("state.get", stateParams).then((value) => reply({ value }), fail);
  else reply({ marker: process.env.BUNDLE_MARKER || null });
}

function gate(name, reply) {
  report(`${name}-received`);
  if (!holds.has(name) || released.has(name)) reply();
  else held[name].push(reply);
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (!message.method && hostPending.has(message.id)) {
    const pending = hostPending.get(message.id);
    hostPending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  } else if (message.method === "initialize") {
    gate("initialize", () => {
      report("initialize-replied");
      send({ jsonrpc: "2.0", id: message.id, result: { ok: true, supportedMethods: ["getData"] } });
    });
  } else if (message.method === "shutdown") {
    gate("shutdown", () => {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
      report("shutdown-replied");
      process.exit(0);
    });
  } else if (message.method === "getData") {
    getData(message);
  } else if (message.id !== undefined && message.method) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32004, message: `${message.method} not implemented` } });
  }
});
