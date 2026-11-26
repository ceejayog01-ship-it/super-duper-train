/** Minimal Trade-tab reader used to prevent mixing a new run with existing EURUSD positions. */
import { Page } from 'playwright';
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
const NUM_RE = /(\d+\.\d+)/g;

export function parseTradeTab(text: string, symbolFilter = 'EURUSD'): OpenPosition[] {
  const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const out: OpenPosition[] = [];
  const symbol = symbolFilter.toUpperCase();

  for (const line of lines) {
    if (!line.toUpperCase().includes(symbol)) continue;
    const sideMatch = line.match(SIDE_RE);
    if (!sideMatch) continue;
    const side = sideMatch[1].toLowerCase() as 'buy' | 'sell';
    const numbers = [...line.matchAll(NUM_RE)].map(match => Number(match[1]));
    if (numbers.length < 2) continue;

    let lots = 0.5;
    let openPrice = 0;
    let sl: number | undefined;
    let profit: number | undefined;
    for (const value of numbers) {
      if (value >= 0.01 && value <= 10 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6) {
        if (lots === 0.5 || value !== 0.5) lots = value;
      } else if (value > 0.5 && value < 2.5) {
        if (!openPrice) openPrice = value;
        else if (sl === undefined) sl = value;
      } else if (Math.abs(value) < 5000 && openPrice) {
        profit = value;
      }
    }
    if (!openPrice) continue;
    const ticketMatch = line.match(/\b(\d{6,})\b/);
    out.push({
      ticket: ticketMatch?.[1], symbol, side, lots, openPrice, sl, profit,
      raw: line.slice(0, 200),
    });
  }
  return out;
}

export async function readOpenPositions(page: Page, symbol = 'EURUSD'): Promise<OpenPosition[]> {
  for (const selector of Selectors.trading.tradeTab) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible({ timeout: 1200 }).catch(() => false)) {
      await locator.click({ timeout: 2000 }).catch(() => {});
      await sleep(600);
      break;
    }
  }
  const texts: string[] = [];
  for (const frame of page.frames()) {
    const body = await frame.locator('body').innerText({ timeout: 2500 }).catch(() => '');
    if (body) texts.push(body);
  }
  return parseTradeTab(texts.join('\n'), symbol);
}
