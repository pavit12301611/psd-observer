// Native bridge + actual Android Keystore/HTTP smoke test in an emulator.
// All PC responses are explicit fixtures; no provider call or real PC action.
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { _android as android } from 'playwright';
const packageName = 'in.observer.companion.preview';
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8' }).trim();
const requests = []; const jobs = new Map(); let executions = 0;
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', (d) => { raw += d; }); req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}; requests.push({ path: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/app/pair') { assert.equal(body.pin, '123456'); return res.end(JSON.stringify({ token: 'emulator-fixture-token', protocol: 2, capabilities: {jobs:true}, device:{id:'fixture-device'}, serverId:'fixture-server' })); }
    if (req.headers['x-bridge-token'] !== 'emulator-fixture-token') { res.statusCode = 401; return res.end('{}'); }
    if (req.url === '/api/status') return res.end(JSON.stringify({ version: '3.10.0', whatsapp: 'fixture only', model: 'fixture model' }));
    if (req.url === '/api/app/state') return res.end(JSON.stringify({ apiVersion: 1, version: '3.10.0', host: 'Emulator fixture PC', pcControl: false, active: [], pending: [] }));
    if(req.url==='/api/app/jobs'&&req.method==='POST'){
      if(!jobs.has(body.id)){executions++;jobs.set(body.id,{id:body.id,kind:'chat',deviceId:'fixture-device',label:'fixture',state:'running',createdAt:Date.now()});setTimeout(()=>{const j=jobs.get(body.id);j.state='replied';j.result={ok:true,text:'Native bridge round-trip succeeded. No real PC action was executed.'};},150);}
      if(!body.deliveredOnce){res.writeHead(202);res.end(JSON.stringify(jobs.get(body.id)));}return;
    }
    if(req.url==='/api/app/jobs')return res.end(JSON.stringify({jobs:[...jobs.values()]}));
    if(req.url.startsWith('/api/app/jobs/'))return res.end(JSON.stringify(jobs.get(req.url.split('/').pop())));
    if (req.url === '/api/chat') return res.end(JSON.stringify({ ok: true, text: 'Native bridge round-trip succeeded. No real PC action was executed.' }));
    return res.end(JSON.stringify({ downloads: [], shared: [] }));
  });
});
await new Promise((resolve) => server.listen(8787, '0.0.0.0', resolve));
fs.mkdirSync('android-smoke-results', { recursive: true });
let browser;
try {
  const devices = await android.devices();
  assert.ok(devices.length, 'No Android emulator connected');
  const device = devices[0];
  const webview = await device.webView({ pkg: packageName, timeout: 40000 });
  const page = await webview.page();
  browser = device;
  await expect(page.getByRole('heading', { name: /Think clearly/ })).toBeVisible({ timeout: 30000 });
  assert.equal(await page.evaluate(() => Boolean(window.ObserverAndroid?.postMessage)), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'android-smoke-results/01-native-home.png' });
  await page.getByRole('button', { name: 'Connect PC', exact: true }).click();
  await page.getByLabel('PC bridge address').fill('http://10.0.2.2:8787'); await page.getByLabel('Dashboard PIN').fill('123456'); await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Connect my PC', exact: true }).click(); await expect(page.getByRole('button', { name: 'PC connected', exact: true })).toBeVisible();
  await page.getByLabel('Message Observer').fill('emulator fixture hello'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Native bridge round-trip succeeded. No real PC action was executed.', { exact: true })).toBeVisible();
  assert.equal(executions,1);
  await page.waitForTimeout(1200);
  const encrypted = adb('shell', 'run-as', packageName, 'cat', 'shared_prefs/observer-vault.xml');
  assert.ok(!encrypted.includes('emulator-fixture-token'), 'credential must not be plaintext');
  assert.ok(!encrypted.includes('emulator fixture hello'), 'history must not be plaintext');
  assert.equal(await page.evaluate(() => Object.values(localStorage).some((s) => /emulator-fixture-token|123456/.test(s))), false);
  await page.reload(); await expect(page.getByRole('button', { name: 'PC connected', exact: true })).toBeVisible(); await expect(page.getByText('Native bridge round-trip succeeded. No real PC action was executed.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Switch to dark theme' }).click(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); await page.screenshot({ path: 'android-smoke-results/02-native-dark-chat.png' });
  fs.writeFileSync('android-smoke-results/result.json', JSON.stringify({ nativeBridge: 'passed', keystoreEncryptedCredentialsAndHistory: 'passed', restoredSession: 'passed', darkTheme: 'passed', requestCount: requests.length, jobExecutions: executions, physicalSamsungTest: 'not performed', providerCalls: 0, pcActions: 0 }, null, 2));
  console.log('Android emulator smoke: bundled UI, native HTTP, encrypted credential/history, restore and dark theme passed. No physical Samsung/provider/PC tests.');
} finally { if (browser) await browser.close(); await new Promise((resolve) => server.close(resolve)); }
