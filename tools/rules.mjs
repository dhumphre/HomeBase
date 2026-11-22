#!/usr/bin/env node
// Show or deploy the Firestore security rules through the Firebase Rules API, using the service-account key.
//   node tools/rules.mjs show                 print the live rules
//   node tools/rules.mjs deploy [file]        publish firestore.rules (default) as the live ruleset
// 'show' works with the default service account; 'deploy' (and rules-test.mjs) need it to hold the Firebase Rules Admin role
// in Google Cloud IAM. Until then, paste firestore.rules into Firestore > Rules in the Firebase console.
import { readFileSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { keyPath } from './lib.mjs';

const key = JSON.parse(readFileSync(keyPath, 'utf8')); const project = key.project_id;
const auth = new GoogleAuth({ credentials: key, scopes: ['https://www.googleapis.com/auth/firebase', 'https://www.googleapis.com/auth/cloud-platform'] });
const client = await auth.getClient(); const base = `https://firebaserules.googleapis.com/v1/projects/${project}`;
const [cmd, file = new URL('../firestore.rules', import.meta.url)] = process.argv.slice(2);

if (cmd === 'show') {
  const rel = await client.request({ url: `${base}/releases/cloud.firestore` });
  const rs = await client.request({ url: `https://firebaserules.googleapis.com/v1/${rel.data.rulesetName}` });
  console.log(`# ${rel.data.rulesetName} (updated ${rel.data.updateTime})`); console.log(rs.data.source.files.map(f => f.content).join('\n'));
} else if (cmd === 'deploy') {
  const content = readFileSync(file, 'utf8');
  const test = await client.request({ url: `${base}:test`, method: 'POST', data: { source: { files: [{ name: 'firestore.rules', content }] } } });
  if (test.data.issues && test.data.issues.length) { console.error('Rules have problems:'); test.data.issues.forEach(i => console.error(` ${i.severity} ${i.description} (line ${i.sourcePosition && i.sourcePosition.line})`)); process.exit(1); }
  const rs = await client.request({ url: `${base}/rulesets`, method: 'POST', data: { source: { files: [{ name: 'firestore.rules', content }] } } });
  const rel = await client.request({ url: `${base}/releases/cloud.firestore`, method: 'PATCH', data: { release: { name: `projects/${project}/releases/cloud.firestore`, rulesetName: rs.data.name } } });
  console.log(`Deployed ${rs.data.name} as cloud.firestore (${rel.data.updateTime})`);
} else console.log('usage: node tools/rules.mjs show | deploy [file]');
