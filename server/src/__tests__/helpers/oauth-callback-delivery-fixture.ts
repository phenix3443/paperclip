import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { vi } from "vitest";
import { authUsers, companyMemberships, connectionGrants, connectionIntentDeliveries, issueThreadInteractions, toolApplications, toolConnections, toolOauthStates, toolProfiles, type Db } from "@paperclipai/db";
import type { PaperclipCloudConnector } from "../../services/paperclip-cloud-connector.js";
import { secretService } from "../../services/secrets.js";
import { toConnection } from "../../services/tool-access/connections/projection.js";
import { createOrganizationGrantStore } from "../../services/tool-access/connections/organization-grant.js";
import { createConnectionSetupPolicy } from "../../services/tool-access/connections/setup-policy.js";
import { createCloudOAuthCallback } from "../../services/tool-access/oauth/cloud-callback.js";
import { createOAuthCredentialStore } from "../../services/tool-access/oauth/credential-store.js";
import { createDirectOAuthCallback } from "../../services/tool-access/oauth/direct-callback.js";
import { createOAuthStateStore } from "../../services/tool-access/oauth/state.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./connection-delivery-harness.js";

export const OAUTH_CALLBACK_MODES = ["direct user", "direct organization", "cloud draft", "cloud reauthorization"] as const;
export type OAuthCallbackMode = (typeof OAUTH_CALLBACK_MODES)[number];

const SCOPE = "fixture.read";

export async function arrangeOAuthCallback(db: Db, mode: OAuthCallbackMode) {
  const owner = "owner";
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
  await db.insert(authUsers).values({ id: owner, name: "Owner", email: `${owner}@example.test`, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
  const seed = await seedPendingAccessRequest(db, owner);
  await db.update(toolProfiles).set({ defaultAction: "allow" }).where(eq(toolProfiles.companyId, seed.companyId));
  const cloud = mode.startsWith("cloud");
  const organization = mode === "direct organization";
  const draft = mode !== "cloud reauthorization";
  const config = cloud
    ? { sourceTemplateKey: "gmail", connectionMethodKey: "paperclip-draft" }
    : { sourceTemplateKey: "sentry" };
  await db.update(toolConnections).set({
    authKind: "oauth",
    config,
    transportConfig: config,
    status: draft ? "draft" : "active",
    enabled: !draft,
    credentialPolicy: organization ? "shared" : "per_user",
  }).where(eq(toolConnections.id, seed.connection.id));
  if (draft) await db.update(toolApplications).set({ status: "draft" }).where(eq(toolApplications.id, seed.connection.applicationId));
  if (cloud) {
    await db.update(issueThreadInteractions)
      .set({ payload: { ...seed.intent.payload, serviceSlug: "gmail", serviceName: "Gmail" } })
      .where(eq(issueThreadInteractions.id, seed.intent.id));
  }
  if (organization) {
    await db.delete(connectionGrants).where(eq(connectionGrants.connectionId, seed.connection.id));
    await db.update(companyMemberships).set({ membershipRole: "admin" }).where(eq(companyMemberships.companyId, seed.companyId));
  } else if (!draft) {
    await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() }).where(eq(connectionGrants.connectionId, seed.connection.id));
  }
  const state = randomUUID();
  await db.insert(toolOauthStates).values({
    state,
    companyId: seed.companyId,
    connectionId: seed.connection.id,
    codeVerifier: "fixture-verifier",
    createdByActorType: "user",
    createdByActorId: owner,
    subjectUserId: organization ? null : owner,
    requestedScopes: [SCOPE],
    expiresAt: new Date(Date.now() + 600_000),
  });

  const actor = { actorType: "user" as const, actorId: owner };
  const later = {
    refreshCatalog: vi.fn(),
    finishCatalog: vi.fn(async () => null),
    checkHealth: vi.fn(async () => ({ status: "ok" })),
  };
  const readConnection = (client: Db) => client.select().from(toolConnections).where(eq(toolConnections.id, seed.connection.id)).then(rows => rows[0]!);
  const claim = vi.fn(async () => ({
    accessToken: "fixture-access-token",
    refreshToken: "fixture-refresh-token",
    tokenType: "Bearer",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scopes: [SCOPE],
    subject: owner,
  }));

  function callback(options: { client?: Db; beforeCommit?: () => Promise<void> } = {}) {
    const client = options.client ?? db;
    later.refreshCatalog.mockImplementation(async () => ({ connection: toConnection(await readConnection(client)), catalog: [] }));
    const credentials = createOAuthCredentialStore(client, secretService(client));
    const store = {
      ...credentials,
      oauthClientForConnection: async () => ({ clientId: "fixture-client", clientSecret: null, clientIdEnv: "FIXTURE_CLIENT_ID", clientSecretEnv: "FIXTURE_CLIENT_SECRET" }),
      syncCredentialBindings: async (...args: Parameters<typeof credentials.syncCredentialBindings>) => {
        await credentials.syncCredentialBindings(...args);
        await options.beforeCommit?.();
      },
    };
    const shared = {
      now: () => new Date(),
      getConnectionRow: () => readConnection(client),
      state: createOAuthStateStore(client),
      store,
      refreshCatalog: later.refreshCatalog,
      finishOAuthCatalogWithRecommendedDefaults: later.finishCatalog,
    };
    if (cloud) {
      const connector = { claim } as unknown as PaperclipCloudConnector;
      const dependencies = { ...shared, currentCloudConnector: () => connector };
      return createCloudOAuthCallback(client, dependencies as unknown as Parameters<typeof createCloudOAuthCallback>[1])({ state, claimId: "fixture-claim", actor });
    }
    return createDirectOAuthCallback(client, {
      ...shared,
      setupPolicy: createConnectionSetupPolicy(client),
      checkConnectionHealth: later.checkHealth,
      ensureDefaultOrganizationGrant: createOrganizationGrantStore(client),
      oauthEndpointsForConnection: async () => ({ provider: "fixture", scopes: [SCOPE], authorizationUrl: "https://oauth.example/authorize", tokenUrl: "https://oauth.example/token" }),
      exchangeOAuthToken: async () => ({ accessToken: "fixture-access-token", refreshToken: "fixture-refresh-token", tokenType: "Bearer", expiresIn: 3600, scope: SCOPE }),
    } as unknown as Parameters<typeof createDirectOAuthCallback>[1])({ state, code: "fixture-code", redirectUri: "https://paperclip.example/api/tools/oauth/callback", actor });
  }

  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  return {
    ...seed,
    claim,
    later,
    callback,
    startDelivery: async (options?: Parameters<typeof startConnectionDelivery>[1]) => (delivery = await startConnectionDelivery(db, options)),
    read: async () => ({
      connection: await readConnection(db),
      grants: await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, seed.connection.id)),
      states: await db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state)),
      card: (await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, seed.intent.id)))[0]!,
      deliveries: await db.select().from(connectionIntentDeliveries).where(eq(connectionIntentDeliveries.interactionId, seed.intent.id)),
    }),
    cleanup: async () => {
      try {
        await delivery?.stop();
      } finally {
        delivery = null;
        vi.unstubAllEnvs();
        await db.execute(sql`truncate table companies cascade`);
      }
    },
  };
}
