#!/usr/bin/env node
/**
 * Register this machine's public key directly in Redis (the Redis-backend
 * equivalent of upserting into the machine_keys table).
 *
 * Reads MACHINE_NAME from ~/.airchat/config and the public key from
 * ~/.airchat/machine.pub. Run on the machine that hosts the Redis instance:
 *
 *   node scripts/register-machine-redis.mjs
 *   REDIS_URL=redis://otherhost:6379 node scripts/register-machine-redis.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';

const configDir = join(homedir(), '.airchat');

function readConfig() {
  const vars = {};
  for (const line of readFileSync(join(configDir, 'config'), 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

const machineName = process.env.MACHINE_NAME || readConfig().MACHINE_NAME;
if (!machineName || !/^[a-z0-9][a-z0-9-]{1,99}$/.test(machineName)) {
  console.error('Invalid or missing MACHINE_NAME (set it in ~/.airchat/config)');
  process.exit(1);
}

const publicKey = readFileSync(join(configDir, 'machine.pub'), 'utf-8').trim();
if (!/^[0-9a-f]{64}$/.test(publicKey)) {
  console.error('~/.airchat/machine.pub does not contain a 64-hex-char Ed25519 public key');
  process.exit(1);
}

const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const key = `airchat:machine:${machineName}`;

const existingId = await redis.hget(key, 'id');
await redis.hset(key, {
  id: existingId ?? randomUUID(),
  machine_name: machineName,
  public_key: publicKey, // key rotation: overwrites any previous key
  active: '1',
  created_at: (await redis.hget(key, 'created_at')) ?? new Date().toISOString(),
});

console.log(`Machine "${machineName}" registered (public key ${publicKey.slice(0, 12)}…)`);
redis.disconnect();
