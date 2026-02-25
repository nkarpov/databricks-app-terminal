import { AppError } from "../src/api/types.js";
import type {
  AttachHandlers,
  CreateSessionInput,
  SessionInfo,
  SessionManager,
} from "../src/sessions/types.js";

type SessionRecord = {
  info: SessionInfo;
  clients: Set<AttachHandlers>;
};

function now(): number {
  return Date.now();
}

export class FakeSessionManager implements SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();

  readonly writes: Array<{ sessionId: string; data: string }> = [];

  readonly resizes: Array<{ sessionId: string; cols: number; rows: number }> = [];

  async listSessions(): Promise<SessionInfo[]> {
    return [...this.sessions.values()].map((session) => ({
      ...session.info,
      attachedClients: session.clients.size,
    }));
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    if (this.sessions.has(input.sessionId)) {
      throw new AppError(409, "SESSION_EXISTS", "Session already exists", false, {
        sessionId: input.sessionId,
      });
    }

    const info: SessionInfo = {
      sessionId: input.sessionId,
      createdAt: now(),
      cwd: input.cwd || process.cwd(),
      cols: input.cols || 120,
      rows: input.rows || 30,
      attachedClients: 0,
    };

    this.sessions.set(input.sessionId, {
      info,
      clients: new Set(),
    });

    return info;
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }

  async ensureSessionExists(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      throw new AppError(404, "SESSION_NOT_FOUND", "Session not found", false, {
        sessionId,
      });
    }
  }

  async attachSession(sessionId: string, handlers: AttachHandlers): Promise<() => void> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new AppError(404, "SESSION_NOT_FOUND", "Session not found", false, {
        sessionId,
      });
    }

    record.clients.add(handlers);

    return () => {
      record.clients.delete(handlers);
    };
  }

  async writeInput(sessionId: string, data: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new AppError(404, "SESSION_NOT_FOUND", "Session not found", false, {
        sessionId,
      });
    }

    this.writes.push({ sessionId, data });

    for (const client of record.clients) {
      client.onData(data);
    }
  }

  async resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new AppError(404, "SESSION_NOT_FOUND", "Session not found", false, {
        sessionId,
      });
    }

    record.info.cols = cols;
    record.info.rows = rows;
    this.resizes.push({ sessionId, cols, rows });
  }

  async killSession(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new AppError(404, "SESSION_NOT_FOUND", "Session not found", false, {
        sessionId,
      });
    }

    for (const client of record.clients) {
      client.onExit({ exitCode: 0 });
    }

    this.sessions.delete(sessionId);
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
      await this.killSession(sessionId);
    }
  }
}
