import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/http/app.js";
import type { AppConfig } from "../src/config.js";
import { Logger } from "../src/logging/logger.js";
import { ServiceRegistry } from "../src/services/registry.js";
import type { RuntimeService } from "../src/services/contracts.js";
import { FakeSessionManager } from "./helpers.js";

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    appName: "databricks-app-terminal-test",
    host: "127.0.0.1",
    port: 0,
    shell: "/bin/bash",
    webRoot: `${process.cwd()}/public`,
    strictRuntimeChecks: false,
    defaultCols: 120,
    defaultRows: 30,
    maxCols: 400,
    maxRows: 200,
    maxSessions: 64,
    maxHistoryChars: 100_000,
    maxInputBytes: 16_384,
    maxWsMessageBytes: 65_536,
    wsBackpressureBytes: 1_000_000,
    diagnosticsTtlMs: 5_000,
    sessionEnvHookTimeoutMs: 50,
    sessionDefaultCwd: process.cwd(),
    npmGlobalPrefix: `${process.cwd()}/.test-npm-global`,
    npmCacheDir: `${process.cwd()}/.test-npm-cache`,
    serviceModules: [],
    logLevel: "error",
    logPath: undefined,
    ...overrides,
  };
}

function makeApp(services: RuntimeService[] = [], configOverride?: Partial<AppConfig>) {
  const config = makeConfig(configOverride);
  const logger = new Logger({
    appName: config.appName,
    level: "error",
  });

  const sessionManager = new FakeSessionManager();
  const registry = new ServiceRegistry(
    services,
    {
      config,
      logger,
    },
    logger,
    config.sessionEnvHookTimeoutMs,
  );

  const diagnostics = {
    getDiagnostics: async () => ({
      generatedAt: new Date().toISOString(),
      uptimeSec: 1,
      coreReady: true,
      requiredServicesReady: true,
      ready: true,
      coreChecks: [],
      services: {
        health: [],
        readiness: [],
      },
      sessions: sessionManager.getStats(),
    }),
  };

  return {
    app: createApp({
      config,
      logger,
      sessions: sessionManager,
      services: registry,
      diagnostics,
    }),
    sessionManager,
    registry,
  };
}

test("session lifecycle endpoints work", async () => {
  const { app, sessionManager } = makeApp();

  const before = await request(app).get("/api/sessions").expect(200);
  assert.equal(before.body.ok, true);
  assert.equal(before.body.data.sessions.length, 0);

  const created = await request(app).post("/api/sessions").send({}).expect(201);
  assert.equal(created.body.ok, true);

  const sessionId = created.body.data.session.sessionId;
  assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  const attached = await request(app)
    .post(`/api/sessions/${encodeURIComponent(sessionId)}/attach`)
    .send({})
    .expect(200);

  assert.equal(attached.body.data.sessionId, sessionId);
  assert.match(attached.body.data.websocketPath, /\/ws\/terminal\?sessionId=/);

  await request(app)
    .post(`/api/sessions/${encodeURIComponent(sessionId)}/input`)
    .send({ data: "echo hi\r" })
    .expect(200);

  await request(app)
    .post(`/api/sessions/${encodeURIComponent(sessionId)}/resize`)
    .send({ cols: 140, rows: 40 })
    .expect(200);

  const listed = await request(app).get("/api/sessions").expect(200);
  assert.equal(listed.body.data.sessions.length, 1);

  assert.equal(sessionManager.writes.length, 1);
  assert.equal(sessionManager.resizes.length >= 1, true);

  await request(app).delete(`/api/sessions/${encodeURIComponent(sessionId)}`).expect(200);

  const after = await request(app).get("/api/sessions").expect(200);
  assert.equal(after.body.data.sessions.length, 0);
});

test("optional session env hook timeout does not block create", async () => {
  const slowService: RuntimeService = {
    name: "slow-env",
    async start() {
      // no-op
    },
    async stop() {
      // no-op
    },
    async enrichSessionEnv() {
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });

      return {
        SHOULD_NOT_APPEAR: "1",
      };
    },
  };

  const { app, registry } = makeApp([slowService], {
    sessionEnvHookTimeoutMs: 25,
  });

  await registry.startAll();

  const startedAt = Date.now();
  const created = await request(app).post("/api/sessions").send({}).expect(201);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(created.body.ok, true);
  assert.ok(elapsedMs < 250, `session creation took too long: ${elapsedMs}ms`);
});
