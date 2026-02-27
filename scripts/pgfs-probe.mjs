#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fg from "fast-glob";
import { Pool } from "pg";
import { PgFs } from "pg-fs";

const DEFAULT_INCLUDE = [
  ".claude/**",
  ".claude.json",
  ".codex/**",
  ".pi/**",
  "AGENTS.md",
];

const DEFAULT_EXCLUDE = [
  "**/*.tmp",
  "**/*.lock",
  "**/*.swp",
  "**/*.swo",
  "**/.DS_Store",
  "**/*-wal",
  "**/*-shm",
  ".claude/plugins/**",
  ".claude/cache/**",
  ".codex/tmp/**",
];

function printUsage() {
  console.log(`pgfs-probe

Usage:
  node scripts/pgfs-probe.mjs <push|pull|list|bench>

Required env:
  PGFS_DATABASE_URL     PostgreSQL connection string

Optional env:
  PGFS_LOCAL_ROOT       Local root (default: $HOME)
  PGFS_NAMESPACE        Namespace (default: dev)
  PGFS_TYPE_ID          Type id (default: claude)
  PGFS_INCLUDE          Comma/newline-delimited include globs (relative to local root)
  PGFS_EXCLUDE          Comma/newline-delimited exclude globs (relative to local root)
  PGFS_MANIFEST_PATH    Remote manifest path override (default: /agent-state/<ns>/<type>/manifest.json)

Examples:
  PGFS_DATABASE_URL=... node scripts/pgfs-probe.mjs push
  PGFS_DATABASE_URL=... PGFS_TYPE_ID=codex node scripts/pgfs-probe.mjs bench
`);
}

function parsePatternList(raw, fallback) {
  if (!raw || raw.trim().length === 0) {
    return [...fallback];
  }

  return raw
    .split(/[\n,]/g)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function isLikelyBinary(buffer) {
  if (buffer.length === 0) {
    return false;
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  let suspicious = 0;

  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }

    if ((byte >= 1 && byte <= 7) || (byte >= 14 && byte <= 31)) {
      suspicious += 1;
    }
  }

  return suspicious / sample.length > 0.3;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function toPosixPath(relativePath) {
  return relativePath.split(path.sep).join(path.posix.sep);
}

function fromPosixPath(relativePath) {
  return relativePath.split(path.posix.sep).join(path.sep);
}

function formatDurationMs(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function nowMs() {
  return Number(process.hrtime.bigint() / BigInt(1_000_000));
}

function buildConfig() {
  const localRoot = process.env.PGFS_LOCAL_ROOT || os.homedir();
  const namespace = process.env.PGFS_NAMESPACE || "dev";
  const typeId = process.env.PGFS_TYPE_ID || "claude";
  const include = parsePatternList(process.env.PGFS_INCLUDE, DEFAULT_INCLUDE);
  const exclude = parsePatternList(process.env.PGFS_EXCLUDE, DEFAULT_EXCLUDE);
  const remoteRoot = `/agent-state/${namespace}/${typeId}`;
  const manifestPath = process.env.PGFS_MANIFEST_PATH || `${remoteRoot}/manifest.json`;

  return {
    localRoot,
    namespace,
    typeId,
    include,
    exclude,
    remoteRoot,
    filesRoot: `${remoteRoot}/files`,
    manifestPath,
  };
}

async function loadManifest(pgfs, manifestPath) {
  const exists = await pgfs.fs.exists(manifestPath);
  if (!exists) {
    return null;
  }

  const { content } = await pgfs.fs.readFile(manifestPath);
  return JSON.parse(content);
}

async function collectLocalFiles(config) {
  const relativePaths = await fg(config.include, {
    cwd: config.localRoot,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    unique: true,
    ignore: config.exclude,
  });

  relativePaths.sort((a, b) => a.localeCompare(b));
  return relativePaths;
}

async function encodeLocalFile(absolutePath) {
  const [buffer, stat] = await Promise.all([fs.readFile(absolutePath), fs.stat(absolutePath)]);

  if (isLikelyBinary(buffer)) {
    return {
      content: {
        encoding: "base64",
        data: buffer.toString("base64"),
      },
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
      size: buffer.length,
      sha256: sha256(buffer),
      binary: true,
    };
  }

  return {
    content: {
      encoding: "utf8",
      data: buffer.toString("utf8"),
    },
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    size: buffer.length,
    sha256: sha256(buffer),
    binary: false,
  };
}

async function decodeAndWriteLocalFile(absolutePath, envelope) {
  const encoded = envelope?.content;
  if (!encoded || typeof encoded !== "object") {
    throw new Error(`Invalid file envelope for ${absolutePath}`);
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });

  let data;
  if (encoded.encoding === "base64") {
    data = Buffer.from(encoded.data || "", "base64");
  } else {
    data = Buffer.from(encoded.data || "", "utf8");
  }

  await fs.writeFile(absolutePath, data);

  if (typeof envelope.mode === "number") {
    try {
      await fs.chmod(absolutePath, envelope.mode);
    } catch {
      // noop
    }
  }

  if (typeof envelope.mtimeMs === "number") {
    try {
      const timestamp = new Date(envelope.mtimeMs);
      await fs.utimes(absolutePath, timestamp, timestamp);
    } catch {
      // noop
    }
  }
}

async function push(config, pgfs) {
  const start = nowMs();
  const relativePaths = await collectLocalFiles(config);

  const previousManifest = await loadManifest(pgfs, config.manifestPath);
  const previousPaths = new Set((previousManifest?.files || []).map((entry) => entry.path));

  const nextManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    namespace: config.namespace,
    typeId: config.typeId,
    localRoot: config.localRoot,
    include: config.include,
    exclude: config.exclude,
    files: [],
  };

  let binaryCount = 0;

  for (const relPathRaw of relativePaths) {
    const relPath = toPosixPath(relPathRaw);
    const absolutePath = path.join(config.localRoot, fromPosixPath(relPathRaw));
    const remotePath = `${config.filesRoot}/${relPath}`;

    const encoded = await encodeLocalFile(absolutePath);
    if (encoded.binary) {
      binaryCount += 1;
    }

    await pgfs.fs.writeFile(remotePath, JSON.stringify(encoded), {
      createParents: true,
    });

    nextManifest.files.push({
      path: relPath,
      size: encoded.size,
      sha256: encoded.sha256,
      mode: encoded.mode,
      mtimeMs: encoded.mtimeMs,
      binary: encoded.binary,
      updatedAt: new Date().toISOString(),
    });

    previousPaths.delete(relPath);
  }

  for (const stalePath of previousPaths) {
    const remotePath = `${config.filesRoot}/${stalePath}`;
    try {
      await pgfs.fs.unlink(remotePath);
    } catch {
      // noop - stale delete best-effort
    }
  }

  await pgfs.fs.writeFile(config.manifestPath, JSON.stringify(nextManifest, null, 2), {
    createParents: true,
  });

  const elapsedMs = nowMs() - start;

  console.log(`push complete`);
  console.log(`  files: ${nextManifest.files.length}`);
  console.log(`  binary files: ${binaryCount}`);
  console.log(`  deleted stale files: ${previousPaths.size}`);
  console.log(`  elapsed: ${formatDurationMs(elapsedMs)}`);
}

