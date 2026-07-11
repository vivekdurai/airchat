/**
 * Server-local file storage for backends without an object store
 * (currently the Redis backend).
 *
 * Files live on the web server's disk under AIRCHAT_FILES_DIR (default
 * ~/.airchat/files), keyed by the same `<channel>/<timestamp>-<name>`
 * storage paths the Supabase bucket uses. Metadata lives in Redis:
 *
 *   airchat:file:<storagePath>   hash {name, size, type, channel,
 *                                      uploaded_by, created_at}
 *   airchat:files:<folder>       zset (created_at ms) -> storagePath
 *
 * Download URLs are HMAC-signed with a server-generated secret kept in
 * Redis, so a shared link works for its TTL without exposing agent keys.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { getRedisClient } from '@/lib/api-v2-auth';

const P = 'airchat:';
const SECRET_KEY = `${P}server:file-url-secret`;

export interface StoredFileMeta {
  name: string;
  size: number;
  type: string;
  channel: string;
  uploaded_by: string;
  created_at: string;
}

export function filesBaseDir(): string {
  return process.env.AIRCHAT_FILES_DIR ?? join(homedir(), '.airchat', 'files');
}

/**
 * Storage paths are relative `<folder>/<file>` strings. Reject anything
 * that could escape the base directory before it ever touches the
 * filesystem, then belt-and-braces verify the resolved path.
 */
export function isSafeStoragePath(p: string): boolean {
  return (
    p.length > 0 &&
    p.length < 512 &&
    !p.includes('..') &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    !p.includes('\0')
  );
}

function resolveWithinBase(storagePath: string): string {
  const base = resolve(filesBaseDir());
  const full = resolve(base, storagePath);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error('Path escapes storage directory');
  }
  return full;
}

export async function saveFile(
  storagePath: string,
  content: Buffer,
  meta: StoredFileMeta
): Promise<void> {
  const full = resolveWithinBase(storagePath);
  await mkdir(dirname(full), { recursive: true });
  // 'wx' refuses to overwrite, matching the bucket's upsert:false.
  await writeFile(full, content, { flag: 'wx' });

  const folder = storagePath.split('/')[0];
  const redis = getRedisClient();
  await redis
    .multi()
    .hset(`${P}file:${storagePath}`, { ...meta, size: String(meta.size) })
    .zadd(`${P}files:${folder}`, new Date(meta.created_at).getTime(), storagePath)
    .exec();
}

export async function loadFile(
  storagePath: string
): Promise<{ content: Buffer; meta: StoredFileMeta | null } | null> {
  let content: Buffer;
  try {
    content = await readFile(resolveWithinBase(storagePath));
  } catch {
    return null;
  }
  const h = await getRedisClient().hgetall(`${P}file:${storagePath}`);
  const meta: StoredFileMeta | null = h.name
    ? {
        name: h.name,
        size: Number(h.size),
        type: h.type,
        channel: h.channel,
        uploaded_by: h.uploaded_by,
        created_at: h.created_at,
      }
    : null;
  return { content, meta };
}

/** Newest-first listing of a folder, mirroring the bucket list shape. */
export async function listFolder(
  folder: string
): Promise<Array<StoredFileMeta & { path: string }>> {
  const redis = getRedisClient();
  const paths = await redis.zrevrange(`${P}files:${folder}`, 0, 99);
  const out: Array<StoredFileMeta & { path: string }> = [];
  for (const path of paths) {
    const h = await redis.hgetall(`${P}file:${path}`);
    if (!h.name) continue;
    out.push({
      path,
      name: h.name,
      size: Number(h.size),
      type: h.type,
      channel: h.channel,
      uploaded_by: h.uploaded_by,
      created_at: h.created_at,
    });
  }
  return out;
}

// ── Signed download URLs ─────────────────────────────────────────────────────

/** Lazily create (SET NX) and cache the URL-signing secret. */
let secretCache: string | null = null;

async function urlSecret(): Promise<string> {
  if (secretCache) return secretCache;
  const redis = getRedisClient();
  const fresh = randomBytes(32).toString('hex');
  await redis.set(SECRET_KEY, fresh, 'NX');
  secretCache = (await redis.get(SECRET_KEY))!;
  return secretCache;
}

function signature(secret: string, storagePath: string, expires: number): string {
  return createHmac('sha256', secret)
    .update(`${storagePath}\n${expires}`)
    .digest('hex');
}

export async function signFilePath(
  storagePath: string,
  ttlSeconds: number
): Promise<{ expires: number; sig: string }> {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { expires, sig: signature(await urlSecret(), storagePath, expires) };
}

export async function verifyFileSignature(
  storagePath: string,
  expires: number,
  sig: string
): Promise<boolean> {
  if (!Number.isFinite(expires) || expires < Date.now() / 1000) return false;
  const expected = Buffer.from(signature(await urlSecret(), storagePath, expires));
  const provided = Buffer.from(sig);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
