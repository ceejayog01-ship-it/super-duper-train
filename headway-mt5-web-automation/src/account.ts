import { Page, Locator } from 'playwright';
import { Selectors } from '../config/selectors';
import { findFirstVisible, sleep } from './utils';

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

const SEARCH_INPUT_SELECTORS = [
  'input[placeholder*="Search symbol" i]',
  'input[placeholder*="Search" i]',
  'input[placeholder*="Find" i]',
  'input[placeholder*="Symbol" i]',
  'input[placeholder*="Filter" i]',
  'input[type="search"]',
  '[class*="search" i] input',
  '[class*="filter" i] input',
  'input[aria-label*="search" i]',
] as const;

const ADD_SYMBOL_SELECTORS = [
  'button:has-text("Add")',
  'button:has-text("Add symbol")',
  'button:has-text("Add Symbol")',
  '[role="button"]:has-text("Add")',
  'text=/^Add( symbol)?$/i',
  '[title*="Add" i]',
  '[aria-label*="Add" i]',
] as const;

/**
 * Locate the symbol search box (right-hand panel on Headway web terminal).
 */
async function findSymbolSearchInput(page: Page): Promise<Locator | null> {
  return findFirstVisible(page, SEARCH_INPUT_SELECTORS, 3000);
}

/**
 * Type a symbol into the search box and wait for the filtered list to update.
 * Works for any pair (EURUSD, GBPUSD, XAUUSD, ...) - not hard-coded.
 */
export async function typeSymbolSearch(page: Page, symbol: string): Promise<boolean> {
  const search = await findSymbolSearchInput(page);
  if (!search) return false;
  try {
    await search.click({ timeout: 2000 });
    await search.fill('', { timeout: 1500 }).catch(() => {});
    await search.fill(symbol, { timeout: 2500 });
    await sleep(700);
    return true;
  } catch {
    return false;
  }
}

/**
 * Click the matching symbol row in the search / Market Watch list.
 * Prefers exact match, then word-boundary match.
 */
async function clickSymbolRow(page: Page, symbol: string): Promise<boolean> {
  const upper = symbol.toUpperCase();
  for (const frame of page.frames()) {
    // Exact text first
    try {
      const exact = frame.getByText(symbol, { exact: true }).first();
      if (await exact.isVisible({ timeout: 500 }).catch(() => false)) {
        await exact.click({ timeout: 2500 });
        await sleep(400);
        return true;
      }
    } catch { /* continue */ }

    // Word-boundary (handles slight UI variants)
    try {
      const partial = frame.getByText(new RegExp(`\\b${symbol}\\b`, 'i')).first();
      if (await partial.isVisible({ timeout: 500 }).catch(() => false)) {
        await partial.click({ timeout: 2500 });
        await sleep(400);
        return true;
      }
    } catch { /* continue */ }

    // Table / list row that contains the symbol as primary label
    try {
      const rows = frame.locator('tr, [role="row"], [class*="row"], li, [class*="item"]');
      const n = await rows.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 40); i++) {
        const row = rows.nth(i);
        const text = ((await row.innerText({ timeout: 400 }).catch(() => '')) || '').trim();
        if (!text) continue;
        // First token should be the symbol (or equal after normalize)
        const first = text.split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        if (first === upper || text.toUpperCase().startsWith(upper)) {
          if (await row.isVisible({ timeout: 300 }).catch(() => false)) {
            await row.click({ timeout: 2500 });
            await sleep(400);
            return true;
          }
        }
      }
    } catch { /* continue */ }
  }
  return false;
}

/**
 * If the UI offers an explicit "Add" action for a symbol that is not yet in Market Watch, click it.
 */
