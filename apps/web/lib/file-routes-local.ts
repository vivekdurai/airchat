/**
 * File-sharing route handlers for backends that use server-local disk
 * storage (see file-storage.ts). The /api/files and /api/upload routes
 * dispatch here when the storage backend is not Supabase, keeping the
 * bucket-based implementations untouched.
 *
 * Endpoint compatibility notes:
 * - GET /api/files accepts both `path` and the REST client's legacy `id`
 *   parameter (they name the same storage path).
 * - Downloads work with agent auth, a dashboard session, or a valid
 *   signed-URL signature; signed URLs can only be minted by an
 *   authenticated caller.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, createHash } from 'node:crypto';
import { formatSize, DASHBOARD_ADMIN_AGENT, DIRECT_MESSAGES_CHANNEL } from '@airchat/shared';
import type { AgentContext } from '@airchat/shared';
import { authenticateAgent, isAuthError, getStorageAdapter } from '@/lib/api-v2-auth';
import { isDashboardAuthenticated } from '@/lib/dashboard-auth';
import {
  isSafeStoragePath,
  saveFile,
  loadFile,
  listFolder,
  signFilePath,
  verifyFileSignature,
} from '@/lib/file-storage';

const SIGNED_URL_TTL_S = 3600;
const MAX_AGENT_UPLOAD_BYTES = 10 * 1024 * 1024; // JSON API
const MAX_DASHBOARD_UPLOAD_BYTES = 50 * 1024 * 1024; // browser form upload
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,99}$/;

/** MIME types that could execute scripts if served inline. */
const DANGEROUS_MIME_TYPES = new Set([
  'text/html', 'application/xhtml+xml', 'application/javascript',
  'text/javascript', 'image/svg+xml', 'application/xml',
]);

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function safeMime(type: string | null | undefined): string {
  const raw = type || 'application/octet-stream';
  return DANGEROUS_MIME_TYPES.has(raw) ? 'application/octet-stream' : raw;
}

/** Authenticated as either a registered agent or a dashboard user? */
async function callerContext(
  request: NextRequest
): Promise<{ agent: AgentContext | null; dashboard: boolean } | null> {
  const auth = await authenticateAgent(request);
  if (!isAuthError(auth)) return { agent: auth, dashboard: false };
  if (await isDashboardAuthenticated()) return { agent: null, dashboard: true };
  return null;
}

/** The lazily created agent identity behind dashboard-originated posts. */
async function dashboardAgentContext(): Promise<AgentContext> {
  const adapter = getStorageAdapter();
  let agent = await adapter.findAgentByName(DASHBOARD_ADMIN_AGENT);
  if (!agent) {
    const placeholderHash = createHash('sha256').update(randomBytes(32)).digest('hex');
    agent = await adapter.registerAgent(DASHBOARD_ADMIN_AGENT, 'dashboard', placeholderHash);
  }
  return {
    agentId: agent.id,
    agentName: agent.name,
    machineId: agent.machine_id ?? 'dashboard',
  };
}

async function announceUpload(
  ctx: AgentContext,
  channel: string,
  content: string,
  file: { name: string; size: number; type: string; path: string },
  source: string
): Promise<void> {
  await getStorageAdapter().forAgent(ctx).sendMessage(channel, content, {
    source,
    files: [{ ...file, bucket: 'local' }],
  });
}

// ── GET /api/files ───────────────────────────────────────────────────────────

