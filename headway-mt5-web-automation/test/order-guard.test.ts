import * as assert from 'assert';
import { loadPolicy } from '../src/policy';
import { assertOrderAllowed, OrderGuardError, MAX_DUMMY_LOTS, orderExitCode } from '../src/order';

const demo = loadPolicy({});
const real = loadPolicy({ ACCOUNT_MODE: 'real' });
const base = { symbol: 'EURUSD', side: 'buy' as const, lots: 0.01, execute: false, closeAfter: false };
const fails = (fn: () => void, reason: string) => assert.throws(fn, (e: Error) => e instanceof OrderGuardError && e.message.startsWith(reason), reason);

// dry run needs no permission, on either account
assertOrderAllowed(demo, base, {});
assertOrderAllowed(real, base, {});
// executing needs the explicit flag
fails(() => assertOrderAllowed(demo, { ...base, execute: true }, {}), 'orders_disabled');
assertOrderAllowed(demo, { ...base, execute: true }, { ALLOW_ORDERS: 'yes' });
fails(() => assertOrderAllowed(demo, { ...base, execute: true }, { ALLOW_ORDERS: 'true' }), 'orders_disabled');
// Automated execution is demo-only. Real-account order attempts are blocked
// even when legacy confirmation variables are present.
const env = { ALLOW_ORDERS: 'yes', MT5_LOGIN: '9876543', REAL_ORDER_CONFIRM: 'REAL-6543' };
fails(() => assertOrderAllowed(real, { ...base, execute: true }, env), 'automated_execution_demo_only');
// limits
fails(() => assertOrderAllowed(demo, { ...base, symbol: 'XAUUSD' }, {}), 'symbol_not_allowed');
assertOrderAllowed(demo, { ...base, symbol: 'XAUUSD' }, { ORDER_SYMBOLS: 'EURUSD,XAUUSD' });
assertOrderAllowed(demo, { ...base, lots: 0.5 }, {});
fails(() => assertOrderAllowed(demo, { ...base, lots: 0.51 }, {}), 'lots_out_of_range');
fails(() => assertOrderAllowed(demo, { ...base, lots: 0 }, {}), 'lots_out_of_range');
fails(() => assertOrderAllowed(demo, { ...base, lots: NaN }, {}), 'lots_out_of_range');
fails(() => assertOrderAllowed(demo, { ...base, lots: 0.015 }, {}), 'lots_not_multiple');
assertOrderAllowed(demo, { ...base, lots: MAX_DUMMY_LOTS }, {});
fails(() => assertOrderAllowed(demo, { ...base, closeAfter: true }, {}), 'close_requires_execute');
// exit codes: unverified or half-closed outcomes are never reported as success
assert.deepStrictEqual(['dry_run_ok', 'executed_confirmed', 'executed_unconfirmed', 'executed_confirmed_close_failed', 'failed:x'].map(orderExitCode), [0, 0, 3, 3, 1]);
console.log('order-guard: all assertions passed');
