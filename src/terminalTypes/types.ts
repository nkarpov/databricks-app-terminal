export type TerminalTypePersistence = {
  enabled: boolean;
  schemaVersion: number;
  include: string[];
  exclude?: string[];
  restoreStrategy?: "overwrite" | "if-missing";
};

export type TerminalType = {
  id: string;
  name: string;
  description?: string;
  badge?: string;
  icon?: string;
  default: boolean;
  builtIn: boolean;
  persistence?: TerminalTypePersistence;
};

export type ResolvedTerminalType = TerminalType & {
  entrypointPath?: string;
};

export interface TerminalTypeRegistry {
  listTypes(): TerminalType[];
  resolveType(id: string): ResolvedTerminalType | undefined;
  getDefaultType(): ResolvedTerminalType;
}
