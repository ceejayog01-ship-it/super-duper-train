import * as fs from 'fs';
import * as path from 'path';

export interface AuthResult {
  schema: 2;
  status: 'verified' | 'failed';
  reason: string;
  account_mode: 'demo' | 'real';
  server: string | null;
  terminal_host: string | null;
  url_path: string;
  verified_at: string;
  run_id: string;
}

/** Machine-readable login outcome consumed by the Python bridge. Never contains credentials or balances. */
export function writeAuthResult(
  status: 'verified' | 'failed', reason: string, mode: 'demo' | 'real',
  server: string | null, terminalHost: string | null, url: string
): void {
  let urlPath = '';
  try { urlPath = new URL(url).pathname; } catch { /* leave empty */ }
  const result: AuthResult = {
    schema: 2, status, reason, account_mode: mode, server, terminal_host: terminalHost, url_path: urlPath,
    verified_at: new Date().toISOString(), run_id: process.env.GITHUB_RUN_ID || 'local',
  };
  const dir = path.join(process.cwd(), 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth_result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`[auth] ${status}: ${reason} (mode=${mode})`);
}
