import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Headway must not collect candles or supply prices. Enforce it structurally.
const src = path.join(__dirname, '..', 'src');
const files = fs.readdirSync(src).filter(f => f.endsWith('.ts'));
for (const gone of ['quotes.ts', 'ticks.ts', 'history.ts', 'nativeRates.ts', 'chartparse.ts', 'chartprobe.ts', 'probe.ts']) {
  assert.ok(!files.includes(gone), `${gone} must not exist`);
}
const banned = /parseQuotes|readQuotes|waitForQuote|collectSamples|aggregateTicks|fetchNativeM30|\bquote\.(bid|ask)\b/;
for (const f of files) assert.ok(!banned.test(fs.readFileSync(path.join(src, f), 'utf8')), `${f} reads market data`);
console.log('no-market-data: all assertions passed');
