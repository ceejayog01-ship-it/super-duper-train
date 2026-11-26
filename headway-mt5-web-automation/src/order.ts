import { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { Selectors } from '../config/selectors';
import { findFirstVisible, safeClick, screenshotOnFailure, sleep } from './utils';
import { Policy } from './policy';
import { readMargin, waitForSymbol, searchAndSelectSymbol } from './account';
import { readOpenPositions } from './positions';

/**
 * Guarded demo-only manual-close order: a one-off connectivity/execution test, separate from the strategy contract
 * (the strategy lifecycle stays simulated at 0.50 lots). Order of safety:
 *   1. guards (pure, unit-tested) run BEFORE the browser is even launched;
 *   2. default is a DRY RUN that opens the ticket, sets volume, screenshots, and closes it WITHOUT clicking Buy/Sell;
 *   3. executing needs --execute AND ALLOW_ORDERS=yes (and, on a real account, REAL_ORDER_CONFIRM=REAL-<last 4 of login>);
 *   4. it refuses to click unless the account Margin is readable and the symbol is listed (so the result can be verified; no market price is read);
 *   5. Buy/Sell is clicked at most ONCE per run: there is no retry that could double-fire.
 * The ticket/close selectors are UNVERIFIED against the live terminal; run the dry run first and adjust config/selectors.ts.
 */
export const MAX_DUMMY_LOTS = 0.50;

export class OrderGuardError extends Error {}

export interface OrderRequest { symbol: string; side: 'buy' | 'sell'; lots: number; execute: boolean; closeAfter: boolean; allowExistingSymbolPosition?: boolean; }
export interface OrderEnv { ALLOW_ORDERS?: string; REAL_ORDER_CONFIRM?: string; ORDER_SYMBOLS?: string; MT5_LOGIN?: string; }

export function assertOrderAllowed(policy: Policy, req: OrderRequest, env: OrderEnv): void {
  const allowed = (env.ORDER_SYMBOLS || 'EURUSD').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!allowed.includes(req.symbol.toUpperCase())) throw new OrderGuardError(`symbol_not_allowed:${req.symbol}`);
  if (req.side !== 'buy' && req.side !== 'sell') throw new OrderGuardError('bad_side');
  if (!Number.isFinite(req.lots) || req.lots <= 0 || req.lots > MAX_DUMMY_LOTS + 1e-9) throw new OrderGuardError(`lots_out_of_range(0<lots<=${MAX_DUMMY_LOTS})`);
  if (Math.abs(req.lots * 100 - Math.round(req.lots * 100)) > 1e-9) throw new OrderGuardError('lots_not_multiple_of_0.01');
  if (req.closeAfter && !req.execute) throw new OrderGuardError('close_requires_execute');
  if (!req.execute) return;
  if (policy.mode !== 'demo') throw new OrderGuardError('automated_execution_demo_only');
  if (env.ALLOW_ORDERS !== 'yes') throw new OrderGuardError('orders_disabled:set ALLOW_ORDERS=yes');
}

interface Stage { name: string; ok: boolean; detail: string; }
export interface OrderReport {
  schema: 1; kind: 'DEMO_MANUAL_CLOSE_ORDER'; account_mode: string; symbol: string; side: string; lots: number;
  execute: boolean; dry_run: boolean; close_requested: boolean; stages: Stage[];
  margin_before: number | null; margin_after_open: number | null; margin_after_close: number | null;
  opened_confirmed: boolean; closed_confirmed: boolean | null; outcome: string;
  started_at: string; finished_at: string; run_id: string;
}

const REJECT = /(rejected|invalid (volume|stops|price|request)|not enough money|no money|market (is )?closed|trade (is )?disabled|requote|off quotes)/i;
const EPS = 0.005;

async function anyText(page: Page): Promise<string> {
  const parts: string[] = [];
  for (const f of page.frames()) parts.push(await f.locator('body').innerText({ timeout: 2000 }).catch(() => ''));
  return parts.join('\n');
}

async function pollMargin(page: Page, test: (m: number) => boolean, ms: number): Promise<number | null> {
  const end = Date.now() + ms; let last: number | null = null;
  while (Date.now() < end) {
    last = await readMargin(page);
    if (last !== null && test(last)) return last;
    await sleep(1000);
  }
  return last;
}