async function tryAddSymbol(page: Page, symbol: string): Promise<boolean> {
  // Some terminals show Add next to the search result
  const addBtn = await findFirstVisible(page, ADD_SYMBOL_SELECTORS, 2000);
  if (addBtn) {
    await addBtn.click({ timeout: 2500 }).catch(() => {});
    await sleep(600);
    return true;
  }

  // Right-click context menu -> Add is common on desktop MT5; try on the row
  for (const frame of page.frames()) {
    try {
      const row = frame.getByText(symbol, { exact: true }).first();
      if (await row.isVisible({ timeout: 400 }).catch(() => false)) {
        await row.click({ button: 'right', timeout: 2000 }).catch(() => {});
        await sleep(300);
        const menuAdd = await findFirstVisible(page, [
          'text=/^Add$/i',
          '[role="menuitem"]:has-text("Add")',
          'text=/Add to (Market Watch|quotes)/i',
        ], 1500);
        if (menuAdd) {
          await menuAdd.click({ timeout: 2000 }).catch(() => {});
          await sleep(500);
          return true;
        }
        // Dismiss menu if nothing useful
        await page.keyboard.press('Escape').catch(() => {});
      }
    } catch { /* continue */ }
  }
  return false;
}

/**
 * Full pipeline for any pair:
 *   1. Ensure Quotes / search panel is available
 *   2. Type the symbol into Search
 *   3. Click the matching result (select / accept it)
 *   4. If still not listed, try an explicit Add action, then re-select
 *
 * Returns true when the symbol is visible / selected and ready for order entry.
 * Does not read prices.
 */
export async function searchAndSelectSymbol(page: Page, symbol: string): Promise<boolean> {
  const sym = symbol.trim().toUpperCase();
  if (!sym) return false;

  console.log(`[symbol] Searching and selecting ${sym}...`);
  await ensureQuotesVisible(page);

  // Already visible without search?
  if (await symbolListed(page, sym)) {
    const clicked = await clickSymbolRow(page, sym);
    if (clicked || await symbolListed(page, sym)) {
      console.log(`[symbol] ${sym} already listed and selected`);
      return true;
    }
  }

  // Search -> select
  const typed = await typeSymbolSearch(page, sym);
  if (typed) {
    await sleep(500);
    if (await clickSymbolRow(page, sym)) {
      console.log(`[symbol] ${sym} selected from search results`);
      return true;
    }
  }

  // Not in list / not selectable -> try Add, then select again
  console.log(`[symbol] ${sym} not selectable yet; attempting Add...`);
  await tryAddSymbol(page, sym);
  await typeSymbolSearch(page, sym);
  await sleep(500);
  if (await clickSymbolRow(page, sym)) {
    console.log(`[symbol] ${sym} added and selected`);
    return true;
  }

  // Final visibility check (search may have left it on-screen)
  const listed = await symbolListed(page, sym);
  console.log(`[symbol] ${sym} final listed=${listed}`);
  return listed;
}

/**
 * True if the symbol name appears anywhere useful in the terminal UI.
 * Uses exact match first, then case-insensitive substring, then body text.
 * Does not read prices.
 */
export async function symbolListed(page: Page, symbol: string): Promise<boolean> {
  const upper = symbol.toUpperCase();
  for (const frame of page.frames()) {
    try {
      const exact = frame.getByText(symbol, { exact: true }).first();
      if (await exact.isVisible({ timeout: 400 }).catch(() => false)) return true;
    } catch { /* continue */ }

    try {
      const partial = frame.getByText(new RegExp(`\\b${symbol}\\b`, 'i')).first();
      if (await partial.isVisible({ timeout: 400 }).catch(() => false)) return true;
    } catch { /* continue */ }

    try {
      const body = (await frame.locator('body').innerText({ timeout: 1500 }).catch(() => '')).toUpperCase();
      if (body.includes(upper)) return true;
    } catch { /* continue */ }
  }
  return false;
}

/**
 * Wait until the symbol is discoverable and selected.
 * Opens Quotes, runs search -> select -> add for any pair.
 */
export async function waitForSymbol(page: Page, symbol: string, timeoutMs = 30000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  // First full pipeline attempt
  if (await searchAndSelectSymbol(page, symbol)) return true;

  while (Date.now() < end) {
    if (await symbolListed(page, symbol)) {
      await clickSymbolRow(page, symbol);
      return true;
    }
    // Retry search mid-wait
    if (Date.now() > end - timeoutMs + 8000) {
      await searchAndSelectSymbol(page, symbol);
    }
    await page.waitForTimeout(900);
  }
  return false;
}