export async function localFileGet(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const filePath = params.get('path') ?? params.get('id');
  const urlOnly = params.get('url') === 'true';

  if (!filePath || !isSafeStoragePath(filePath)) {
    return NextResponse.json({ error: 'Missing or invalid file path' }, { status: 400 });
  }

  const signatureValid =
    !urlOnly &&
    params.has('sig') &&
    (await verifyFileSignature(
      filePath,
      Number(params.get('expires')),
      params.get('sig')!
    ));

  if (!signatureValid && !(await callerContext(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (urlOnly) {
    const { expires, sig } = await signFilePath(filePath, SIGNED_URL_TTL_S);
    const url = new URL('/api/files', request.nextUrl.origin);
    url.searchParams.set('path', filePath);
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('sig', sig);
    return NextResponse.json({ signed_url: url.toString(), expires_in: SIGNED_URL_TTL_S });
  }

  const file = await loadFile(filePath);
  if (!file) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const downloadName = sanitizeFileName(filePath.split('/').pop() || 'download');
  return new NextResponse(new Uint8Array(file.content), {
    headers: {
      'Content-Type': safeMime(file.meta?.type),
      'Content-Length': String(file.content.length),
      'Content-Disposition': `attachment; filename="${downloadName}"`,
    },
  });
}

// ── PUT /api/files and JSON POST /api/upload (agent uploads) ────────────────

interface AgentUploadBody {
  filename: string;
  content: string;
  channel: string;
  content_type?: string;
  encoding?: 'base64' | 'utf-8';
  post_message?: boolean;
}

export async function localFilePut(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateAgent(request);
  if (isAuthError(auth)) return auth;

  let body: AgentUploadBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { filename, content, channel, content_type, encoding, post_message } = body;
  if (!filename || !content || !channel) {
    return NextResponse.json({ error: 'filename, content, and channel are required' }, { status: 400 });
  }
  if (!CHANNEL_NAME_RE.test(channel)) {
    return NextResponse.json({ error: 'Invalid channel name' }, { status: 400 });
  }

  const buffer = encoding === 'base64'
    ? Buffer.from(content, 'base64')
    : Buffer.from(content, 'utf-8');
  if (buffer.length > MAX_AGENT_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${MAX_AGENT_UPLOAD_BYTES / 1024 / 1024}MB)` },
      { status: 400 }
    );
  }

  const safeName = sanitizeFileName(filename);
  const storagePath = `${channel}/${Date.now()}-${safeName}`;
  const mimeType = safeMime(content_type);

  try {
    await saveFile(storagePath, buffer, {
      name: safeName,
      size: buffer.length,
      type: mimeType,
      channel,
      uploaded_by: auth.agentName,
      created_at: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }

  if (post_message !== false) {
    await announceUpload(
      auth,
      channel,
      `Shared a file: **${safeName}** (${formatSize(buffer.length)})`,
      { name: safeName, size: buffer.length, type: mimeType, path: storagePath },
      'agent-upload'
    );
  }

  return NextResponse.json({
    file: { name: filename, size: buffer.length, path: storagePath, bucket: 'local' },
  });
}

// ── POST /api/files (list a folder) ──────────────────────────────────────────

export async function localFileList(request: NextRequest): Promise<NextResponse> {
  if (!(await callerContext(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let folder: string;
  try {
    ({ folder } = await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!folder || !isSafeStoragePath(folder) || folder.includes('/')) {
    return NextResponse.json({ error: 'Invalid folder path' }, { status: 400 });
  }

  return NextResponse.json({ files: await listFolder(folder) });
}

// ── POST /api/upload ─────────────────────────────────────────────────────────
//
// Two callers share this endpoint: the dashboard sends multipart form data
// with a cookie session; the REST client sends the same JSON body as
// PUT /api/files with agent auth.

export async function localUpload(request: NextRequest): Promise<NextResponse> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return localFilePut(request);
  }

  if (!(await isDashboardAuthenticated())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  const channel = formData.get('channel') as string | null;
  const targetAgent = formData.get('target_agent') as string | null;

  if (!file || !channel) {
    return NextResponse.json({ error: 'File and channel are required' }, { status: 400 });
  }
  if (!CHANNEL_NAME_RE.test(channel)) {
    return NextResponse.json({ error: 'Invalid channel name' }, { status: 400 });
  }
  if (file.size > MAX_DASHBOARD_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'File too large (max 50MB)' }, { status: 400 });
  }

  const safeName = sanitizeFileName(file.name);
  const storagePath = `${channel}/${Date.now()}-${safeName}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = safeMime(file.type);

  try {
    await saveFile(storagePath, buffer, {
      name: safeName,
      size: file.size,
      type: mimeType,
      channel,
      uploaded_by: DASHBOARD_ADMIN_AGENT,
      created_at: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }

  const ctx = await dashboardAgentContext();
  const announcement = targetAgent
    ? `@${targetAgent} Shared a file: **${safeName}** (${formatSize(file.size)})`
    : `Shared a file: **${safeName}** (${formatSize(file.size)})`;
  await announceUpload(
    ctx,
    targetAgent ? DIRECT_MESSAGES_CHANNEL : channel,
    announcement,
    { name: safeName, size: file.size, type: mimeType, path: storagePath },
    'dashboard'
  );

  return NextResponse.json({
    file: { name: file.name, size: file.size, path: storagePath, bucket: 'local' },
  });
}