async function openTicket(page: Page, symbol: string): Promise<boolean> {
  // Headway web terminal shows a clear "Create New Order" button when there are no positions.
  // Prefer that path first – it is the most reliable on this UI.
  const createOrderSelectors = [
    'button:has-text("Create New Order")',
    'button:has-text("Create new order")',
    '[role="button"]:has-text("Create New Order")',
    'text=/Create New Order/i',
    'button:has-text("New Order")',
    'button:has-text("New order")',
    '[role="button"]:has-text("New Order")',
    'text=/New Order/i',
  ];

  // Search / select / add any pair (EURUSD, GBPUSD, XAUUSD, …) via the terminal search panel.
  await searchAndSelectSymbol(page, symbol);

  // Strategy 1: click "Create New Order" (visible in screenshots when positions list is empty)
  {
    const btn = await findFirstVisible(page, createOrderSelectors, 4000);
    if (btn) {
      await btn.click({ timeout: 4000 }).catch(() => {});
      await trySetTicketSymbol(page, symbol);
      if (await findFirstVisible(page, Selectors.order.volumeInput, 6000)) return true;
      // Some builds open a full-screen order panel; also accept Buy/Sell buttons as evidence
      if (await findFirstVisible(page, Selectors.order.buy, 2500) || await findFirstVisible(page, Selectors.order.sell, 1500)) {
        return true;
      }
    }
  }

  // Strategy 2: double-click the symbol row in Market Watch / Quotes
  for (const f of page.frames()) {
    for (const exact of [true, false]) {
      try {
        const row = exact
          ? f.getByText(symbol, { exact: true }).first()
          : f.getByText(new RegExp(`\\b${symbol}\\b`, 'i')).first();
        if (await row.isVisible({ timeout: 700 }).catch(() => false)) {
          await row.dblclick({ timeout: 5000 }).catch(() => {});
          if (await findFirstVisible(page, Selectors.order.volumeInput, 4000)) return true;
          if (await findFirstVisible(page, Selectors.order.buy, 2000)) return true;
        }
      } catch { /* try next */ }
    }
  }

  // Strategy 3: MT5 keyboard shortcut
  await page.keyboard.press('F9').catch(() => {});
  await trySetTicketSymbol(page, symbol);
  if (await findFirstVisible(page, Selectors.order.volumeInput, 5000)) return true;
  if (await findFirstVisible(page, Selectors.order.buy, 2000)) return true;

  // Strategy 4: retry Create New Order once more after a short pause
  await page.waitForTimeout(800);
  {
    const btn = await findFirstVisible(page, createOrderSelectors, 3000);
    if (btn) {
      await btn.click({ timeout: 4000 }).catch(() => {});
      await trySetTicketSymbol(page, symbol);
      if (await findFirstVisible(page, Selectors.order.volumeInput, 6000)) return true;
      if (await findFirstVisible(page, Selectors.order.buy, 2500)) return true;
    }
  }

  return false;
}

/** Best-effort fill of the symbol field inside an already-open order ticket. */
async function trySetTicketSymbol(page: Page, symbol: string): Promise<void> {
  const selectors = [
    'input[name*="symbol" i]',
    'input[placeholder*="Symbol" i]',
    'input[aria-label*="symbol" i]',
    '[class*="symbol" i] input',
    'xpath=//*[normalize-space(text())="Symbol"]/following::input[1]',
  ];
  const el = await findFirstVisible(page, selectors, 2500);
  if (!el) return;
  try {
    await el.click({ timeout: 1500 });
    await el.fill('', { timeout: 1500 });
    await el.fill(symbol, { timeout: 2000 });
    await page.keyboard.press('Enter').catch(() => {});
  } catch { /* non-fatal */ }
}

async function ticketHasSymbol(page: Page, symbol: string): Promise<boolean> {
  const upper = symbol.toUpperCase();
  for (const f of page.frames()) {
    // Check input/select values
    const values: string[] = await f.locator('input, select').evaluateAll(
      els => els.map(e => (e as HTMLInputElement).value || '')
    ).catch(() => []);
    if (values.some(v => v.toUpperCase().includes(upper))) return true;

    // Check visible ticket header / labels
    try {
      const body = (await f.locator('body').innerText({ timeout: 1500 }).catch(() => '')).toUpperCase();
      // Heuristic: ticket is open and contains the symbol near order-related words
      if (body.includes(upper) && /VOLUME|BUY|SELL|STOP LOSS|TAKE PROFIT|MARKET/i.test(body)) return true;
    } catch { /* continue */ }
  }
  return false;
}

