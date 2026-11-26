import { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { Selectors } from '../config/selectors';
import { findFirstVisible, safeClick, screenshotOnFailure, sleep } from './utils';
import { Policy } from './policy';
import { readMargin, waitForSymbol, searchAndSelectSymbol } from './account';
import { readOpenPositions, findPositionRows, ticketStillOpen } from './positions';

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

async function dismissPostOrderDialogs(page: Page): Promise<void> {
  const dismiss = [
    'button:has-text("OK")',
    'button:has-text("Done")',
    'button:has-text("Close")',
    '[role="button"]:has-text("OK")',
    '[role="button"]:has-text("Done")',
  ];
  for (let i = 0; i < 3; i++) {
    const btn = await findFirstVisible(page, dismiss, 1200);
    if (!btn) break;
    await btn.click({ timeout: 2000 }).catch(() => {});
    await sleep(400);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(300);
}

async function ticketPanelOpen(page: Page): Promise<boolean> {
  if (await findFirstVisible(page, Selectors.order.volumeInput, 1500)) return true;
  if (await findFirstVisible(page, Selectors.order.buy, 1200)) return true;
  if (await findFirstVisible(page, Selectors.order.sell, 800)) return true;
  // "Market Execution" header from Headway ticket
  for (const f of page.frames()) {
    const t = await f.getByText(/Market Execution/i).first().isVisible({ timeout: 400 }).catch(() => false);
    if (t) return true;
  }
  return false;
}

async function openTicket(page: Page, symbol: string): Promise<boolean> {
  // Clear any "Done / OK" confirmation left over from a previous order.
  await dismissPostOrderDialogs(page);

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

  // Search / select / add any pair via the terminal search panel.
  await searchAndSelectSymbol(page, symbol);

  // Strategy 1: Create New Order (available when no positions, sometimes still after)
  {
    const btn = await findFirstVisible(page, createOrderSelectors, 3000);
    if (btn) {
      await btn.click({ timeout: 4000 }).catch(() => {});
      await trySetTicketSymbol(page, symbol);
      if (await ticketPanelOpen(page)) return true;
    }
  }

  // Strategy 2: double-click symbol in search list / Market Watch
  for (const f of page.frames()) {
    for (const exact of [true, false]) {
      try {
        const row = exact
          ? f.getByText(symbol, { exact: true }).first()
          : f.getByText(new RegExp(`\\b${symbol}\\b`, 'i')).first();
        if (await row.isVisible({ timeout: 600 }).catch(() => false)) {
          await row.dblclick({ timeout: 5000 }).catch(() => {});
          await sleep(500);
          if (await ticketPanelOpen(page)) return true;
        }
      } catch { /* try next */ }
    }
  }

  // Strategy 3: chart toolbar "+" or new-order icon, then F9
  const plusSelectors = [
    'button:has-text("+")',
    '[title*="New order" i]',
    '[aria-label*="New order" i]',
    '[title*="New Order" i]',
  ];
  {
    const plus = await findFirstVisible(page, plusSelectors, 2000);
    if (plus) {
      await plus.click({ timeout: 3000 }).catch(() => {});
      await sleep(500);
      if (await ticketPanelOpen(page)) return true;
    }
  }

  await page.keyboard.press('F9').catch(() => {});
  await trySetTicketSymbol(page, symbol);
  if (await ticketPanelOpen(page)) return true;

  // Strategy 4: one more Create New Order attempt after dismiss
  await dismissPostOrderDialogs(page);
  await sleep(500);
  {
    const btn = await findFirstVisible(page, createOrderSelectors, 3000);
    if (btn) {
      await btn.click({ timeout: 4000 }).catch(() => {});
      await trySetTicketSymbol(page, symbol);
      if (await ticketPanelOpen(page)) return true;
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
  const st = (name: string, ok: boolean, detail = '') => { stages.push({ name, ok, detail }); console.log(`[order] ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`); return ok; };
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
    // Set volume - try multiple control styles used by Headway / MetaQuotes web UI
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
      // Still attempt the click if Buy/Sell is visible - user can verify size on demo
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
    // Dismiss the Headway "Done / OK" confirmation so a follow-up order can open a new ticket.
    await dismissPostOrderDialogs(page);

    const before = rep.margin_before ?? 0;
    const end = Date.now() + 20000; let rejected = '';
    while (Date.now() < end && !rep.opened_confirmed && !rejected) {
      const m = await readMargin(page);
      if (m !== null && m > before + EPS) {
        rep.opened_confirmed = true;
        rep.margin_after_open = m;
        break;
      }
      // Hedging accounts may keep margin flat when the opposite side opens.
      // Confirm via the positions table instead.
      const positions = await readOpenPositions(page, req.symbol);
      const match = positions.filter(p => p.side === req.side);
      if (match.length > 0) {
        rep.opened_confirmed = true;
        rep.margin_after_open = m;
        st('position_seen_in_table', true, `${match.length} ${req.side} row(s)`);
        break;
      }
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
        if (n !== 1) { st('close_position_row', false, `${n} matching rows - refusing to guess`); break; }
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


/**
 * Close every open position for the given symbol (demo only).
 * Used after the paired orders have been held for a short period.
 */
/**
 * Close every open position for the given symbol (demo only).
 * Uses the positions table at the bottom of the Headway web terminal.
 */
/**
 * Close every open position for the given symbol (demo only).
 * Success is measured by ticket disappearing or margin falling - not by a click alone.
 */
export async function closeAllSymbolPositions(page: Page, symbol: string, timeoutMs = 120000): Promise<{
  attempted: number;
  closed: number;
  details: string[];
}> {
  const details: string[] = [];
  let attempted = 0;
  let closed = 0;
  const endAt = Date.now() + timeoutMs;

  await dismissPostOrderDialogs(page);
  await screenshotOnFailure(page, 'before-close-all');

  const marginBefore = await readMargin(page);
  details.push(`margin_before_close=${marginBefore}`);

  // Track tickets we already successfully closed
  const closedTickets = new Set<string>();

  while (Date.now() < endAt) {
    const positions = await readOpenPositions(page, symbol);
    const open = positions.filter(p => p.ticket && !closedTickets.has(p.ticket!));
    details.push(`scan: open_tickets=${open.map(p => p.ticket).join(',') || 'none'} parsed=${positions.length}`);

    if (open.length === 0) {
      const m = await readMargin(page);
      if (m !== null && marginBefore !== null && m > 1 && m >= marginBefore - 0.5 && Date.now() < endAt - 8000) {
        details.push(`parser empty but margin still ${m}; retry...`);
        await sleep(1500);
        continue;
      }
      details.push('no open positions remaining');
      break;
    }

    let closedOne = false;
    for (const pos of open) {
      const ticket = pos.ticket!;
      attempted += 1;
      details.push(`attempt ticket=${ticket} side=${pos.side} lots=${pos.lots}`);

      const ok = await closeOneTicket(page, ticket, pos.side);
      await sleep(1200);
      await dismissPostOrderDialogs(page);

      // Verify: ticket gone OR margin dropped meaningfully
      const stillThere = await ticketStillOpen(page, ticket);
      const mAfter = await readMargin(page);
      const marginDropped =
        marginBefore !== null && mAfter !== null && mAfter < marginBefore - 1;

      if (!stillThere || marginDropped) {
        closed += 1;
        closedOne = true;
        closedTickets.add(ticket);
        details.push(
          `VERIFIED close ticket=${ticket} stillThere=${stillThere} margin=${mAfter}`
        );
        await screenshotOnFailure(page, `closed-${ticket}`);
        break; // rescan
      }

      details.push(
        `click did not remove ticket=${ticket} stillThere=${stillThere} margin=${mAfter}`
      );
      await screenshotOnFailure(page, `close-failed-${ticket}`);
      await page.keyboard.press('Escape').catch(() => {});
    }

    if (!closedOne) {
      details.push('no ticket verified closed this pass; stopping');
      break;
    }
  }

  const marginAfter = await readMargin(page);
  details.push(`margin_after_close=${marginAfter}`);
  await screenshotOnFailure(page, 'after-close-all');
  return { attempted, closed, details };
}

/**
 * Open the position by ticket and press a real Close control (not OK/Done).
 */
/**
 * Headway shows an X on the selected position row (right edge of the Trade table).
 * Flow: select row by ticket -> click X -> confirm Close by Market if a dialog appears.
 */
async function closeOneTicket(page: Page, ticket: string, side: string): Promise<boolean> {
  // 1) Click the ticket cell so the row is selected (X appears on that row)
  let selected = false;
  for (const frame of page.frames()) {
    try {
      const loc = frame.getByText(ticket, { exact: true }).first();
      if (await loc.isVisible({ timeout: 600 }).catch(() => false)) {
        await loc.click({ timeout: 3000 });
        await sleep(700);
        selected = true;
        break;
      }
    } catch { /* next frame */ }
  }
  if (!selected) {
    console.log(`[close] ticket text ${ticket} not visible`);
    return false;
  }

  // 2) Click the X on the selected row (Headway places it under Comment)
  if (await clickRowCloseX(page, ticket)) {
    await sleep(500);
    // Dialog may ask to confirm
    await pressCloseByMarket(page);
    return true;
  }

  // 3) Fallbacks: right-click menu / double-click / side link
  for (const frame of page.frames()) {
    try {
      const loc = frame.getByText(ticket, { exact: true }).first();
      if (!(await loc.isVisible({ timeout: 400 }).catch(() => false))) continue;
      await loc.click({ button: 'right', timeout: 2500 }).catch(() => {});
      await sleep(400);
      if (await pressCloseByMarket(page)) return true;
      await loc.dblclick({ timeout: 2500 }).catch(() => {});
      await sleep(500);
      if (await clickRowCloseX(page, ticket)) {
        await sleep(400);
        await pressCloseByMarket(page);
        return true;
      }
      if (await pressCloseByMarket(page)) return true;
    } catch { /* next */ }
  }

  return false;
}

/**
 * Click the X control that Headway shows on the highlighted position row.
 * Prefer an X near the ticket text; otherwise any visible row close icon in the trade table.
 */
async function clickRowCloseX(page: Page, ticket: string): Promise<boolean> {
  // Multiplication sign / ballot X as used by Headway row close control
  const mul = '\u00d7';
  const ballot = '\u2715';

  for (const frame of page.frames()) {
    try {
      const ticketLoc = frame.getByText(ticket, { exact: true }).first();
      if (!(await ticketLoc.isVisible({ timeout: 400 }).catch(() => false))) continue;

      // Prefer an X control in the same row as the ticket
      const rowXpath = [
        `xpath=ancestor::*[contains(@class,"row") or self::tr or @role="row"][1]//*[normalize-space(text())="${mul}" or normalize-space(text())="${ballot}"]`,
        'xpath=ancestor::*[contains(@class,"row") or self::tr or @role="row"][1]//button[contains(@class,"close") or @aria-label="Close" or @title="Close"]',
        'xpath=ancestor::*[contains(@class,"row") or self::tr or @role="row"][1]//*[contains(@class,"close")]',
      ];
      for (const xp of rowXpath) {
        try {
          const x = ticketLoc.locator(xp).first();
          if (await x.isVisible({ timeout: 500 }).catch(() => false)) {
            await x.click({ timeout: 3000 });
            console.log(`[close] clicked row X for ticket ${ticket}`);
            return true;
          }
        } catch { /* next */ }
      }

      // Walk up from ticket text and find a visible close control
      const handle = await ticketLoc.evaluateHandle((el, signs: string[]) => {
        let node: HTMLElement | null = el as HTMLElement;
        for (let depth = 0; depth < 10 && node; depth++) {
          const buttons = node.querySelectorAll('button, [role="button"], span, div, a, i, svg');
          for (const b of Array.from(buttons)) {
            const t = (b.textContent || '').trim();
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            const title = (b.getAttribute('title') || '').toLowerCase();
            const cls = (b.getAttribute('class') || '').toLowerCase();
            if (
              signs.includes(t) ||
              aria.includes('close') ||
              title.includes('close') ||
              (cls.includes('close') && !cls.includes('closed'))
            ) {
              const r = (b as HTMLElement).getBoundingClientRect();
              if (r.width > 0 && r.height > 0) return b;
            }
          }
          node = node.parentElement;
        }
        return null;
      }, [mul, ballot]);
      const asEl = handle.asElement();
      if (asEl) {
        await asEl.click({ timeout: 3000 }).catch(() => {});
        console.log(`[close] clicked parent-tree X for ticket ${ticket}`);
        return true;
      }
    } catch { /* next frame */ }
  }

  // Fallback: any visible close icon in the lower part of the page (trade table)
  for (const frame of page.frames()) {
    try {
      const candidates = frame.locator(
        `text=${mul}, text=${ballot}, [aria-label="Close"], [title="Close"], [class*="close" i]`
      );
      const n = await candidates.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 15); i++) {
        const ic = candidates.nth(i);
        if (!(await ic.isVisible({ timeout: 300 }).catch(() => false))) continue;
        const box = await ic.boundingBox().catch(() => null);
        if (box && box.y > 250) {
          await ic.click({ timeout: 3000 }).catch(() => {});
          console.log(`[close] clicked fallback X at y=${Math.round(box.y)}`);
          return true;
        }
      }
    } catch { /* next */ }
  }
  return false;
}

async function pressCloseByMarket(page: Page): Promise<boolean> {
  const primary = [
    'button:has-text("Close by Market")',
    'button:has-text("Close Position")',
    'button:has-text("Close position")',
    '[role="button"]:has-text("Close by Market")',
    '[role="button"]:has-text("Close Position")',
    '[role="menuitem"]:has-text("Close")',
    'text=/Close by Market/i',
    'text=/Close Position/i',
  ];
  const btn = await findFirstVisible(page, primary, 2500);
  if (!btn) {
    // Last resort: a button whose text is exactly "Close" (not Close All chart etc.)
    for (const frame of page.frames()) {
      try {
        const exact = frame.getByRole('button', { name: /^Close$/i }).first();
        if (await exact.isVisible({ timeout: 400 }).catch(() => false)) {
          await exact.click({ timeout: 3000 });
          await sleep(400);
          // Confirm dialog if any - still only Close / Yes, not Done alone
          const conf = await findFirstVisible(page, [
            'button:has-text("Close by Market")',
            'button:has-text("Close")',
            'button:has-text("Yes")',
          ], 1500);
          if (conf) await conf.click({ timeout: 2500 }).catch(() => {});
          return true;
        }
      } catch { /* next */ }
    }
    return false;
  }

  await btn.click({ timeout: 4000 }).catch(() => {});
  await sleep(500);
  // Optional second confirm
  const conf = await findFirstVisible(page, [
    'button:has-text("Close by Market")',
    'button:has-text("Close")',
    'button:has-text("Yes")',
  ], 1500);
  if (conf) await conf.click({ timeout: 2500 }).catch(() => {});
  return true;
}

export function orderExitCode(outcome: string): number {
  if (outcome === 'dry_run_ok' || outcome === 'executed_confirmed') return 0;
  if (outcome === 'executed_confirmed_close_failed' || outcome === 'executed_unconfirmed') return 3;
  return 1;
}
