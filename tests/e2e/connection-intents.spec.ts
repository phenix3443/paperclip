import { expect, test, type APIRequestContext } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { listenOnFetchAllowedPort } from "./fetch-allowed-port";
import { send } from "./agent-chat.shared";

type Json = Record<string, unknown>;
type Seed = { companyId: string; prefix: string };
type Agent = { id: string; name: string };

async function json<T = Json>(
  response: Awaited<ReturnType<APIRequestContext["get"]>>,
): Promise<T> {
  expect(
    response.ok(),
    `${response.url()} failed ${response.status()}: ${await response.text()}`,
  ).toBe(true);
  return (await response.json()) as T;
}

async function newCompany(request: APIRequestContext): Promise<Seed> {
  const company = await json<{ id: string; issuePrefix: string }>(
    await request.post("/api/companies", {
      data: { name: `Connection intent E2E ${Date.now()}` },
    }),
  );
  return { companyId: company.id, prefix: company.issuePrefix };
}

async function createAgent(
  request: APIRequestContext,
  companyId: string,
  name: string,
): Promise<Agent> {
  return await json<Agent>(
    await request.post(`/api/companies/${companyId}/agents`, {
      data: {
        name,
        role: "qa",
        title: "Connection intent fixture agent",
        capabilities: "Exercises deterministic connection intent wiring.",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["--input-type=module", "-e", "process.exit(0)"],
        },
      },
    }),
  );
}