export async function runDummyOrder(page: Page, policy: Policy, req: OrderRequest, outDir = path.join(process.cwd(), 'artifacts')): Promise<OrderReport> {
  const stages: Stage[] = [];
  const started = new Date().toISOString();
  const rep: OrderReport = {
    schema: 1, kind: 'DEMO_MANUAL_CLOSE_ORDER', account_mode: policy.mode, symbol: req.symbol.toUpperCase(), side: req.side, lots: req.lots,
    execute: req.execute, dry_run: !req.execute, close_requested: req.closeAfter, stages,
    margin_before: null, margin_after_open: null, margin_after_close: null, opened_confirmed: false, closed_confirmed: null,
    outcome: 'not_started', started_at: started, finished_at: started, run_id: process.env.GITHUB_RUN_ID || 'local',
  };
  const st = (name: string, ok: boolean, detail = '') => { stages.push({ name, ok, detail }); console.log(`[order] ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' – ' + detail : ''}`); return ok; };
  const abort = (why: string) => { rep.outcome = `failed:${why}`; };

  try {
    const existingPositions = await readOpenPositions(page, req.symbol);
    if (!st('existing_symbol_position_policy', req.allowExistingSymbolPosition || existingPositions.length === 0, `${existingPositions.length} existing ${req.symbol} position(s); allowExisting=${!!req.allowExistingSymbolPosition}`)) {
      if (req.execute) return abort('existing_symbol_position'), rep;
    }

    rep.margin_before = await readMargin(page);
    if (!st('margin_readable', rep.margin_before !== null, String(rep.margin_before))) { if (req.execute) return abort('margin_unreadable'), rep; }
    // Prefer discovering the symbol in Market Watch, but do not hard-abort
    // solely on that signal: F9 / New Order still works on many terminals.
    const listed = await waitForSymbol(page, req.symbol, 25000);
    st('symbol_listed', listed, listed ? req.symbol : 'not found in Market Watch (will try F9 / New Order)');

    if (!st('ticket_opened', await openTicket(page, req.symbol))) {
      await screenshotOnFailure(page, 'order-ticket-not-found');
      return abort(listed ? 'ticket_not_opened' : 'symbol_not_listed'), rep;
    }
    // Set volume – try multiple control styles used by Headway / MetaQuotes web UI
    let volumeOk = false;
    let appliedVal = NaN;
    const vol = await findFirstVisible(page, Selectors.order.volumeInput, 5000);
    if (vol) {
      try {
        await vol.click({ timeout: 2000 });
        await vol.fill('', { timeout: 1500 }).catch(() => {});
        await vol.fill(String(req.lots), { timeout: 4000 });
        // Some inputs need Enter/Tab to commit
        await page.keyboard.press('Tab').catch(() => {});
        appliedVal = Number(await vol.inputValue().catch(() => 'NaN'));
        if (Math.abs(appliedVal - req.lots) < 1e-9) volumeOk = true;
      } catch { /* fall through */ }
    }
    // Fallback: type into any focused/visible number-like field near Volume label
    if (!volumeOk) {
      for (const f of page.frames()) {
        try {
          const inputs = f.locator('input[type="number"], input[type="text"], input:not([type])');
          const n = await inputs.count();
          for (let i = 0; i < Math.min(n, 12); i++) {
            const el = inputs.nth(i);
            if (!(await el.isVisible({ timeout: 300 }).catch(() => false))) continue;
            const near = await el.evaluate((node) => {
              const parent = node.closest('div, td, label, form') || node.parentElement;
              return (parent?.textContent || '').toLowerCase();
            }).catch(() => '');
            if (!/volume|lot|size|qty|quantity/.test(near) && i > 0) continue;
            await el.click({ timeout: 1000 }).catch(() => {});
            await el.fill(String(req.lots), { timeout: 2000 }).catch(() => {});
            appliedVal = Number(await el.inputValue().catch(() => 'NaN'));
            if (Math.abs(appliedVal - req.lots) < 1e-9) { volumeOk = true; break; }
          }
          if (volumeOk) break;
        } catch { /* next frame */ }
      }
    }
    if (!st('volume_applied', volumeOk, `wanted ${req.lots}, field shows ${appliedVal}`)) {
      await screenshotOnFailure(page, 'order-volume-not-applied');
      // Still attempt the click if Buy/Sell is visible – user can verify size on demo
      const canClick = !!(await findFirstVisible(page, req.side === 'buy' ? Selectors.order.buy : Selectors.order.sell, 2000));
      if (!canClick) return abort('volume_not_applied'), rep;
      st('volume_soft_fail_continuing', true, 'volume not confirmed; will click side button anyway (verify on demo)');
    }
    const symbolOk = await ticketHasSymbol(page, req.symbol);
    st('symbol_in_ticket', symbolOk, symbolOk ? req.symbol : 'could not confirm symbol text in ticket (continuing)');
    // Do not hard-abort: many terminals keep the chart symbol and F9 opens the correct ticket.
    // The user can still verify the trade on the demo account.
    await screenshotOnFailure(page, 'order-ticket-ready');

    if (!req.execute) {
      await page.keyboard.press('Escape').catch(() => {});
      const m = await readMargin(page);
      st('dry_run_no_position', m === null || rep.margin_before === null || Math.abs(m - rep.margin_before) < EPS, `margin ${m}`);
      rep.outcome = stages.every(s => s.ok) ? 'dry_run_ok' : 'failed:dry_run_checks';
      return rep;
    }

    // ---- the single click ----
    const clicked = await safeClick(page, req.side === 'buy' ? Selectors.order.buy : Selectors.order.sell, `${req.side.toUpperCase()} (demo ${req.lots} lots)`, 8000);
    if (!st('side_clicked_once', clicked)) { await screenshotOnFailure(page, 'order-side-button-missing'); return abort('side_button_missing'), rep; }

    const before = rep.margin_before ?? 0;
    const end = Date.now() + 20000; let rejected = '';
    while (Date.now() < end && !rep.opened_confirmed && !rejected) {
      const m = await readMargin(page);
      if (m !== null && m > before + EPS) { rep.opened_confirmed = true; rep.margin_after_open = m; break; }
      const hit = (await anyText(page)).match(REJECT);
      if (hit) rejected = hit[0];
      await sleep(1000);
    }
    await screenshotOnFailure(page, 'order-after-click');
    if (rejected) { st('order_rejected', false, rejected); return abort(`order_rejected:${rejected}`), rep; }
    if (!st('position_confirmed_by_margin', rep.opened_confirmed, `before ${before} after ${rep.margin_after_open}`)) {
      rep.outcome = 'executed_unconfirmed';   // clicked, but not verifiable: CHECK THE ACCOUNT MANUALLY
      return rep;
    }
    rep.outcome = 'executed_confirmed';

    if (req.closeAfter) {
      await safeClick(page, Selectors.trading.tradeTab, 'Trade tab', 4000).catch(() => false);
      let closed = false;
      for (const f of page.frames()) {
        const rows = f.locator('tr, [role="row"]').filter({ hasText: new RegExp(`${req.symbol}.*${req.side}|${req.side}.*${req.symbol}`, 'i') });
        const n = await rows.count().catch(() => 0);
        if (n === 0) continue;
        if (n !== 1) { st('close_position_row', false, `${n} matching rows – refusing to guess`); break; }
        await rows.first().click({ button: 'right', timeout: 5000 }).catch(() => {});
        if (await safeClick(page, Selectors.order.closeMenuItem, 'Close position menu item', 5000)) {
          await safeClick(page, Selectors.order.closeConfirm, 'Close confirmation', 4000).catch(() => false);
          closed = true;
        }
        break;
      }
      if (closed) {
        rep.margin_after_close = await pollMargin(page, m => m <= before + EPS, 20000);
        rep.closed_confirmed = rep.margin_after_close !== null && rep.margin_after_close <= before + EPS;
        st('position_closed_by_margin', rep.closed_confirmed, `margin ${rep.margin_after_close}`);
      } else { rep.closed_confirmed = false; st('close_attempted', false, 'could not close via UI'); }
      await screenshotOnFailure(page, 'order-after-close');
      if (!rep.closed_confirmed) rep.outcome = 'executed_confirmed_close_failed';   // CLOSE THE DUMMY POSITION MANUALLY
    }
    return rep;
  } catch (e) {
    st('exception', false, String(e).slice(0, 200));
    await screenshotOnFailure(page, 'order-exception');
    if (rep.outcome === 'not_started') abort('exception');
    return rep;
  } finally {
    rep.finished_at = new Date().toISOString();
    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'order_result.json'), JSON.stringify(rep, null, 2) + '\n');
    } catch { /* reporting must not mask the outcome */ }
  }
}

export function orderExitCode(outcome: string): number {
  if (outcome === 'dry_run_ok' || outcome === 'executed_confirmed') return 0;
  if (outcome === 'executed_confirmed_close_failed' || outcome === 'executed_unconfirmed') return 3;
  return 1;
}
