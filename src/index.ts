import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { createTerminalServer } from "./http/app.js";
import { Logger } from "./logging/logger.js";
import { RuntimeDiagnosticsManager } from "./runtime/diagnostics.js";
import { InMemoryPtySessionManager } from "./sessions/ptySessionManager.js";
import { loadRuntimeServices } from "./services/loader.js";
import { ServiceRegistry } from "./services/registry.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger({
    appName: config.appName,
    level: config.logLevel,
    path: config.logPath,
  });

  const loadedServices = await loadRuntimeServices(config.serviceModules, logger);

  const serviceRegistry = new ServiceRegistry(
    loadedServices,
    {
      config,
      logger,
    },
    logger,
    config.sessionEnvHookTimeoutMs,
  );

  await serviceRegistry.startAll();

  await fs.mkdir(config.npmGlobalPrefix, { recursive: true });
  await fs.mkdir(config.npmCacheDir, { recursive: true });

  const npmGlobalBin = path.join(config.npmGlobalPrefix, "bin");
  const existingPath = process.env.PATH || "";
  const pathEntries = existingPath.split(":").filter((entry) => entry.length > 0);
  const prefixedPath = pathEntries.includes(npmGlobalBin)
    ? existingPath
    : [npmGlobalBin, ...pathEntries].join(":");

  const sessions = new InMemoryPtySessionManager({
    shell: config.shell,
    baseEnv: {
      NPM_CONFIG_PREFIX: config.npmGlobalPrefix,
      NPM_CONFIG_CACHE: config.npmCacheDir,
      npm_config_prefix: config.npmGlobalPrefix,
      npm_config_cache: config.npmCacheDir,
      PATH: prefixedPath,
      DBX_APP_TERMINAL_NPM_PREFIX: config.npmGlobalPrefix,
      DBX_APP_TERMINAL_NPM_CACHE: config.npmCacheDir,
    },
    maxSessions: config.maxSessions,
    maxHistoryChars: config.maxHistoryChars,
    maxInputBytes: config.maxInputBytes,
    defaultCols: config.defaultCols,
    defaultRows: config.defaultRows,
    maxCols: config.maxCols,
    maxRows: config.maxRows,
    logger,
  });

  const diagnostics = new RuntimeDiagnosticsManager(config, sessions, serviceRegistry, logger);
  const startupDiagnostics = await diagnostics.getDiagnostics(true);

  logger.info("runtime.startup", {
    ready: startupDiagnostics.ready,
    coreReady: startupDiagnostics.coreReady,
    requiredServicesReady: startupDiagnostics.requiredServicesReady,
    serviceCount: serviceRegistry.getServiceCount(),
    host: config.host,
    port: config.port,
    sessionDefaultCwd: config.sessionDefaultCwd,
    npmGlobalPrefix: config.npmGlobalPrefix,
    npmCacheDir: config.npmCacheDir,
  });

  if (!startupDiagnostics.ready && config.strictRuntimeChecks) {
    throw new Error("Runtime not ready. Check /api/runtime/diagnostics for details.");
  }

  const { server } = createTerminalServer({
    config,
    logger,
    sessions,
    services: serviceRegistry,
    diagnostics,
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, () => {
      logger.info("server.listen", {
        host: config.host,
        port: config.port,
      });
      resolve();
    });
  });

  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("runtime.shutdown.begin", {
      signal,
    });

    server.close(async () => {
      await sessions.shutdown();
      await serviceRegistry.stopAll();
      logger.info("runtime.shutdown.complete", {
        signal,
      });
      logger.close();
      process.exit(0);
    });

    setTimeout(() => {
      logger.error("runtime.shutdown.timeout", { signal });
      process.exit(1);
    }, 5_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("databricks-app-terminal startup failed", error);
  process.exit(1);
});
