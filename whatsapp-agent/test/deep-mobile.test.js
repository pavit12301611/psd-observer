import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createJobs } from '../src/mobile/jobs.js';
import { createDevices } from '../src/mobile/devices.js';
import { createWorkflows, previewWorkflow } from '../src/mobile/workflows.js';
import { createWorkspaces } from '../src/mobile/workspaces.js';
import { createRTC } from '../src/mobile/rtc.js';
import { createBridgeServer } from '../src/server.js';

function folder(t) { const p=fs.mkdtempSync(path.join(os.tmpdir(),'observer-mobile-')); t.after(()=>fs.rmSync(p,{recursive:true,force:true})); return p; }
const waitUntil = async (fn) => { for(let n=0;n<200;n++){if(fn())return;await new Promise(r=>setTimeout(r,5));} throw Error('fixture timed out'); };
const request = (id='fixture_request_123') => ({id,text:'a plain-text AI question',history:[]});

test('mobile/jobs: immediate accepted ID survives slow AI work and duplicates never dispatch again',async(t)=>{
 const dir=folder(t);let finish,calls=0;const gate=new Promise(r=>finish=r);
 const jobs=createJobs({file:path.join(dir,'jobs.json'),run:async()=>{calls++;await gate;return{ok:true,text:'actual fixture reply'};}});
 const a=jobs.submit(request(),{id:'device-a'});assert.equal(a.job.state,'accepted');
 await waitUntil(()=>calls===1);assert.equal(jobs.get(a.job.id).state,'running');
 assert.equal(jobs.submit(request(),{id:'device-a'}).existing,true);assert.equal(calls,1);
 assert.throws(()=>jobs.submit({...request(),text:'different command'},{id:'device-a'}),/different content/);
 assert.throws(()=>jobs.submit(request(),{id:'device-b'}),/different content/);
 finish();await waitUntil(()=>jobs.get(a.job.id).state==='replied');assert.equal(jobs.get(a.job.id).result.text,'actual fixture reply');
 const next=createJobs({file:path.join(dir,'jobs.json'),run:async()=>{calls++;}});assert.equal(next.get(a.job.id).result.text,'actual fixture reply');assert.equal(next.submit(request(),{id:'device-a'}).existing,true);assert.equal(calls,1);
 assert.equal(fs.statSync(path.join(dir,'jobs.json')).mode&0o777,0o600);
});
test('mobile/jobs: restart leaves running work UNKNOWN, never replays actions or stores original PIN payload',async(t)=>{
 const dir=folder(t);let calls=0;const file=path.join(dir,'jobs.json');const original=createJobs({file,run:async()=>{calls++;await new Promise(()=>{});}});
 original.submit({id:'private_command_123',text:'/run 4567 private-command'}, {id:'device'});await waitUntil(()=>calls===1);
 assert.doesNotMatch(fs.readFileSync(file,'utf8'),/4567|private-command/);
 const restored=createJobs({file,run:async()=>{calls++;}});assert.equal(restored.get('private_command_123').state,'unknown');assert.match(restored.get('private_command_123').result.text,/NOT replayed/);assert.equal(calls,1);
});
test('mobile/jobs: storage corruption fails closed and a busy agent receives no queued action',async(t)=>{
 const dir=folder(t), file=path.join(dir,'jobs.json');fs.writeFileSync(file,'bad');assert.throws(()=>createJobs({file}),/JSON/);
 let calls=0;const jobs=createJobs({busy:()=>true,run:async()=>{calls++;}});assert.throws(()=>jobs.submit(request()),/active/);assert.equal(calls,0);
});
test('mobile/devices: per-device token hashing, replacement, revocation and one-use QR expiry',t=>{
 const dir=folder(t);let time=1000;const d=createDevices({file:path.join(dir,'devices.json'),now:()=>time});
 const code=d.code('http://192.168.1.12:8787');assert.equal(d.consumeCode(code.code),true);assert.equal(d.consumeCode(code.code),false);
 const expired=d.code('http://192.168.1.12:8787');time+=120000;assert.equal(d.consumeCode(expired.code),false);
 const first=d.register({clientId:'abcdef0123456789',name:'A53'});assert.equal(d.authenticate(first.token).id,first.device.id);
 assert.doesNotMatch(fs.readFileSync(path.join(dir,'devices.json'),'utf8'),new RegExp(first.token));assert.equal('tokenHash' in d.list()[0],false);
 const second=d.register({clientId:'abcdef0123456789',name:'A53 again'});assert.equal(d.authenticate(first.token),null);assert.ok(d.authenticate(second.token));d.revoke(second.device.id);assert.equal(d.authenticate(second.token),null);
});
test('mobile/workflows: preview never acts; command injection/approvals/shell/nesting are rejected',()=>{
 for(const tool of ['run','yes','confirm','dsh','macro','workflow'])assert.throws(()=>previewWorkflow({name:'bad',steps:[{tool,value:'x'}]}),/Unsupported/);
 assert.throws(()=>previewWorkflow({name:'bad',steps:[{tool:'note',value:'safe\n/yes'}]}),/single-line/);
 assert.equal(previewWorkflow({name:'read',steps:[{tool:'time'}]}).steps[0].command,'/time');
});
test('mobile/workflows: confirmations and cancellation halt following steps, no implicit approval',async()=>{
 let pending=false;const calls=[];const w=createWorkflows({runOwner:async text=>{calls.push(text);pending=true;return'approval needed';},pending:()=>pending});
 const saved=w.save({name:'safe',steps:[{tool:'open',value:'fixture'},{tool:'note',value:'never'}]});const result=await w.run(saved.id);
 assert.deepEqual(calls,['/open fixture']);assert.match(result.text,/NOT started|Paused/);
});
test('mobile/workspaces: bounded independent memory and immutable Personal context',()=>{
 const w=createWorkspaces();const a=w.save({name:'Study',privateChat:true,memories:['study-only']});const b=w.save({name:'Work',privateChat:true,memories:['work-only']});
 assert.deepEqual(w.get(a.id).memories,['study-only']);assert.deepEqual(w.get(b.id).memories,['work-only']);assert.throws(()=>w.remove('personal00'),/cannot/);
});
test('mobile/rtc: explicit publisher, viewer ownership, bounded SDP, timeout and stop',()=>{
 let now=1000;const r=createRTC({now:()=>now}), pc={id:'pc',kind:'owner'},phone={id:'phone',kind:'device'};
 assert.throws(()=>r.create(phone,'saver'),/explicitly/);r.publisher(pc,'start');const s=r.create(phone,'saver');
 assert.throws(()=>r.signal(s.id,{id:'other',kind:'device'}),/another device/);
 r.signal(s.id,pc,{description:{type:'offer',sdp:'fixture'}});assert.equal(r.signal(s.id,phone).offer.sdp,'fixture');
 assert.throws(()=>r.signal(s.id,phone,{description:{type:'offer',sdp:'bad'}}),/Invalid/);
 now+=26000;assert.equal(r.status().ready,true);assert.equal(r.status().active,0);assert.throws(()=>r.signal(s.id,phone),/expired/);now+=91000;assert.equal(r.status().ready,false);
});
async function bridgeFixture(t){
 const dir=folder(t);let finish,calls=0;const gate=new Promise(r=>finish=r);
 const bridge=createBridgeServer({config:{dataDir:dir,host:'127.0.0.1',port:0,bridgeToken:'mobile-fixture-root',dashboardPin:'123456',ownerNumber:'919999999999'},store:{data:{stats:{}}},whatsapp:{status:()=> 'fixture'},mailbox:{observerOnline:()=>false},app:{state:()=>({active:[],pending:[]}),busy:()=>false},runOwner:async()=>{calls++;await gate;return'slow AI result';},log:{info(){},error(){}}});
 const server=await bridge.start();t.after(async()=>{server.closeAllConnections();const p=once(server,'close');bridge.stop();await p;});const url=`http://127.0.0.1:${server.address().port}`;
 const api=async(path,body,token='mobile-fixture-root')=>fetch(url+path,{method:body?'POST':'GET',headers:{'x-bridge-token':token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
 return{url,api,calls:()=>calls,finish};
}
test('mobile/HTTP regression: closing an AI request socket cannot lose its result or execute twice',async t=>{
 const f=await bridgeFixture(t);const payload=request('socket_abort_1234');
 await new Promise(resolve=>{const req=http.request(f.url+'/api/app/jobs',{method:'POST',headers:{'x-bridge-token':'mobile-fixture-root','content-type':'application/json'}},res=>{assert.equal(res.statusCode,202);res.destroy();resolve();});req.on('error',resolve);req.end(JSON.stringify(payload));});
 await waitUntil(()=>f.calls()===1);let result=await(await f.api('/api/app/jobs/'+payload.id)).json();assert.equal(result.state,'running');
 // A reconnect repeats only the stable acceptance ID, not a second execution.
 const same=await f.api('/api/app/jobs',payload);assert.equal(same.status,200);assert.equal(f.calls(),1);
 f.finish();await waitUntil(()=>f.calls()===1);for(let n=0;n<100;n++){result=await(await f.api('/api/app/jobs/'+payload.id)).json();if(result.state==='replied')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(result.result.text,'slow AI result');assert.equal(f.calls(),1);
});
test('mobile/HTTP: device pairing is rate-limited and revoked sessions cannot read owner data',async t=>{
 const f=await bridgeFixture(t);const p=await(await f.api('/api/app/pair',{pin:'123456',clientId:'abcdef0123456789',name:'A53'})).json();assert.ok(p.token);
 assert.equal((await f.api('/api/app/jobs',null,p.token)).status,200);
 await f.api('/api/app/devices/revoke',{id:p.device.id});assert.equal((await f.api('/api/app/jobs',null,p.token)).status,401);
});
