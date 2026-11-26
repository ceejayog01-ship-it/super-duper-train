#!/usr/bin/env node
/**
 * Minimal Headway MT5 demo runner: login, then submit one EURUSD BUY 0.50
 * followed by one EURUSD SELL 0.50. After both legs, hold for 2 minutes and close.
 * No strategy engine or market-data provider.
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { launchBrowser, closeBrowser } from './browser';
import { performLogin, getLastLoginReport } from './login';
import { loadPolicy, PolicyError } from './policy';
import { writeAuthResult } from './authResult';
import { assertOrderAllowed, OrderGuardError, runDummyOrder, closeAllSymbolPositions } from './order';
import { screenshotOnFailure, sleep } from './utils';

dotenv.config();

const HOLD_MS = Number(process.env.HOLD_BEFORE_CLOSE_MS || 120_000); // 2 minutes default

const program = new Command();
program
  .option('--mode <mode>', 'login | paired-order', 'paired-order')
  .parse(process.argv);
const options = program.opts();

const artifacts = () => {
  const dir = path.join(process.cwd(), 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

async function main() {
  let policy;
  try {
    policy = loadPolicy();
  } catch (error) {
    console.error(`[policy] ${(error as Error).message}`);
    process.exitCode = 2;
    return;
  }

  if (!['login', 'paired-order'].includes(options.mode)) {
    console.error('Unsupported mode. Use login or paired-order.');
    process.exitCode = 2;
    return;
  }

  const login = process.env.MT5_LOGIN;
  const password = process.env.MT5_PASSWORD;
  const url = process.env.WEB_TERMINAL_URL || '';

  if (!login || !password || !url) {
    console.error('Missing MT5_LOGIN, MT5_PASSWORD, or WEB_TERMINAL_URL.');
    writeAuthResult('failed', 'missing_credentials_or_url', policy.mode, null, null, url);
    process.exitCode = 1;
    return;
  }

  const buyReq = {
    symbol: 'EURUSD', side: 'buy' as const, lots: 0.50,
    execute: true, closeAfter: false,
  };
  const sellReq = {
    symbol: 'EURUSD', side: 'sell' as const, lots: 0.50,
    execute: true, closeAfter: false, allowExistingSymbolPosition: true,
  };

  if (options.mode === 'paired-order') {
    try {
      if (process.env.ACCOUNT_MODE !== 'demo') throw new OrderGuardError('demo_account_required');
      if (!/mt5-demo/i.test(url)) throw new OrderGuardError('demo_terminal_url_required');
      if (process.env.ALLOW_ORDERS !== 'yes') throw new OrderGuardError('orders_not_enabled');
      assertOrderAllowed(policy, buyReq, process.env);
      assertOrderAllowed(policy, sellReq, process.env);
    } catch (error) {
      if (error instanceof OrderGuardError) {
        console.error(`[paired-order] GUARD: ${error.message}. No browser launched and no order sent.`);
        process.exitCode = 2;
        return;
      }
      throw error;
    }
  }

  console.log('=== Headway MT5 DEMO Login and Paired-Order Runner ===');
  console.log(`Mode: ${options.mode}`);
  if (options.mode === 'paired-order') {
    console.log('Fixed orders: EURUSD BUY 0.50, then EURUSD SELL 0.50');
    console.log(`Automatic close: enabled after ${Math.round(HOLD_MS / 1000)}s hold.`);
  }

  const { browser, context, page } = await launchBrowser();
  try {
    const loggedIn = await performLogin(page, { login, password, url });
    const loginReport = getLastLoginReport();
    if (!loggedIn) {
      writeAuthResult('failed', loginReport?.reason ?? 'login_failed', policy.mode, null, null, url);
      console.error('Demo login not confirmed. Aborting before order entry.');
      process.exitCode = 1;
      return;
    }

    writeAuthResult('verified', 'ok', policy.mode, null, loginReport?.terminalHost ?? null, url);

    if (options.mode === 'login') {
      console.log('Demo login completed. No order was sent.');
      return;
    }

    const pairDir = path.join(artifacts(), 'paired-order');
    fs.mkdirSync(pairDir, { recursive: true });
    console.log('[paired-order] Sending BUY first, then SELL. These are sequential, not atomic simultaneous orders.');

    const buyReport = await runDummyOrder(page, policy, buyReq, path.join(pairDir, 'buy'));
    let sellReport: Awaited<ReturnType<typeof runDummyOrder>> | null = null;

    // Proceed with SELL if BUY was confirmed OR at least clicked (unconfirmed) —
    // the second leg should still be attempted when a position may already exist.
    if (buyReport.outcome === 'executed_confirmed' || buyReport.outcome === 'executed_unconfirmed') {
      console.log(`[paired-order] BUY outcome=${buyReport.outcome}; proceeding with SELL.`);
      // Brief pause so the Done/OK dialog can be dismissed and the book can update
      await sleep(1500);
      sellReport = await runDummyOrder(page, policy, sellReq, path.join(pairDir, 'sell'));
    } else {
      console.error(`[paired-order] BUY outcome=${buyReport.outcome}; SELL skipped. Check the demo account manually.`);
    }

    // ---- Hold 2 minutes, then close any EURUSD positions opened by this run ----
    const anyOpened =
      buyReport.outcome === 'executed_confirmed' ||
      buyReport.outcome === 'executed_unconfirmed' ||
      sellReport?.outcome === 'executed_confirmed' ||
      sellReport?.outcome === 'executed_unconfirmed';

    let closeResult: { attempted: number; closed: number; details: string[] } | null = null;
    if (anyOpened) {
      console.log(`[paired-order] Holding positions for ${Math.round(HOLD_MS / 1000)} seconds before auto-close…`);
      await sleep(HOLD_MS);
      console.log('[paired-order] Auto-close starting for EURUSD positions…');
      closeResult = await closeAllSymbolPositions(page, 'EURUSD', 90_000);
      console.log(`[paired-order] Auto-close finished: attempted=${closeResult.attempted} closed=${closeResult.closed}`);
      for (const d of closeResult.details) console.log(`[paired-order] close: ${d}`);
    }

    const summary = {
      schema: 1,
      kind: 'DEMO_PAIRED_AUTO_CLOSE',
      account_mode: policy.mode,
      symbol: 'EURUSD',
      buy_lots: 0.50,
      sell_lots: 0.50,
      automatic_close: true,
      hold_before_close_seconds: Math.round(HOLD_MS / 1000),
      order_sequence: ['BUY', 'SELL'],
      atomic_simultaneous: false,
      buy_outcome: buyReport.outcome,
      sell_outcome: sellReport?.outcome ?? 'skipped',
      close_attempted: closeResult?.attempted ?? 0,
      close_closed: closeResult?.closed ?? 0,
      close_details: closeResult?.details ?? [],
      manual_account_check_required:
        buyReport.outcome !== 'executed_confirmed' ||
        (sellReport != null && sellReport.outcome !== 'executed_confirmed') ||
        (anyOpened && (closeResult?.closed ?? 0) < 1),
      finished_at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(pairDir, 'paired_order_summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log('[paired-order] Summary:', JSON.stringify(summary));
    process.exitCode = summary.manual_account_check_required ? 3 : 0;
  } catch (error) {
    console.error('Unexpected automation error:', error);
    await screenshotOnFailure(page, 'unexpected-error');
    process.exitCode = 1;
  } finally {
    await closeBrowser(browser, context);
  }
}

main().catch((error) => {
  console.error(error instanceof PolicyError ? error.message : error);
  process.exit(1);
});