async function startFakeProvider() {
  const captures: Array<{ method: string; toolName: string | null }> = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const payload = JSON.parse(
      Buffer.concat(chunks).toString("utf8") || "{}",
    ) as {
      id?: string | number;
      method?: string;
      params?: { name?: string };
    };
    captures.push({
      method: String(payload.method ?? "<unknown>"),
      toolName: payload.params?.name ?? null,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (payload.method === "tools/list") {
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id ?? null,
          result: {
            tools: [
              {
                name: "notion:list_pages",
                title: "List fixture pages",
                description:
                  "Reads deterministic pages from the fake Notion provider.",
                inputSchema: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
              },
            ],
          },
        }),
      );
      return;
    }
    if (payload.method === "tools/call") {
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id ?? null,
          result: {
            content: [{ type: "text", text: "Fixture page inventory" }],
          },
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({ jsonrpc: "2.0", id: payload.id ?? null, result: {} }),
    );
  });
  const port = await listenOnFetchAllowedPort(server);
  return {
    url: `http://127.0.0.1:${port}/`,
    captures,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function connectionAwareScript(connectionId: string) {
  return `
const post = async (url, body, token = process.env.PAPERCLIP_RUNTIME_TOOLS_TOKEN) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: \`Bearer \${token}\`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(\`\${response.status}: \${await response.text()}\`);
  return await response.json();
};
const apiHeaders = { authorization: \`Bearer \${process.env.PAPERCLIP_API_KEY}\`, "content-type": "application/json", "x-paperclip-run-id": process.env.PAPERCLIP_RUN_ID };
const runResponse = await fetch(\`\${process.env.PAPERCLIP_API_URL}/api/heartbeat-runs/\${process.env.PAPERCLIP_RUN_ID}\`, { headers: apiHeaders });
if (!runResponse.ok) throw new Error(await runResponse.text());
const run = await runResponse.json();
const issueId = process.env.PAPERCLIP_TASK_ID ?? run.contextSnapshot.issueId;
if (!issueId) throw new Error("Missing task binding");
const search = await post(process.env.PAPERCLIP_RUNTIME_TOOLS_CONNECTIONS_SEARCH_URL, { query: "notion" });
const notion = search.results.find((result) => result.service === "notion");
if (!notion) throw new Error("Notion was not advertised");
if (notion.state !== "ready") throw new Error(\`Expected gateway access to make Notion ready, got \${notion.state}\`);
const requested = await post(process.env.PAPERCLIP_RUNTIME_TOOLS_CONNECTION_REQUEST_URL, { service: notion.service, connectionId: ${JSON.stringify(connectionId)}, toolNames: ["notion:list_pages"] });
if (requested.state !== "ready" || requested.interactionId !== null) throw new Error(\`Expected a ready request without a card, got \${JSON.stringify(requested)}\`);
const sessionResponse = await fetch(\`\${process.env.PAPERCLIP_API_URL}/api/tool-gateway/sessions\`, {
  method: "POST",
  headers: apiHeaders,
  body: JSON.stringify({ runId: process.env.PAPERCLIP_RUN_ID, ttlMs: 60000 })
});
if (!sessionResponse.ok) throw new Error(await sessionResponse.text());
const session = await sessionResponse.json();
const toolsResponse = await fetch(\`\${process.env.PAPERCLIP_API_URL}/api/tool-gateway/tools\`, {
  headers: { "x-paperclip-tool-gateway-token": session.token }
});
const tools = await toolsResponse.json();
const tool = tools.find((entry) => entry.connectionId === ${JSON.stringify(connectionId)} && entry.upstreamToolName === "notion:list_pages");
if (!tool) throw new Error("The run did not receive the gateway-allowed Notion tool");
const call = await fetch(\`\${process.env.PAPERCLIP_API_URL}/api/tool-gateway/tools/call\`, {
  method: "POST",
  headers: { "x-paperclip-tool-gateway-token": session.token, "content-type": "application/json" },
  body: JSON.stringify({ tool: tool.name, parameters: {} })
});
if (!call.ok) throw new Error(await call.text());
console.log(await call.text());
// Successful tool use must end with a durable task disposition.
const completion = await fetch(\`\${process.env.PAPERCLIP_API_URL}/api/issues/\${issueId}\`, {
  method: "PATCH",
  headers: apiHeaders,
  body: JSON.stringify({ status: "done", comment: "Read the requested Notion page inventory." })
});
if (!completion.ok) throw new Error(await completion.text());
`;
}

test("AgentMail request shows a durable inline key card in agent chat", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const settings = await json(await request.get("/api/instance/settings/experimental"));
  try {
    await json(await request.patch("/api/instance/settings/experimental", { data: {
      enableAgentChat: true, enableChatConnectors: true, enableClassicTaskInterface: false,
    } }));
    const seed = await newCompany(request);
    const agent = await createAgent(request, seed.companyId, "Email requester");
    // Script only the agent's choice of tool; persistence, routes, and UI are real.
    const script = `
const headers = { authorization: "Bearer " + process.env.PAPERCLIP_API_KEY, "content-type": "application/json", "x-paperclip-run-id": process.env.PAPERCLIP_RUN_ID };
const runResponse = await fetch(process.env.PAPERCLIP_API_URL + "/api/heartbeat-runs/" + process.env.PAPERCLIP_RUN_ID, { headers });
if (!runResponse.ok) throw new Error(await runResponse.text());
const run = await runResponse.json();
if (run.contextSnapshot?.interactionId) process.exit(0);
const post = async (url, body) => {
  const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer " + process.env.PAPERCLIP_RUNTIME_TOOLS_TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};
const search = await post(process.env.PAPERCLIP_RUNTIME_TOOLS_CONNECTIONS_SEARCH_URL, { query: "Get yourself an email address with AgentMail" });
if (!search.results.some(result => result.service === "agentmail") || !search.instruction.includes("connection_request")) throw new Error("AgentMail card was not advertised");
const result = await post(process.env.PAPERCLIP_RUNTIME_TOOLS_CONNECTION_REQUEST_URL, { service: "agentmail" });
if (result.state !== "needs_user_action") throw new Error("Expected an inline card");
`;
    await json(await request.patch(`/api/agents/${agent.id}`, { data: {
      adapterConfig: { command: process.execPath, args: ["--input-type=module", "-e", script] }, replaceAdapterConfig: true,
    } }));
    await page.goto(`/${seed.prefix}/chats/${agent.id}`);
    await send(page, "Get yourself an email address with AgentMail.");
    await waitForAgentRun(request, seed.companyId, agent.id);
    const chat = await json<{ id: string }>(await request.get(`/api/companies/${seed.companyId}/chats/${agent.id}`));
    const interactions = await json<Array<{ id: string; kind: string; status: string; addresseeUserId: string; payload: Json }>>(
      await request.get(`/api/issues/${chat.id}/interactions`),
    );
    expect(interactions).toHaveLength(1);
    expect(interactions[0]).toMatchObject({ kind: "connection_intent", status: "pending", addresseeUserId: "local-board",
      payload: { purpose: "channel", serviceSlug: "agentmail", requestingAgentId: agent.id } });
    await page.reload();
    const form = page.getByTestId("agentmail-inline-setup");
    await expect(form).toBeVisible();
    await expect(form.locator("input")).toHaveCount(1);
    await expect(form.getByLabel("API key")).toHaveAttribute("type", "password");
    await expect(form.getByRole("link", { name: "Get an AgentMail API key" })).toHaveAttribute("href", "https://console.agentmail.to/dashboard/api-keys");
    await expect(form.locator('[role="radiogroup"], [role="combobox"], select')).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(form.getByRole("button", { name: "Connect AgentMail" })).toBeDisabled();
    const card = page.getByTestId("connection-intent-focus-target");
    await card.screenshot({ path: testInfo.outputPath("agentmail-inline-card.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(form).toBeVisible();
    await card.screenshot({ path: testInfo.outputPath("agentmail-inline-card-mobile.png") });
    await form.getByRole("button", { name: "Not now" }).click();
    await expect(form).toHaveCount(0);
    await expect.poll(async () => {
      const rows = await json<Array<{ status: string }>>(await request.get(`/api/issues/${chat.id}/interactions`));
      return rows.map(row => row.status);
    }).toEqual(["rejected"]);
    expect(await json(await request.get(`/api/companies/${seed.companyId}/email/inboxes`))).toEqual([]);
    const connections = await json<{ connections: unknown[] }>(await request.get(`/api/companies/${seed.companyId}/tools/connections`));
    expect(connections.connections).toEqual([]);
  } finally {
    await json(await request.patch("/api/instance/settings/experimental", { data: {
      enableAgentChat: settings.enableAgentChat, enableChatConnectors: settings.enableChatConnectors,
      enableClassicTaskInterface: settings.enableClassicTaskInterface,
    } }));
  }
});

async function waitForAgentRun(
  request: APIRequestContext,
  companyId: string,
  agentId: string,
) {
  let terminalRun: { id: string; status: string } | null = null;
  await expect
    .poll(
      async () => {
        const runs = await json<Array<{ id: string; status: string }>>(
          await request.get(
            `/api/companies/${companyId}/heartbeat-runs?agentId=${agentId}&limit=10`,
          ),
        );
        terminalRun =
          runs.find((run) => !["queued", "running"].includes(run.status)) ??
          null;
        return terminalRun?.status ?? null;
      },
      { timeout: 45_000 },
    )
    .toBe("succeeded");
  if (!terminalRun)
    throw new Error("Agent run completed without a run receipt");
  return terminalRun;
}

test("store setup and a gateway-ready task request share one fake provider without an access card", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const provider = await startFakeProvider();
  try {
    const seed = await newCompany(request);
    const holder = await createAgent(
      request,
      seed.companyId,
      "Existing access holder",
    );

    // Entry point one: connect and test the provider through the Connections store.
    await page.goto(`/${seed.prefix}/apps`);
    await expect(page.getByRole("heading", { name: "Connectors" })).toBeVisible({
      timeout: 30_000,
    });
    const customConnector = page
      .getByRole("list", { name: "Connector list" })
      .getByRole("listitem")
      .filter({ hasText: "Connect your own tool" });
    await customConnector.getByRole("button", { name: "Connect", exact: true }).click();
    await customConnector.getByRole("button", { name: "Connect your own MCP server" }).click();
    await page
      .getByPlaceholder("https://example.com/actions")
      .fill(provider.url);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /Check link/i }).click();
    // A no-auth read-only provider can complete the access/install defaults in
    // one commit. Other methods exercise the same intermediate steps in the
    // shared-flow component suite.
    await expect(page.getByRole("heading", { name: /is ready/i })).toBeVisible({
      timeout: 30_000,
    });

    const connections = await json<{
      connections: Array<{ id: string; name: string; config: Json }>;
    }>(await request.get(`/api/companies/${seed.companyId}/tools/connections`));
    expect(connections.connections).toHaveLength(1);
    const connection = connections.connections[0]!;
    const connectionId = connection.id;
    await json(
      await request.patch(`/api/tool-connections/${connectionId}`, {
        data: {
          config: {
            ...connection.config,
            url: provider.url,
            sourceTemplateKey: "notion",
          },
        },
      }),
    );
    await json(
      await request.put(`/api/tool-connections/${connectionId}/installs`, {
        data: {
          installs: [{ targetType: "agent", targetId: holder.id }],
        },
      }),
    );
    const profiles = await json<{
      profiles: Array<{ id: string; profileKey: string }>;
    }>(await request.get(`/api/companies/${seed.companyId}/tools/profiles`));
    const appProfile = profiles.profiles.find(
      (profile) => profile.profileKey === `app:${connectionId}`,
    );
    expect(appProfile).toBeTruthy();
    expect(
      await json<{ unbound: number }>(
        await request.post(
          `/api/companies/${seed.companyId}/tools/profiles/${appProfile!.id}/unbind`,
          { data: { targetType: "company", targetId: seed.companyId } },
        ),
      ),
    ).toMatchObject({ unbound: 1 });

    await page.goto(`/${seed.prefix}/apps/${connectionId}/permissions`);
    const actionRow = page.locator("[data-action-id]").filter({ hasText: "List fixture pages" });
    await actionRow.getByRole("button", { name: "Test", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Test List fixture pages" }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByText("Fixture page inventory")).toBeVisible({
      timeout: 30_000,
    });

    const callsBeforeTask = provider.captures.filter(
      (capture) => capture.method === "tools/call" && capture.toolName === "notion:list_pages",
    ).length;

    // Entry point two: a standard agent holds the default gateway grant without
    // an install, so search and request are ready and the task completes in
    // one run with no access card.
    const scout = await createAgent(
      request,
      seed.companyId,
      "Connection requester",
    );
    await json(
      await request.patch(`/api/agents/${scout.id}`, {
        data: {
          adapterType: "process",
          adapterConfig: {
            command: process.execPath,
            args: [
              "--input-type=module",
              "-e",
              connectionAwareScript(connectionId),
            ],
          },
          replaceAdapterConfig: true,
        },
      }),
    );
    const issue = await json<{ id: string; identifier: string }>(
      await request.post(`/api/companies/${seed.companyId}/issues`, {
        data: {
          title: "Read our Notion pages",
          status: "in_progress",
          assigneeAgentId: scout.id,
        },
      }),
    );
    // Assigning an in-progress task is the production wake path.
    await waitForAgentRun(request, seed.companyId, scout.id);

    const requesterAccess = (
      await json<{ access: { tools: Array<{ toolName: string; decision: string }> } }>(
        await request.get(`/api/tool-connections/${connectionId}/test-agents/${scout.id}/access`),
      )
    ).access.tools.find((tool) => tool.toolName === "notion:list_pages")?.decision ?? null;
    expect(requesterAccess).toBe("allowed");
    const installs = await json<{ installs: Array<{ targetType: string; targetId: string }> }>(
      await request.get(`/api/tool-connections/${connectionId}/installs`),
    );
    expect(installs.installs.some((install) => install.targetId === scout.id)).toBe(false);

    expect(
      provider.captures.filter(
        (capture) =>
          capture.method === "tools/call" &&
          capture.toolName === "notion:list_pages",
      ).length,
    ).toBe(callsBeforeTask + 1);
    const completedIssue = await json<{ status: string }>(
      await request.get(`/api/issues/${issue.id}`),
    );
    expect(completedIssue.status).toBe("done");
    const finalRuns = await json<Array<{ id: string; status: string }>>(
      await request.get(`/api/companies/${seed.companyId}/heartbeat-runs?agentId=${scout.id}&limit=10`),
    );
    expect(finalRuns).toHaveLength(1);
    expect(finalRuns[0]!.status).toBe("succeeded");

    const interactions = await json<Array<{ kind: string; status: string }>>(
      await request.get(`/api/issues/${issue.id}/interactions`),
    );
    expect(
      interactions.filter((interaction) => interaction.kind === "connection_intent"),
    ).toHaveLength(0);
    await page.goto(`/${seed.prefix}/issues/${issue.identifier}`);
    await expect(page.getByText("Read the requested Notion page inventory.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/^Grant Connection requester access/)).toHaveCount(0);
    expect(holder.id).not.toBe(scout.id);
  } finally {
    await provider.close();
  }
});
