import { randomUUID } from "node:crypto";
import pty, { type IPty } from "node-pty";
import { AppError } from "../api/types.js";
import type { Logger } from "../logging/logger.js";
import type {
  AttachHandlers,
  CreateSessionInput,
  SessionExit,
  SessionInfo,
  SessionManager,
} from "./types.js";

export const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SessionClient = {
  id: string;
  onData: (data: string) => void;
  onExit: (event: SessionExit) => void;
};

type SessionRecord = {
  info: SessionInfo;
  pty: IPty;
  clients: Map<string, SessionClient>;
  history: string;
};

export type InMemoryPtySessionManagerOptions = {
  shell: string;
  baseEnv?: Record<string, string | undefined>;
  maxSessions: number;
  maxHistoryChars: number;
  maxInputBytes: number;
  defaultCols: number;
  defaultRows: number;
  maxCols: number;
  maxRows: number;
  logger: Logger;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cleanEnv(overrides: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

export function assertValidSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new AppError(400, "INVALID_SESSION_ID", "Session ID must be a UUIDv7", false, {
      sessionId,
    });
  }
}

export class InMemoryPtySessionManager implements SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();

  private readonly shell: string;

  private readonly baseEnv: Record<string, string | undefined>;

  private readonly maxSessions: number;

  private readonly maxHistoryChars: number;

  private readonly maxInputBytes: number;

  private readonly defaultCols: number;

  private readonly defaultRows: number;

  private readonly maxCols: number;

  private readonly maxRows: number;

  private readonly logger: Logger;

  constructor(options: InMemoryPtySessionManagerOptions) {
    this.shell = options.shell;
    this.baseEnv = options.baseEnv || {};
    this.maxSessions = options.maxSessions;
    this.maxHistoryChars = options.maxHistoryChars;
    this.maxInputBytes = options.maxInputBytes;
    this.defaultCols = options.defaultCols;
    this.defaultRows = options.defaultRows;
    this.maxCols = options.maxCols;
    this.maxRows = options.maxRows;
    this.logger = options.logger;
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [...this.sessions.values()]
      .map((session) => ({
        ...session.info,
        attachedClients: session.clients.size,
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    assertValidSessionId(input.sessionId);

    if (this.sessions.has(input.sessionId)) {
      throw new AppError(409, "SESSION_EXISTS", "Session already exists", false, {
        sessionId: input.sessionId,
      });
    }

    if (this.sessions.size >= this.maxSessions) {
      throw new AppError(
        429,
        "SESSION_LIMIT_REACHED",
        `Session limit reached (${this.maxSessions})`,
        true,
        {
          maxSessions: this.maxSessions,
        },
      );
    }

    const cols = clamp(input.cols || this.defaultCols, 20, this.maxCols);
    const rows = clamp(input.rows || this.defaultRows, 10, this.maxRows);
    const cwd = input.cwd || process.cwd();

    let p: IPty;

    try {
      p = pty.spawn(this.shell, ["-i"], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: {
          ...process.env,
          ...cleanEnv(this.baseEnv),
          ...cleanEnv(input.env || {}),
          TERM: "xterm-256color",
        },
      });
    } catch (error) {
      throw new AppError(500, "SESSION_SPAWN_FAILED", "Failed to spawn PTY session", true, {
        sessionId: input.sessionId,
        shell: this.shell,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const info: SessionInfo = {
      sessionId: input.sessionId,
      createdAt: Date.now(),
      cwd,
      cols,
      rows,
      attachedClients: 0,
    };

    const record: SessionRecord = {
      info,
      pty: p,
      clients: new Map(),
      history: "",
    };

    p.onData((data) => {
      record.history = (record.history + data).slice(-this.maxHistoryChars);
      for (const client of record.clients.values()) {
        client.onData(data);
      }
    });

    p.onExit(({ exitCode, signal }) => {
      for (const client of record.clients.values()) {
        client.onExit({ exitCode, signal });
      }

      this.sessions.delete(input.sessionId);
      this.logger.info("session.exit", {
        sessionId: input.sessionId,
        exitCode,
        signal,
      });
    });

    this.sessions.set(input.sessionId, record);

    this.logger.info("session.create", {
      sessionId: input.sessionId,
      cwd,
      cols,
      rows,
    });

    return { ...info };
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    assertValidSessionId(sessionId);
    return this.sessions.has(sessionId);
  }

  async ensureSessionExists(sessionId: string): Promise<void> {
    if (!(await this.sessionExists(sessionId))) {
      throw new AppError(404, "SESSION_NOT_FOUND", "Session not found", false, {
        sessionId,
      });
    }
  }

  async attachSession(sessionId: string, handlers: AttachHandlers): Promise<() => void> {
    const session = this.getSession(sessionId);

    const client: SessionClient = {
      id: randomUUID(),
      onData: handlers.onData,
      onExit: handlers.onExit,
    };

    session.clients.set(client.id, client);

    if (session.history) {
      handlers.onData(session.history);
    }

    return () => {
      session.clients.delete(client.id);
    };
  }

  async writeInput(sessionId: string, data: string): Promise<void> {
    const session = this.getSession(sessionId);

    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > this.maxInputBytes) {
      throw new AppError(413, "INPUT_TOO_LARGE", "Input exceeds maximum allowed bytes", false, {
        maxInputBytes: this.maxInputBytes,
        bytes,
      });
    }

    session.pty.write(data);
  }

  async resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
    const session = this.getSession(sessionId);

    const boundedCols = clamp(cols, 20, this.maxCols);
    const boundedRows = clamp(rows, 10, this.maxRows);

    session.pty.resize(boundedCols, boundedRows);
    session.info.cols = boundedCols;
    session.info.rows = boundedRows;
  }

  async killSession(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    try {
      session.pty.kill();
    } finally {
      this.sessions.delete(sessionId);
      this.logger.info("session.kill", {
        sessionId,
      });
    }
  }

  getStats(): { activeSessions: number; attachedClients: number } {
    let attachedClients = 0;
    for (const session of this.sessions.values()) {
      attachedClients += session.clients.size;
    }

    return {
      activeSessions: this.sessions.size,
      attachedClients,
    };
  }

  async shutdown(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const sessionId of ids) {
      try {
        await this.killSession(sessionId);
      } catch {
        // ignore shutdown race
      }
    }
  }

  private getSession(sessionId: string): SessionRecord {
    assertValidSessionId(sessionId);

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new AppError(404, "SESSION_NOT_FOUND", "Session not found", false, {
        sessionId,
      });
    }

    return session;
  }
}
