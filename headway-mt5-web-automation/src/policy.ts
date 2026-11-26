/**
 * Account policy: replaces the former hard-coded "demo only" gates.
 *
 * ACCOUNT_MODE=demo (default) keeps the exact checks the verified login was built on.
 * ACCOUNT_MODE=real permits read-only connection/inspection only; all automated order execution is blocked by order guards:
 *   - the declared mode must agree with the configured entry URL;
 *   - no exact server label or account-number identity is required.
 * Pure functions only, so the whole policy is unit-tested without a browser.
 */
export type AccountMode = 'demo' | 'real';

export interface Policy {
  mode: AccountMode;
  entryHosts: string[];
  terminalHost: (host: string) => boolean;
  blockedKeywords: string[];           // demo mode only
}

export class PolicyError extends Error {}

type Env = Record<string, string | undefined>;

export function loadPolicy(env: Env = process.env): Policy {
  const mode = (env.ACCOUNT_MODE || 'demo').trim().toLowerCase();
  if (mode !== 'demo' && mode !== 'real') throw new PolicyError(`ACCOUNT_MODE must be "demo" or "real", got "${mode}"`);
  const entryHosts = (env.ALLOWED_ENTRY_HOSTS || 'hw.online').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const pinned = (env.EXPECTED_TERMINAL_HOST || '').trim().toLowerCase();

  if (mode === 'demo') {
    return {
      mode, entryHosts,
      terminalHost: h => (pinned ? h === pinned : h === 'demo-mt5.hw-terminal.com'),
      blockedKeywords: (env.BLOCKED_SERVER_KEYWORDS || 'Real,Live').split(',').map(s => s.trim()).filter(Boolean),
    };
  }
  // Server labels are not identity gates. Real-mode endpoint and successful
  // terminal-session evidence are sufficient; no exact server text is required.
  return {
    mode, entryHosts,
    terminalHost: h => (pinned ? h === pinned : /(^|\.)hw-terminal\.com$/.test(h) && !/^demo/.test(h)),
    blockedKeywords: [],
  };
}

export function hostOf(value: string): string {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}

/** Entry URL must be an allowed host, and its path must agree with the declared mode. */
export function checkEntry(p: Policy, url: string): { ok: boolean; reason: string } {
  if (!p.entryHosts.includes(hostOf(url))) return { ok: false, reason: 'entry_host_not_allowed' };
  const demoPath = /mt5-demo/i.test(url);
  if (p.mode === 'demo' && !demoPath) return { ok: false, reason: 'demo_mode_but_url_not_demo' };
  if (p.mode === 'real' && demoPath) return { ok: false, reason: 'real_mode_but_url_is_demo' };
  return { ok: true, reason: 'ok' };
}
