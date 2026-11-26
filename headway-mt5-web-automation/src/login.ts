import { Page, Frame } from 'playwright';
import { Selectors } from '../config/selectors';
import { safeFill, safeClick, findFirstVisible, screenshotOnFailure, sleep, savePostLoginDiagnostics } from './utils';
import { Policy, loadPolicy, hostOf, checkEntry } from './policy';

export interface LoginCredentials {
  login: string;
  password: string;
  url: string;
}

/** Outcome of the most recent performLogin(), for the caller (index.ts) to record. Contains no credentials. */
export interface LoginReport { mode: 'demo' | 'real'; verified: boolean; reason: string; server: string | null; terminalHost: string | null; expectedLogin: string | null; observedLogin: string | null; observedServer: string | null; accountIdentityVerified: boolean; serverIdentityVerified: boolean; }
let lastLoginReport: LoginReport | null = null;
export function getLastLoginReport(): LoginReport | null { return lastLoginReport; }

async function inspectConnectedTerminal(page: Page, policy: Policy, entryUrl: string) {
  const frames = page.frames();
  let terminalHostName = '';
  let authError = false;
  let loginFormVisible = false;
  let terminalEvidence = false;
  const frameReports: Array<Record<string, unknown>> = [];

  for (const [index, frame] of frames.entries()) {
    const url = frame.url();
    const host = hostOf(url);
    const approvedTerminalFrame = policy.terminalHost(host);
    const text = await frame.locator('body').innerText({ timeout: 2500 }).catch(() => '');
    const normalized = text.replace(/\s+/g, ' ').trim();
    const lower = normalized.toLowerCase();
    const hasLoginInput = await frame.locator('input[type="password"], input[name*="login" i], input[placeholder*="login" i]').count().catch(() => 0);
    const visibleLoginInput = hasLoginInput > 0 && await frame.locator('input[type="password"], input[name*="login" i], input[placeholder*="login" i]').first().isVisible().catch(() => false);
    if (visibleLoginInput) loginFormVisible = true;
    if (approvedTerminalFrame) terminalHostName = host;
    if (/invalid (login|password)|authorization failed|account is disabled|connection failed|wrong password|login failed/i.test(lower)) authError = true;

    // Authentication evidence is a live terminal workspace, not account-number
    // matching, balances, Market Watch layout, or a visible price chart.
    const workspaceMarker = /market watch|toolbox|navigator|positions|orders|trade|quotes|disconnect|log out|logout/i.test(lower);
    if (workspaceMarker) terminalEvidence = true;
    frameReports.push({ index, host, approvedTerminalFrame, visibleLoginInput, workspaceMarker, authError });
  }

  const entryOk = checkEntry(policy, entryUrl).ok;
  const success = entryOk && terminalEvidence && !loginFormVisible && !authError;
  return { success, accountMode: policy.mode, terminalHostName, terminalEvidence, loginFormVisible, authError, frameReports };
}

export async function performLogin(page: Page, creds: LoginCredentials): Promise<boolean> {
  const policy = loadPolicy();
  const fail = (reason: string): false => {
    lastLoginReport = { mode: policy.mode, verified: false, reason, server: null, terminalHost: null, expectedLogin: null, observedLogin: null, observedServer: null, accountIdentityVerified: false, serverIdentityVerified: false };
    return false;
  };
  console.log(`[login] Account mode: ${policy.mode.toUpperCase()}`);
  console.log('[login] Navigating to', creds.url);
  try {
    await page.goto(creds.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.error('[login] Navigation failed:', e);
    await screenshotOnFailure(page, 'nav-failed');
    return fail('navigation_failed');
  }

  await sleep(4000);
  const bodyText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (bodyText.includes('verifying') || bodyText.includes('cloudflare')) await sleep(8000);

  // Require an allowed Headway entry point whose path agrees with the declared mode.
  const entry = checkEntry(policy, creds.url);
  if (!entry.ok) {
    console.error(`[login] SAFETY ABORT: URL rejected for ${policy.mode} mode (${entry.reason}).`);
    await screenshotOnFailure(page, 'entry-url-abort');
    return fail(entry.reason);
  }

  // Do not require the exact server label or account-number identity.
  // Headway may render the server selector differently across sessions.
  // Submit the configured credentials and verify that the login form disappears
  // and a terminal workspace is established before allowing any downstream action.
  console.log(`[login] ${policy.mode} endpoint accepted; submitting credentials without exact server-label matching.`);

  if (!await safeFill(page, Selectors.login.loginInput, creds.login, 'Login field')) {
    await screenshotOnFailure(page, 'login-field-missing'); return fail('login_field_missing');
  }
  if (!await safeFill(page, Selectors.login.passwordInput, creds.password, 'Password field')) {
    await screenshotOnFailure(page, 'password-field-missing'); return fail('password_field_missing');
  }
  if (!await safeClick(page, Selectors.login.connectButton, 'Connect to account button')) {
    await screenshotOnFailure(page, 'connect-button-missing'); return fail('connect_button_missing');
  }

  console.log(`[login] Credentials submitted to the confirmed ${policy.mode} endpoint; waiting for terminal state.`);
  const deadline = Date.now() + 45000;
  let result = await inspectConnectedTerminal(page, policy, creds.url);
  while (Date.now() < deadline && !result.success && !result.authError) {
    await sleep(1500);
    result = await inspectConnectedTerminal(page, policy, creds.url);
  }

  if (result.success) {
    console.log(`[login] LOGIN SUCCESS: ${policy.mode} terminal workspace established; no exact server-label or account-number matching required.`);
    await savePostLoginDiagnostics(page, 'login-verified', result);
    lastLoginReport = { mode: policy.mode, verified: true, reason: 'authenticated_terminal_session', server: null, terminalHost: result.terminalHostName, expectedLogin: null, observedLogin: null, observedServer: null, accountIdentityVerified: false, serverIdentityVerified: false };
    return true;
  }

  console.error('[login] AUTHENTICATION NOT CONFIRMED:', {
    terminalEvidence: result.terminalEvidence, loginFormVisible: result.loginFormVisible, authError: result.authError,
  });
  await savePostLoginDiagnostics(page, 'login-unverified', result);
  const reason = result.authError ? 'auth_error' : (result.loginFormVisible ? 'login_form_still_visible' : 'terminal_session_not_confirmed');
  lastLoginReport = {
    mode: policy.mode, verified: false, reason, server: null,
    terminalHost: result.terminalHostName || null, expectedLogin: null,
    observedLogin: null, observedServer: null, accountIdentityVerified: false, serverIdentityVerified: false,
  };
  return false;
}