async function pull(config, pgfs) {
  const start = nowMs();
  const manifest = await loadManifest(pgfs, config.manifestPath);

  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error(`Remote manifest missing at ${config.manifestPath}`);
  }

  let restored = 0;

  for (const entry of manifest.files) {
    const relPath = entry.path;
    if (!relPath || typeof relPath !== "string") {
      continue;
    }

    const remotePath = `${config.filesRoot}/${relPath}`;
    const localPath = path.join(config.localRoot, fromPosixPath(relPath));

    const { content } = await pgfs.fs.readFile(remotePath);
    const envelope = JSON.parse(content);
    await decodeAndWriteLocalFile(localPath, envelope);
    restored += 1;
  }

  const elapsedMs = nowMs() - start;

  console.log(`pull complete`);
  console.log(`  files restored: ${restored}`);
  console.log(`  elapsed: ${formatDurationMs(elapsedMs)}`);
}

async function list(config, pgfs) {
  const manifest = await loadManifest(pgfs, config.manifestPath);

  if (!manifest || !Array.isArray(manifest.files)) {
    console.log(`No manifest found at ${config.manifestPath}`);
    return;
  }

  console.log(`manifest: ${config.manifestPath}`);
  console.log(`generatedAt: ${manifest.generatedAt}`);
  console.log(`files: ${manifest.files.length}`);

  for (const entry of manifest.files.slice(0, 50)) {
    console.log(`- ${entry.path} (${entry.size} bytes${entry.binary ? ", binary" : ""})`);
  }

  if (manifest.files.length > 50) {
    console.log(`... ${manifest.files.length - 50} more`);
  }
}

async function bench(config, pgfs) {
  console.log("Running push benchmark...");
  await push(config, pgfs);
  console.log("Running pull benchmark...");
  await pull(config, pgfs);
}

async function main() {
  const command = process.argv[2];
  if (!command || ["-h", "--help", "help"].includes(command)) {
    printUsage();
    process.exit(0);
  }

  if (!["push", "pull", "list", "bench"].includes(command)) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  const databaseUrl = process.env.PGFS_DATABASE_URL;
  if (!databaseUrl) {
    console.error("PGFS_DATABASE_URL is required");
    process.exit(1);
  }

  const config = buildConfig();
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const pgfs = await PgFs.create({ pool });

    if (command === "push") {
      await push(config, pgfs);
    } else if (command === "pull") {
      await pull(config, pgfs);
    } else if (command === "list") {
      await list(config, pgfs);
    } else {
      await bench(config, pgfs);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("pgfs-probe failed");
  console.error(error?.message || String(error));

  if (error?.cause) {
    console.error("cause:", error.cause?.message || String(error.cause));
  }

  if (error?.query) {
    console.error("query:", error.query);
  }

  process.exit(1);
});
