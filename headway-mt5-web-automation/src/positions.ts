/** Trade / positions table reader for Headway MT5 web terminal. */
import { Page, Locator } from 'playwright';
import { Selectors } from '../config/selectors';
import { sleep } from './utils';

export interface OpenPosition {
  ticket?: string;
  symbol: string;
  side: 'buy' | 'sell';
  lots: number;
  openPrice: number;
  sl?: number;
  tp?: number;
  profit?: number;
  openTime?: string;
  raw?: string;
}

const SIDE_RE = /\b(buy|sell)\b/i;
const TICKET_RE = /\b(\d{7,})\b/;

/**
 * Parse free text from the Trade / positions area.
 * Tolerant of table cells joined with spaces or newlines.
 */
export function parseTradeTab(text: string, symbolFilter = 'EURUSD'): OpenPosition[] {
  const symbol = symbolFilter.toUpperCase();
  const out: OpenPosition[] = [];
  const seen = new Set<string>();

  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const candidates = lines.length > 0 ? lines : [text.replace(/\s+/g, ' ')];

  for (const line of candidates) {
    if (!line.toUpperCase().includes(symbol)) continue;
    if (/^symbol\b/i.test(line)) continue;
    if (/balance|equity|free margin|level:/i.test(line) && !SIDE_RE.test(line)) continue;

    const sideMatch = line.match(SIDE_RE);
    if (!sideMatch) continue;
    const side = sideMatch[1].toLowerCase() as 'buy' | 'sell';
    const ticketMatch = line.match(TICKET_RE);
    const ticket = ticketMatch?.[1];

    let lots = 0.5;
    const lotsMatches = [...line.matchAll(/\b0\.\d{1,2}\b/g)].map(m => Number(m[0]));
    if (lotsMatches.length) {
      const lot = lotsMatches.find(v => v >= 0.01 && v <= 10) ?? lotsMatches[0];
      lots = lot;
    }

    const decimals = [...line.matchAll(/\b\d+\.\d+\b/g)].map(m => Number(m[0]));
    let openPrice = 0;
    for (const v of decimals) {
      if (v === lots) continue;
      if (v >= 0.5 && v < 500) {
        openPrice = v;
        break;
      }
    }
    if (!openPrice && !ticket) continue;

    const key = ticket || `${side}:${lots}:${openPrice}:${line.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      ticket,
      symbol,
      side,
      lots,
      openPrice: openPrice || 0,
      raw: line.slice(0, 200),
    });
  }

  if (out.length === 0) {
    const compact = text.replace(/\s+/g, ' ');
    const re = new RegExp(
      `${symbol}\\s+(\\d{7,})\\s+[\\s\\S]*?\\b(buy|sell)\\b\\s+(\\d+(?:\\.\\d+)?)`,
      'gi'
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(compact)) !== null) {
      const key = m[1];
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ticket: m[1],
        symbol,
        side: m[2].toLowerCase() as 'buy' | 'sell',
        lots: Number(m[3]) || 0.5,
        openPrice: 0,
        raw: m[0].slice(0, 200),
      });
    }
  }

  return out;
}

async function ensureTradePanel(page: Page): Promise<void> {
  for (const selector of Selectors.trading.tradeTab) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 800 }).catch(() => false)) {
        await locator.click({ timeout: 2000 }).catch(() => {});
        await sleep(500);
        return;
      }
    } catch { /* next */ }
  }
}

/**
 * Headway often renders the positions grid without classic <tr> rows.
 * Prefer ticket-number text nodes, then walk up to a clickable row-like parent.
 */
export async function findPositionRows(page: Page, symbol = 'EURUSD'): Promise<Locator[]> {
  await ensureTradePanel(page);
  const positions = await readOpenPositionsTextOnly(page, symbol);
  const found: Locator[] = [];
  const seenTickets = new Set<string>();

  for (const pos of positions) {
    if (!pos.ticket || seenTickets.has(pos.ticket)) continue;
    for (const frame of page.frames()) {
      try {
        const ticketLoc = frame.getByText(pos.ticket, { exact: true }).first();
        if (!(await ticketLoc.isVisible({ timeout: 500 }).catch(() => false))) continue;

        // Prefer a parent that also mentions buy/sell (the full row)
        const row = ticketLoc.locator(
          'xpath=ancestor::*[self::tr or @role="row" or contains(@class,"row") or contains(@class,"position") or contains(@class,"deal")][1]'
        );
        if (await row.count().catch(() => 0) > 0 && await row.first().isVisible({ timeout: 300 }).catch(() => false)) {
          found.push(row.first());
          seenTickets.add(pos.ticket);
          break;
        }
        // Fallback: the ticket text node itself is clickable on Headway
        found.push(ticketLoc);
        seenTickets.add(pos.ticket);
        break;
      } catch { /* next frame */ }
    }
  }

  // Also collect any visible tr/[role=row] that match
  for (const frame of page.frames()) {
    const rows = frame.locator('tr, [role="row"]');
    const n = await rows.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 50); i++) {
      const row = rows.nth(i);
      const text = ((await row.innerText({ timeout: 400 }).catch(() => '')) || '').trim();
      if (!text.toUpperCase().includes(symbol.toUpperCase())) continue;
      if (!/\b(buy|sell)\b/i.test(text)) continue;
      if (!/\d{7,}/.test(text)) continue;
      if (!(await row.isVisible({ timeout: 200 }).catch(() => false))) continue;
      found.push(row);
    }
  }

  return found;
}

async function readOpenPositionsTextOnly(page: Page, symbol: string): Promise<OpenPosition[]> {
  const texts: string[] = [];
  for (const frame of page.frames()) {
    const body = await frame.locator('body').innerText({ timeout: 2500 }).catch(() => '');
    if (body) texts.push(body);
  }
  return parseTradeTab(texts.join('\n'), symbol);
}

export async function readOpenPositions(page: Page, symbol = 'EURUSD'): Promise<OpenPosition[]> {
  await ensureTradePanel(page);
  return readOpenPositionsTextOnly(page, symbol);
}

/** True if the ticket id is still visible anywhere in the terminal. */
export async function ticketStillOpen(page: Page, ticket: string): Promise<boolean> {
  for (const frame of page.frames()) {
    const loc = frame.getByText(ticket, { exact: true }).first();
    if (await loc.isVisible({ timeout: 400 }).catch(() => false)) return true;
  }
  return false;
}
