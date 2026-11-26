import * as assert from 'assert';
import { parseMargin } from '../src/account';

// margin: not "Free Margin"
assert.strictEqual(parseMargin('Balance: $7,125.38 Equity: $7,125.38 Margin: $0.00 Free Margin: $7,125.38'), 0);
assert.strictEqual(parseMargin('Free Margin: $9.00 Margin: $1,234.50'), 1234.5);
assert.strictEqual(parseMargin('Free Margin: $9.00'), null);
console.log('parsers: all assertions passed');
