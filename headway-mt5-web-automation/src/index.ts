#!/usr/bin/env node
/**
 * Minimal Headway MT5 demo runner: login, then submit one EURUSD BUY 0.50
 * followed by one EURUSD SELL 0.50. No strategy engine or market-data provider.
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { launchBrowser, closeBrowser } from './browser';
import { performLogin, getLastLoginReport } from './login';
import { loadPolicy, PolicyError } from './policy';
import { writeAuthResult } from './authResult';
import { assertOrderAllowed, OrderGuardError, runDummyOrder } from './order';
import { screenshotOnFailure } from './utils';

dotenv.config();

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
  console.log('Fixed orders: EURUSD BUY 0.50, then EURUSD SELL 0.50');
  console.log('Automatic close: disabled; manual close required.');

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

    if (buyReport.outcome === 'executed_confirmed') {
      console.log('[paired-order] BUY passed the current margin-change confirmation; proceeding with SELL.');
      sellReport = await runDummyOrder(page, policy, sellReq, path.join(pairDir, 'sell'));
    } else {
      console.error(`[paired-order] BUY outcome=${buyReport.outcome}; SELL skipped. Check the demo account manually.`);
    }

    const summary = {
      schema: 1,
      kind: 'DEMO_PAIRED_MANUAL_CLOSE',
      account_mode: policy.mode,
      symbol: 'EURUSD',
      buy_lots: 0.50,
      sell_lots: 0.50,
      automatic_close: false,
      order_sequence: ['BUY', 'SELL'],
      atomic_simultaneous: false,
      buy_outcome: buyReport.outcome,
      sell_outcome: sellReport?.outcome ?? 'skipped',
      manual_account_check_required:
        buyReport.outcome !== 'executed_confirmed' || sellReport?.outcome !== 'executed_confirmed',
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
