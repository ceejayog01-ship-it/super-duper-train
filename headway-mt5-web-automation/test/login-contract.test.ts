import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const loginSource = fs.readFileSync(path.join(__dirname, '../src/login.ts'), 'utf8');
assert.ok(!loginSource.includes('server_label_missing'), 'login must not abort on exact server-label visibility');
assert.ok(!loginSource.includes('checkServerLabel'), 'login must not invoke exact server-name matching');
assert.ok(loginSource.includes('terminalEvidence && !loginFormVisible && !authError'),
  'downstream execution requires a successful terminal workspace, not merely submitted credentials');
console.log('login contract: no exact server label gate; successful workspace required');
