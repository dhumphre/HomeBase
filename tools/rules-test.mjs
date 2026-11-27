// Dry-run the household rules against the Rules API test endpoint before deploying them.
import { readFileSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { keyPath } from './lib.mjs';
const key = JSON.parse(readFileSync(keyPath, 'utf8')); const project = key.project_id; const OWNER = process.argv[2];
const auth = new GoogleAuth({ credentials: key, scopes: ['https://www.googleapis.com/auth/firebase', 'https://www.googleapis.com/auth/cloud-platform'] });
const client = await auth.getClient();
const content = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
const db = `/projects/${project}/databases/(default)/documents`;
const access = (email, owner) => ({ function: 'get', args: [{ exactValue: `${db}/access/${email}` }], result: owner ? { value: { data: { owner } } } : { undefined: {} } });
const req = (uid, email, path, method = 'get') => ({ auth: { uid, token: { email, email_verified: true } }, path: `${db}/${path}`, method, time: new Date().toISOString() });
// An update of access/{email} from `before` to `after` (request.resource), by uid/email.
const claim = (uid, email, before, after, target = email) => ({ ...req(uid, email, `access/${target}`, 'update'), resource: { data: after }, _existing: { data: before } });
const cases = [
  ['owner reads an asset', 'ALLOW', req(OWNER, 'dhumphre@gmail.com', `users/${OWNER}/assets/a1`), [access('dhumphre@gmail.com', OWNER)]],
  ['owner writes the map', 'ALLOW', req(OWNER, 'dhumphre@gmail.com', `users/${OWNER}/map/layout`, 'update'), [access('dhumphre@gmail.com', OWNER)]],
  ['michelle reads the log', 'ALLOW', req('michelleUid', 'michelle.bose@gmail.com', `users/${OWNER}/log/l1`), [access('michelle.bose@gmail.com', OWNER)]],
  ['michelle writes a to-do', 'ALLOW', req('michelleUid', 'michelle.bose@gmail.com', `users/${OWNER}/todos/t1`, 'create'), [access('michelle.bose@gmail.com', OWNER)]],
  ['stranger reads an asset', 'DENY', req('strangerUid', 'someone@example.com', `users/${OWNER}/assets/a1`), [access('someone@example.com', null)]],
  ['stranger reads own empty tree', 'DENY', req('strangerUid', 'someone@example.com', `users/strangerUid/assets/a1`), [access('someone@example.com', null)]],
  ['stranger writes the access list', 'DENY', req('strangerUid', 'someone@example.com', `access/someone@example.com`, 'create'), []],
  ['almanac places stay per account', 'ALLOW', req('strangerUid', 'someone@example.com', `users/strangerUid`, 'update'), []],
  // Separate logbooks: an invited account claims its invite (owner = its own uid) and gets only its own, empty tree.
  ['invitee claims its invite', 'ALLOW', claim('bilUid', 'bil@example.com', { invite: true, invitedBy: OWNER, email: 'bil@example.com', added: 1 }, { owner: 'bilUid', invitedBy: OWNER, email: 'bil@example.com', added: 1 }), []],
  ['invitee aims its invite at the owner', 'DENY', claim('bilUid', 'bil@example.com', { invite: true, invitedBy: OWNER, email: 'bil@example.com', added: 1 }, { owner: OWNER, invitedBy: OWNER, email: 'bil@example.com', added: 1 }), []],
  ['member repoints its entry', 'DENY', claim('michelleUid', 'michelle.bose@gmail.com', { owner: OWNER, email: 'michelle.bose@gmail.com', added: 1 }, { owner: 'michelleUid', email: 'michelle.bose@gmail.com', added: 1 }), []],
  ['stranger claims someone else\'s invite', 'DENY', claim('strangerUid', 'someone@example.com', { invite: true, invitedBy: OWNER, email: 'bil@example.com', added: 1 }, { owner: 'strangerUid', invitedBy: OWNER, email: 'bil@example.com', added: 1 }, 'bil@example.com'), []],
  ['invitee reads its own logbook', 'ALLOW', req('bilUid', 'bil@example.com', `users/bilUid/assets/a1`), [access('bil@example.com', 'bilUid')]],
  ['invitee reads the owner\'s asset', 'DENY', req('bilUid', 'bil@example.com', `users/${OWNER}/assets/a1`), [access('bil@example.com', 'bilUid')]],
  ['signed out', 'DENY', { auth: null, path: `${db}/users/${OWNER}/assets/a1`, method: 'get', time: new Date().toISOString() }, []],
];
const res = await client.request({ url: `https://firebaserules.googleapis.com/v1/projects/${project}:test`, method: 'POST', data: { source: { files: [{ name: 'firestore.rules', content }] }, testSuite: { testCases: cases.map(([, expectation, { _existing, ...request }, functionMocks]) => ({ expectation, request, functionMocks, ...(_existing ? { resource: _existing } : {}) })) } } });
if (res.data.issues && res.data.issues.length) { console.log('Issues:', JSON.stringify(res.data.issues, null, 1)); process.exit(1); }
let bad = 0; res.data.testResults.forEach((r, i) => { const ok = r.state === 'SUCCESS'; if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${cases[i][0]} (expect ${cases[i][1]})${ok ? '' : ' ' + JSON.stringify(r.debugMessages || r.errorPosition || r)}`); });
process.exit(bad ? 1 : 0);
