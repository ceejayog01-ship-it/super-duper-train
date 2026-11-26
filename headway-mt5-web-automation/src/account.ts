import { Page } from 'playwright';

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

/** True if the symbol name is visible in the terminal (so an order ticket can be opened). Reads no price. */
export async function symbolListed(page: Page, symbol: string): Promise<boolean> {
  for (const frame of page.frames()) {
    const hit = frame.getByText(symbol, { exact: true }).first();
    if (await hit.isVisible({ timeout: 800 }).catch(() => false)) return true;
  }
  return false;
}

export async function waitForSymbol(page: Page, symbol: string, timeoutMs = 20000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await symbolListed(page, symbol)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}
