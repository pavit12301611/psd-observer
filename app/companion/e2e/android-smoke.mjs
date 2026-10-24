// Native bridge + actual Android Keystore/HTTP smoke test in an emulator.
// All PC responses are explicit fixtures; no provider call or real PC action.
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { _android as android } from 'playwright';
import { attachStableStartup } from './android-startup.mjs';
import { enterEmulatorCredential } from './android-credential.mjs';
const packageName = 'in.observer.companion.preview';
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8' }).trim();
const requests = []; const jobs = new Map(); let executions = 0; let abortedAcceptance = false;
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', (d) => { raw += d; }); req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}; requests.push({ path: req.url, body });
    res.setHeader('content-type', 'application/json');
    if(req.url==='/health')return res.end(JSON.stringify({ok:true,service:'observer-whatsapp-agent',version:'3.10.0'}));
    if (req.url === '/api/app/pair') { assert.equal(body.pin, '123456'); return res.end(JSON.stringify({ token: 'emulator-fixture-token', protocol: 2, capabilities: {jobs:true}, device:{id:'fixture-device'}, serverId:'fixture-server' })); }
    if (req.headers['x-bridge-token'] !== 'emulator-fixture-token') { res.statusCode = 401; return res.end('{}'); }
    if (req.url === '/api/status') return res.end(JSON.stringify({ version: '3.10.0', whatsapp: 'fixture only', model: 'fixture model' }));
    if (req.url === '/api/app/state') return res.end(JSON.stringify({ apiVersion: 1, version: '3.10.0', host: 'Emulator fixture PC', pcControl: false, active: [], pending: [] }));
    if(req.url.startsWith('/api/app/events/stream')) {res.setHeader('content-type','text/event-stream');res.write('event: ready\ndata: '+JSON.stringify({epoch:'fixture-events',latest:0})+'\n\n');setTimeout(()=>{if(!res.destroyed)res.write('id: 1\ndata: '+JSON.stringify({epoch:'fixture-events',id:1,type:'job_result',text:'PRIVATE-FIXTURE-CONTENT'})+'\n\n');},500);return;}
    if(req.url==='/api/app/jobs'&&req.method==='POST'){
      if(!jobs.has(body.id)){executions++;jobs.set(body.id,{id:body.id,kind:'chat',deviceId:'fixture-device',label:'fixture',state:'running',createdAt:Date.now()});setTimeout(()=>{const j=jobs.get(body.id);j.state='replied';j.result={ok:true,text:'Native bridge round-trip succeeded. No real PC action was executed.'};},150);}
      if(!abortedAcceptance&&body.kind==='chat'){abortedAcceptance=true;res.destroy();return;}
      res.writeHead(202);res.end(JSON.stringify(jobs.get(body.id)));return;
    }
    if(req.url==='/api/app/jobs')return res.end(JSON.stringify({jobs:[...jobs.values()]}));
    if(req.url.startsWith('/api/app/jobs/'))return res.end(JSON.stringify(jobs.get(req.url.split('/').pop())));
    if (req.url === '/api/chat') return res.end(JSON.stringify({ ok: true, text: 'Native bridge round-trip succeeded. No real PC action was executed.' }));
    return res.end(JSON.stringify({ downloads: [], shared: [] }));
  });
});
await new Promise((resolve) => server.listen(8787, '0.0.0.0', resolve));
fs.mkdirSync('android-smoke-results', { recursive: true });
let browser, diagnosticPage = null, stage = 'startup';
try {
  const devices = await android.devices();
  assert.ok(devices.length, 'No Android emulator connected');
  const device = devices[0];
  browser = device;
  let originalPid = null;
  const { page, reattachments } = await attachStableStartup({ device, packageName,
    sameProcess: async () => { try { return adb('shell','pidof',packageName).split(' ')[0] === originalPid; } catch { return false; } },
    report: (text) => console.log(text),
    probe: async (page) => {
      if (!originalPid) originalPid = adb('shell','pidof',packageName).split(' ')[0];
      await expect(page.getByRole('heading', { name: /Think clearly/ })).toBeVisible({ timeout: 30000 });
      assert.equal(await page.evaluate(() => Boolean(window.ObserverAndroid?.postMessage)), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: 'android-smoke-results/01-native-home.png' });
    },
  });
  diagnosticPage=page;
  stage='pairing';
  await page.getByRole('button', { name: 'Connect PC', exact: true }).click();
  await page.getByLabel('PC bridge address').fill('http://10.0.2.2:8787'); await page.getByLabel('Dashboard PIN').fill('123456'); await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Connect my PC', exact: true }).click(); await expect(page.getByRole('button', { name: 'PC connected', exact: true })).toBeVisible();
  stage='native-abort-recovery';
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
  stage='native-share';
  // Android-native share intent must remain a reviewed, read-only draft.
  adb('shell','am','start','-n',packageName+'/in.observer.companion.MainActivity','-a','android.intent.action.SEND','-t','text/plain','--es','android.intent.extra.TEXT','/yes');
  await expect(page.getByLabel('Message Observer')).toHaveValue('/yes');
  await expect(page.getByText('Shared reference · read-only answer. Its contents cannot execute PC commands.')).toBeVisible();
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.getByText('Native bridge round-trip succeeded. No real PC action was executed.',{exact:true})).toBeVisible();
  assert.ok(requests.some(r=>r.path==='/api/app/jobs'&&r.body.kind==='reference'&&r.body.text==='/yes'));
  assert.ok(!requests.some(r=>r.path==='/api/chat'&&r.body.text==='/yes'));
  const native=async(method,payload={})=>page.evaluate(({method,payload})=>new Promise((resolve,reject)=>{const id=crypto.randomUUID();const done=e=>{const packet=typeof e.detail==='string'?JSON.parse(e.detail):e.detail;if(packet.id!==id)return;window.removeEventListener('observer-native-result',done);packet.ok?resolve(packet.data):reject(new Error(packet.error));};window.addEventListener('observer-native-result',done);window.ObserverAndroid.postMessage(JSON.stringify({id,method,payload}));}),{method,payload});
  stage='private-alerts';
  const lock=await native('getLockState');assert.equal(lock.enabled,false);
  // Permission is synthetic emulator state, not a bypass in the shipped app.
  adb('shell','pm','grant',packageName,'android.permission.POST_NOTIFICATIONS');
  await native('startAlerts');
  adb('shell','input','keyevent','KEYCODE_HOME');await new Promise(r=>setTimeout(r,1800));
  const services=adb('shell','dumpsys','activity','services',packageName);assert.ok(services.includes('AlertService'));
  const notifications=adb('shell','dumpsys','notification','--noredact');assert.ok(!notifications.includes('PRIVATE-FIXTURE-CONTENT'));
  adb('shell','am','start','-n',packageName+'/in.observer.companion.MainActivity');await page.waitForTimeout(700);await native('stopAlerts');
  stage='device-credential-enable';
  adb('shell','locksettings','set-pin','4826');
  const enableLock = native('setAppLock',{enabled:true});
  // Consume rejections immediately while native system UI owns the foreground.
  enableLock.catch(()=>{});
  await enterEmulatorCredential({
    readTree: async () => { adb('shell','uiautomator','dump','--compressed','/sdcard/observer-credential.xml'); return adb('shell','cat','/sdcard/observer-credential.xml'); },
    tap: async ({x,y}) => { adb('shell','input','tap',String(x),String(y)); },
    typeOnce: async () => { adb('shell','input','text','4826'); },
    submit: async () => { adb('shell','input','keyevent','KEYCODE_ENTER'); },
  });
  await Promise.race([enableLock,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Device-credential confirmation did not finish after system PIN entry')),15000))]);
  assert.equal((await native('getLockState')).enabled,true);
  adb('shell','input','keyevent','KEYCODE_HOME');await new Promise(r=>setTimeout(r,400));
  stage='locked-api-gate';
  adb('shell','am','start','-n',packageName+'/in.observer.companion.MainActivity');
  await new Promise(r=>setTimeout(r,400));
  await assert.rejects(native('request',{path:'/api/app/jobs'}),/Unlock Observer first/);

  fs.writeFileSync('android-smoke-results/result.json', JSON.stringify({ nativeBridge: 'passed', readOnlyStartupReattachments: reattachments, nativeAbortedAcceptanceRecovery: 'passed', nativeReadOnlyShare: 'passed', privateForegroundAlerts: 'passed', genericNotificationPrivacy: 'passed', deviceCredentialAppGate: 'passed', keystoreEncryptedCredentialsAndHistory: 'passed', restoredSession: 'passed', darkTheme: 'passed', requestCount: requests.length, jobExecutions: executions, physicalSamsungTest: 'not performed', providerCalls: 0, pcActions: 0 }, null, 2));
  console.log('Android emulator smoke: bundled UI, native HTTP, encrypted credential/history, restore and dark theme passed. No physical Samsung/provider/PC tests.');
} catch(error) {
  fs.writeFileSync('android-smoke-results/failure.json',JSON.stringify({stage,message:String(error.message)},null,2));
  console.error('NATIVE_SMOKE_STAGE='+stage);
  const escapeAnnotation = (s) => String(s).replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A');
  console.error(`::error title=Native smoke ${stage}::${escapeAnnotation(String(error.stack || error)).slice(0,2800)}`);
  console.error('NATIVE_HTTP_PATHS='+JSON.stringify(requests.map(r=>r.path)));
  if(diagnosticPage&&!diagnosticPage.isClosed())try{
    const alerts=await diagnosticPage.locator('[role="alert"]').allTextContents();
    if(alerts.length)console.error(`::error title=Native app alert::${escapeAnnotation(alerts.join(' | ')).slice(0,2800)}`);
  }catch{}

  try {
    const crash = adb('logcat','-d','-v','brief','-t','180','AndroidRuntime:E','chromium:E','ActivityTaskManager:W','*:S');
    fs.writeFileSync('android-smoke-results/startup-logcat.txt',crash);
    console.error('ANDROID_STARTUP_LOGCAT\n'+crash.slice(-12000));
  } catch { console.error('Android crash log unavailable'); }
  try {
    try { adb('shell','uiautomator','dump','--compressed','/sdcard/observer-failure-ui.xml'); const tree=adb('shell','cat','/sdcard/observer-failure-ui.xml'); fs.writeFileSync('android-smoke-results/native-ui.xml',tree); console.error('NATIVE_SYSTEM_UI\n'+tree.slice(-7000)); } catch {}
    const exits = adb('shell','dumpsys','activity','exit-info',packageName);
    fs.writeFileSync('android-smoke-results/process-exits.txt',exits);
    console.error('ANDROID_PROCESS_EXIT_INFO\n'+exits.slice(-4000));
  } catch { /* Preserve the original failure. */ }
  throw error;
} finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
