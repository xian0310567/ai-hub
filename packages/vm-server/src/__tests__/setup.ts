/**
 * Vitest global setup — runs before every test file in the single fork.
 * Sets environment variables BEFORE schema.ts is first imported.
 */
import { mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testDir = join(tmpdir(), 'vitest-vm-test');
mkdirSync(testDir, { recursive: true });

process.env.DATA_DIR = testDir;
// 32-byte hex key (64 chars) for vault envelope encryption
process.env.VAULT_MASTER_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
process.env.COOKIE_SECRET = 'test-cookie-secret-32-chars-long!!';
