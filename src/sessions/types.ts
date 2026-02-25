export type SessionInfo = {
  sessionId: string;
  createdAt: number;
  cwd: string;
  cols: number;
  rows: number;
  attachedClients: number;
};

export type SessionExit = {
  exitCode: number;
  signal?: number;
};

export type CreateSessionInput = {
  sessionId: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string | undefined>;
};

export type AttachHandlers = {
  onData: (data: string) => void;
  onExit: (exit: SessionExit) => void;
};

export interface SessionManager {
  listSessions(): Promise<SessionInfo[]>;
  createSession(input: CreateSessionInput): Promise<SessionInfo>;
  sessionExists(sessionId: string): Promise<boolean>;
  ensureSessionExists(sessionId: string): Promise<void>;
  attachSession(sessionId: string, handlers: AttachHandlers): Promise<() => void>;
  writeInput(sessionId: string, data: string): Promise<void>;
  resizeSession(sessionId: string, cols: number, rows: number): Promise<void>;
  killSession(sessionId: string): Promise<void>;
  getStats(): { activeSessions: number; attachedClients: number };
  shutdown(): Promise<void>;
}
