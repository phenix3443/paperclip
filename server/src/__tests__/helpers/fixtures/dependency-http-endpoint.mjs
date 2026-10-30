import http from "node:http";
import fs from "node:fs";

const pending = new Map();
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const accepted = { runId: body.runId, agentId: body.agentId };
  fs.appendFileSync(process.env.PAPERCLIP_TEST_ACCEPTANCE_PATH, JSON.stringify(accepted) + "\n");
  pending.set(body.runId, response);
  process.send?.({ type: "accepted", ...accepted });
});
process.on("message", message => {
  if (message.type === "reply") {
    pending.get(message.runId)?.writeHead(200, { "content-type": "application/json" }).end("{}");
    pending.delete(message.runId);
  }
});
server.listen(0, "127.0.0.1", () => process.send?.({ type: "ready", port: server.address().port }));
