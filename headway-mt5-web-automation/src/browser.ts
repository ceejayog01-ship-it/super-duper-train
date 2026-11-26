import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, BrowserContext, Page } from 'playwright';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config();

// Apply stealth
chromium.use(StealthPlugin());

export interface BrowserOptions {
  headless?: boolean;
  slowMo?: number;
  userDataDir?: string;
  proxyServer?: string;
  timeout?: number;
}

export async function launchBrowser(opts: BrowserOptions = {}): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  const headless = opts.headless ?? process.env.HEADLESS === 'true';
  const slowMo = opts.slowMo ?? Number(process.env.SLOW_MO || 80);
  const userDataDir = opts.userDataDir || process.env.USER_DATA_DIR || undefined;
  const proxyServer = opts.proxyServer || process.env.PROXY_SERVER || undefined;
  const timeout = opts.timeout ?? Number(process.env.DEFAULT_TIMEOUT || 45000);

  console.log('[browser] Launching with options:', {
    headless,
    slowMo,
    userDataDir: userDataDir ? 'yes' : 'no',
    proxy: proxyServer ? 'yes' : 'no',
  });

  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-infobars',
    '--window-size=1280,900',
    '--disable-dev-shm-usage',
  ];

  let browser: Browser;
  let context: BrowserContext;

  if (userDataDir) {
    // Persistent context = real-ish profile
    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      slowMo,
      args: launchArgs,
      viewport: { width: 1280, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'Africa/Lagos',
      proxy: proxyServer ? { server: proxyServer } : undefined,
      ignoreHTTPSErrors: true,
    });
    browser = context.browser()!;
  } else {
    browser = await chromium.launch({
      headless,
      slowMo,
      args: launchArgs,
      proxy: proxyServer ? { server: proxyServer } : undefined,
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'Africa/Lagos',
      ignoreHTTPSErrors: true,
    });
  }

  // Extra stealth tweaks
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // @ts-ignore
    window.chrome = { runtime: {} };
  });

  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(timeout);

  return { browser, context, page };
}

export async function closeBrowser(browser: Browser, context: BrowserContext) {
  try {
    await context.close();
    await browser.close();
  } catch (e) {
    console.warn('[browser] Close warning:', e);
  }
}
