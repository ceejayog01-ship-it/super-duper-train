import { Page } from 'playwright';
import { Selectors } from '../config/selectors';
import { sleep } from './utils';

/**
 * Account-side helpers only. This module deliberately reads NO market prices:
 * Yahoo Finance is the sole market-price provider; Headway is used for login, account access,
 * order execution and broker confirmations.
 */

/** Account "Margin: $x" value (not "Free Margin"). Hard evidence that a position opened/closed. */
export function parseMargin(text: string): number | null {
  const m = text.match(/(?<!Free\s)\bMargin\s*:\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

export async function readMargin(page: Page): Promise<number | null> {
  for (const frame of page.frames()) {
    const text = await frame.locator('body').innerText({ timeout: 2500 }).catch(() => '');
    const v = parseMargin(text.replace(/\s+/g, ' '));
    if (v !== null) return v;
  }
  return null;
}

/** Activate Quotes / Market Watch so symbols become visible. */
async function ensureQuotesVisible(page: Page): Promise<void> {
  const candidates = [
    ...Selectors.trading.quotesTab,
    'text=Market Watch',
    '[role="tab"]:has-text("Market Watch")',
    'button:has-text("Quotes")',
    'div[class*="tab"]:has-text("Quotes")',
    'text=Symbols',
  ];
  for (const frame of page.frames()) {
    for (const sel of candidates) {
      try {
        const loc = frame.locator(sel).first();
        if (await loc.isVisible({ timeout: 600 }).catch(() => false)) {
          await loc.click({ timeout: 2000 }).catch(() => {});
          await sleep(500);
          return;
        }
      } catch {
        /* try next */
      }
    }
  }
}

/**
 * Try to type the symbol into any visible search / filter input
 * (Market Watch search is common on Headway / MetaQuotes web terminals).
 */
async function trySymbolSearch(page: Page, symbol: string): Promise<void> {
  const searchSelectors = [
    'input[placeholder*="Search" i]',
    'input[placeholder*="Find" i]',
    'input[placeholder*="Symbol" i]',
    'input[placeholder*="Filter" i]',
    'input[type="search"]',
    '[class*="search" i] input',
    '[class*="filter" i] input',
    'input[aria-label*="search" i]',
  ];
  for (const frame of page.frames()) {
    for (const sel of searchSelectors) {
      try {
        const loc = frame.locator(sel).first();
        if (await loc.isVisible({ timeout: 400 }).catch(() => false)) {
          await loc.click({ timeout: 1500 }).catch(() => {});
          await loc.fill('', { timeout: 1500 }).catch(() => {});
          await loc.fill(symbol, { timeout: 2000 }).catch(() => {});
          await sleep(800);
          return;
        }
      } catch {
        /* try next */
      }
    }
  }
}

/**
 * True if the symbol name appears anywhere useful in the terminal UI.
 * Uses exact match first, then case-insensitive substring, then body text.
 * Does not read prices.
 */
export async function symbolListed(page: Page, symbol: string): Promise<boolean> {
  const upper = symbol.toUpperCase();
  for (const frame of page.frames()) {
    // 1. Exact visible text
    try {
      const exact = frame.getByText(symbol, { exact: true }).first();
      if (await exact.isVisible({ timeout: 400 }).catch(() => false)) return true;
    } catch { /* continue */ }

    // 2. Case-insensitive word-boundary match (covers "EURUSD." suffixes etc.)
    try {
      const partial = frame.getByText(new RegExp(`\\b${symbol}\\b`, 'i')).first();
      if (await partial.isVisible({ timeout: 400 }).catch(() => false)) return true;
    } catch { /* continue */ }

    // 3. Scan body text as last resort
    try {
      const body = (await frame.locator('body').innerText({ timeout: 1500 }).catch(() => '')).toUpperCase();
      if (body.includes(upper)) return true;
    } catch { /* continue */ }
  }
  return false;
}

/**
 * Wait until the symbol is discoverable. Opens Quotes tab and tries search
 * so that Market Watch does not stay empty/collapsed after login.
 */
export async function waitForSymbol(page: Page, symbol: string, timeoutMs = 25000): Promise<boolean> {
  await ensureQuotesVisible(page);
  await trySymbolSearch(page, symbol);

  const end = Date.now() + timeoutMs;
  let attemptedSearchAgain = false;
  while (Date.now() < end) {
    if (await symbolListed(page, symbol)) return true;
    // Re-open Quotes once more mid-wait in case the tab was not ready
    if (!attemptedSearchAgain && Date.now() > end - timeoutMs + 6000) {
      await ensureQuotesVisible(page);
      await trySymbolSearch(page, symbol);
      attemptedSearchAgain = true;
    }
    await page.waitForTimeout(900);
  }
  return false;
}
