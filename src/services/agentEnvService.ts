import type { RuntimeService, SessionEnvRequest, ServiceContext } from "./contracts.js";

const AGENT_ENV_CONFIG: Record<string, (model?: string) => Record<string, string>> = {
  "claude-code": (model) => ({
    ...(model ? { ANTHROPIC_MODEL: model } : {}),
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  }),
  "codex": (_model) => ({
    DATABRICKS_AUTH_TYPE: "pat",
  }),
};

export const service: RuntimeService = {
  name: "agent-env",
  requiredForReadiness: false,

  async start(ctx: ServiceContext) {
    ctx.logger.info("agent-env.start", { message: "Agent environment service started" });
  },

  async stop(_ctx: ServiceContext) {
    // nothing to clean up
  },

  async enrichSessionEnv(request: SessionEnvRequest, _ctx: ServiceContext) {
    if (!request.agent) return;

    const envFn = AGENT_ENV_CONFIG[request.agent];
    if (!envFn) return;

    return envFn(request.model);
  },
};
