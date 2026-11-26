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
const LOTS_RE = /\b(0\.\d{1,2}|[1-9]\d*\.\d{1,2})\b/;

/**
 * Parse free text from the Trade / positions area.
 * Tolerant of table cells joined with spaces or newlines.
 */
export function parseTradeTab(text: string, symbolFilter = 'EURUSD'): OpenPosition[] {
  const symbol = symbolFilter.toUpperCase();
  const out: OpenPosition[] = [];
  const seen = new Set<string>();

  // Prefer line-oriented parse
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const candidates = lines.length > 0 ? lines : [text.replace(/\s+/g, ' ')];

  for (const line of candidates) {
    if (!line.toUpperCase().includes(symbol)) continue;
    if (/^symbol\b/i.test(line)) continue; // header
    if (/balance|equity|free margin|level:/i.test(line) && !SIDE_RE.test(line)) continue;

    const sideMatch = line.match(SIDE_RE);
    if (!sideMatch) continue;
    const side = sideMatch[1].toLowerCase() as 'buy' | 'sell';

    const ticketMatch = line.match(TICKET_RE);
    const ticket = ticketMatch?.[1];

    // Lots: prefer 0.xx near "volume" style values
    let lots = 0.5;
    const lotsMatches = [...line.matchAll(/\b0\.\d{1,2}\b/g)].map(m => Number(m[0]));
    if (lotsMatches.length) {
      // Prefer values that look like lot sizes (0.01–10)
      const lot = lotsMatches.find(v => v >= 0.01 && v <= 10) ?? lotsMatches[0];
      lots = lot;
    }

    // Open price: first value that looks like a FX price (~0.5–500, often ~1.x for EURUSD)
    const decimals = [...line.matchAll(/\b\d+\.\d+\b/g)].map(m => Number(m[0]));
    let openPrice = 0;
    for (const v of decimals) {
      if (v === lots) continue;
      if (v >= 0.5 && v < 500) {
        openPrice = v;
        break;
      }
    }
    // Still accept rows without a perfect price parse if ticket + side are present
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

  // Fallback: whole-text scan for "EURUSD … buy/sell … ticket" patterns when lines failed
  if (out.length === 0) {
    const compact = text.replace(/\s+/g, ' ');
    const re = new RegExp(
      `${symbol}\\s+(\\d{7,})\\s+[^]*?\\b(buy|sell)\\b\\s+(\\d+(?:\\.\\d+)?)`,
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

/** Ensure the positions / Trade area is visible (bottom panel on Headway). */
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
  // Bottom-left Trade icon (screenshot shows a list icon)
  for (const frame of page.frames()) {
    for (const sel of ['[title*="Trade" i]', '[aria-label*="Trade" i]', 'text=Trade']) {
      try {
        const loc = frame.locator(sel).first();
        if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
          await loc.click({ timeout: 1500 }).catch(() => {});
          await sleep(400);
          return;
        }
      } catch { /* next */ }
    }
  }
}

/**
 * Locate DOM rows that look like open positions for the symbol.
 * More reliable than pure text parse on Headway's table layout.
 */
export async function findPositionRows(page: Page, symbol = 'EURUSD'): Promise<Locator[]> {
  await ensureTradePanel(page);
  const upper = symbol.toUpperCase();
  const found: Locator[] = [];

  for (const frame of page.frames()) {
    // Table rows and role=row
    const rows = frame.locator('tr, [role="row"]');
    const n = await rows.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 50); i++) {
      const row = rows.nth(i);
      const text = ((await row.innerText({ timeout: 600 }).catch(() => '')) || '').trim();
      if (!text) continue;
      if (!text.toUpperCase().includes(upper)) continue;
      if (/^symbol\b/i.test(text)) continue;
      if (!/\b(buy|sell)\b/i.test(text)) continue;
      if (!/\d{7,}/.test(text) && !/\b0\.\d+\b/.test(text)) continue;
      // Must be visible
      if (!(await row.isVisible({ timeout: 300 }).catch(() => false))) continue;
      found.push(row);
    }
  }
  return found;
}

export async function readOpenPositions(page: Page, symbol = 'EURUSD'): Promise<OpenPosition[]> {
  await ensureTradePanel(page);

  // DOM rows first
  const rows = await findPositionRows(page, symbol);
  if (rows.length > 0) {
    const out: OpenPosition[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const text = ((await row.innerText({ timeout: 800 }).catch(() => '')) || '').trim();
      const parsed = parseTradeTab(text, symbol);
      if (parsed.length) {
        for (const p of parsed) {
          const key = p.ticket || p.raw || JSON.stringify(p);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(p);
        }
      } else {
        // Minimal stub so callers know a row exists
        const sideMatch = text.match(SIDE_RE);
        const ticketMatch = text.match(TICKET_RE);
        if (sideMatch) {
          const key = ticketMatch?.[1] || text.slice(0, 40);
          if (!seen.has(key)) {
            seen.add(key);
            out.push({
              ticket: ticketMatch?.[1],
              symbol: symbol.toUpperCase(),
              side: sideMatch[1].toLowerCase() as 'buy' | 'sell',
              lots: 0.5,
              openPrice: 0,
              raw: text.slice(0, 200),
            });
          }
        }
      }
    }
    if (out.length) return out;
  }

  // Text fallback across frames
  const texts: string[] = [];
  for (const frame of page.frames()) {
    const body = await frame.locator('body').innerText({ timeout: 2500 }).catch(() => '');
    if (body) texts.push(body);
  }
  return parseTradeTab(texts.join('\n'), symbol);
}
