import { Page, Locator } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

export async function findFirstVisible(
  page: Page,
  selectors: readonly string[],
  timeout = 10000
): Promise<Locator | null> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const frame of page.frames()) {
      for (const sel of selectors) {
        try {
          const loc = frame.locator(sel).first();
          if (await loc.isVisible({ timeout: 800 }).catch(() => false)) return loc;
        } catch {
          // Continue through remaining selectors and frames.
        }
      }
    }
    await page.waitForTimeout(400);
  }
  return null;
}

export async function safeClick(
  page: Page,
  selectors: readonly string[],
  description: string,
  timeout = 15000
): Promise<boolean> {
  const el = await findFirstVisible(page, selectors, timeout);
  if (!el) {
    console.error(`[safeClick] Could not find: ${description}`);
    return false;
  }
  await el.click({ timeout: 5000 });
  console.log(`[safeClick] Clicked: ${description}`);
  return true;
}

export async function safeFill(
  page: Page,
  selectors: readonly string[],
  value: string,
  description: string,
  timeout = 15000
): Promise<boolean> {
  const el = await findFirstVisible(page, selectors, timeout);
  if (!el) {
    console.error(`[safeFill] Could not find: ${description}`);
    return false;
  }
  await el.fill(value, { timeout: 5000 });
  console.log(`[safeFill] Filled: ${description}`);
  return true;
}

export async function screenshotOnFailure(page: Page, name: string) {
  try {
    const dir = path.join(process.cwd(), 'artifacts');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`[screenshot] Saved → ${file}`);
  } catch (e) {
    console.warn('[screenshot] Failed to capture', e);
  }
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}




/** Save a screenshot and structured, credential-free diagnostics for login verification. */
export async function savePostLoginDiagnostics(
  page: Page,
  name: string,
  report: Record<string, unknown>
): Promise<void> {
  const dir = path.join(process.cwd(), 'artifacts');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const screenshotPath = path.join(dir, `${name}-${stamp}.png`);
  const jsonPath = path.join(dir, `${name}-${stamp}.json`);

  // Save each artifact independently: a screenshot failure must never prevent
  // the machine-readable diagnostic report from being written (or vice versa).
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[diagnostics] Screenshot saved: ${screenshotPath}`);
  } catch (error) {
    console.warn('[diagnostics] Screenshot capture failed:', error);
  }
  try {
    fs.writeFileSync(jsonPath, JSON.stringify({
      capturedAt: new Date().toISOString(),
      pageUrl: page.url().split('?')[0],
      ...report,
    }, null, 2) + '\n');
    console.log(`[diagnostics] Report saved: ${jsonPath}`);
  } catch (error) {
    console.warn('[diagnostics] JSON report could not be saved:', error);
  }
}
