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
async function bridgeFixture(t,overrides={}){
 const dir=folder(t);let finish,calls=0;const gate=new Promise(r=>finish=r);
 const bridge=createBridgeServer({config:{dataDir:dir,host:'127.0.0.1',port:0,bridgeToken:'mobile-fixture-root',dashboardPin:'123456',ownerNumber:'919999999999',...overrides},store:{data:{stats:{}}},whatsapp:{status:()=> 'fixture'},mailbox:{observerOnline:()=>false},app:{state:()=>({active:[],pending:[]}),busy:()=>false},runOwner:async()=>{calls++;await gate;return'slow AI result';},log:{info(){},error(){}}});
 const server=await bridge.start();t.after(async()=>{server.closeAllConnections();const p=once(server,'close');bridge.stop();await p;});const url=`http://127.0.0.1:${server.address().port}`;
 const api=async(path,body,token='mobile-fixture-root')=>fetch(url+path,{method:body?'POST':'GET',headers:{'x-bridge-token':token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
 return{url,api,calls:()=>calls,finish,publish:(text)=>bridge.publish(text)};
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

test('mobile/private context: reference slash commands cannot consume approvals or expose global owner prompt facts',async(t)=>{
 const {createAgent}=await import('../src/commands.js');const {Store}=await import('../src/store.js');const {systemPrompt}=await import('../src/ai.js');const dir=folder(t),store=new Store(path.join(dir,'state.json'));
 const config={dataDir:dir,ownerNumber:'919999999999',agentNumber:'918888888888',allowPcControl:false,allowShell:false,agentTag:false,aiProvider:'none',wikiGrounding:false};
 const agent=createAgent({config,store,log:{info(){},warn(){},error(){}}});let ran=0;agent.actions.registry.find(e=>e.name==='close_app').run=async()=>{ran++;return'fixture';};
 await agent.actions.execute('close_app',{app:'fixture'});const original=store.data.pending;
 await agent.handle('/yes',{readOnlyReference:true,mobileProject:{name:'Reference',privateChat:true,memories:[]}});assert.equal(ran,0);assert.equal(store.data.pending,original);
 const prompt=systemPrompt(config,{data:{facts:{secret:'DO-NOT-LEAK'}}},{privateProject:{name:'Study',memories:['study-only']}});assert.ok(prompt.includes('study-only'));assert.ok(!prompt.includes('DO-NOT-LEAK'));store.saveNow();
});
test('mobile/real agent AI path: slow model completion is independent of the mobile acceptance socket',async(t)=>{
 const {createAgent}=await import('../src/commands.js');const {Store}=await import('../src/store.js');const {loadConfig}=await import('../src/config.js');const dir=folder(t);let providerCalls=0;
 const provider=http.createServer((req,res)=>{let text='';req.on('data',d=>text+=d);req.on('end',()=>{providerCalls++;const body=JSON.parse(text);assert.ok(body.messages.some(m=>String(m.content).includes('recursion')));setTimeout(()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'Delayed model fixture: recursion uses a base case.'}}]}));},100);});});provider.listen(0,'127.0.0.1');await once(provider,'listening');t.after(()=>provider.close());
 const config=loadConfig({dryRun:true,env:{DATA_DIR:dir,OWNER_NUMBER:'919999999999',AGENT_NUMBER:'918888888888',BRIDGE_TOKEN:'fixture-ai-root',DASHBOARD_PIN:'123456',HOST:'127.0.0.1',PORT:'0',AI_PROVIDER:'groq',GROQ_API_KEY:'fixture-not-real',GROQ_BASE_URL:`http://127.0.0.1:${provider.address().port}/v1`,GROQ_MODEL:'fixture',GROQ_MODEL_SMALL:'fixture',AGENT_TOOLS:'false',WIKI_GROUNDING:'off',AI_CACHE:'false'}});
 const store=new Store(path.join(dir,'store.json')),agent=createAgent({config,store,log:{info(){},error(){},warn(){}}});const bridge=createBridgeServer({config,store,app:agent.app,actions:agent.actions,runOwner:(text,ctx)=>agent.handle(text,ctx),whatsapp:{status:()=> 'fixture'},mailbox:{observerOnline:()=>false},log:{info(){},error(){}}});const server=await bridge.start();t.after(async()=>{server.closeAllConnections();const closed=once(server,'close');bridge.stop();await closed;store.saveNow();});const base=`http://127.0.0.1:${server.address().port}`,headers={'content-type':'application/json','x-bridge-token':'fixture-ai-root'};
 const accepted=await fetch(base+'/api/app/jobs',{method:'POST',headers,body:JSON.stringify({id:'real_ai_job_12345',text:'explain recursion with one simple example',history:[]})});assert.equal(accepted.status,202);
 let result;for(let n=0;n<300;n++){result=await(await fetch(base+'/api/app/jobs/real_ai_job_12345',{headers})).json();if(result.state==='replied')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(result.state,'replied');assert.match(result.result.text,/Delayed model fixture/);assert.equal(providerCalls,1);
});

test('mobile/jobs: safety receipts outlive the 40-result window and cannot silently execute an old ID again',async()=>{
 let calls=0;const j=createJobs({run:async()=>{calls++;return{text:'reply'};}});
 for(let n=0;n<45;n++){const id='retained_receipt_'+n;j.submit(request(id));await waitUntil(()=>j.get(id).state==='replied');}
 assert.equal(calls,45);assert.equal(j.submit(request('retained_receipt_0')).existing,true);assert.equal(calls,45);assert.match(j.get('retained_receipt_0').result.text,/retention expired/);
});
test('mobile/workflows: daily schedule receipt survives restart and is never caught up/replayed',t=>{
 const dir=folder(t),file=path.join(dir,'workflows.json'),now=()=>Date.parse('2026-10-24T08:30:20Z');
 const w=createWorkflows({file,now,timezone:'Asia/Kolkata'});const saved=w.save({name:'Daily',steps:[{tool:'time'}],trigger:{type:'daily',time:'14:00'}});
 const due=w.scheduled();assert.equal(due.length,1);w.markScheduled(saved.id,due[0].day);assert.equal(w.scheduled().length,0);
 assert.equal(createWorkflows({file,now,timezone:'Asia/Kolkata'}).scheduled().length,0);
});
test('mobile/HTTP: native video honors disabled PC-control policy and device PIN failures are rate-limited',async t=>{
 const f=await bridgeFixture(t,{allowPcControl:false});assert.equal((await f.api('/api/app/rtc')).status,403);
 for(let n=0;n<12;n++)assert.equal((await f.api('/api/app/pair',{pin:'wrong',clientId:'abcdef0123456789'})).status,401);
 assert.equal((await f.api('/api/app/pair',{pin:'123456',clientId:'abcdef0123456789'})).status,429);
});
test('mobile/HTTP: an invalid optional push file cannot disable ordinary mobile jobs',async t=>{
 const f=await bridgeFixture(t,{appFcmCredentials:'/no/such/fixture/file'});const state=await(await f.api('/api/app/state')).json();assert.equal(state.capabilities.jobs,true);assert.equal(state.capabilities.push.configured,false);
});
test('mobile/HTTP: a revoked event-stream device is closed before another event can leak',async t=>{
 const f=await bridgeFixture(t);const paired=await(await f.api('/api/app/pair',{pin:'123456',clientId:'abcdef0123456789'})).json();
 const response=await fetch(f.url+'/api/app/events/stream',{headers:{'x-bridge-token':paired.token}});const reader=response.body.getReader();await reader.read();
 await f.api('/api/app/devices/revoke',{id:paired.device.id});const next=await reader.read();assert.equal(next.done,true);
});

test('mobile/push: optional OS delivery sends opaque metadata only, uses fixed HTTPS endpoints and caches auth',async t=>{
 const {generateKeyPairSync}=await import('node:crypto');const {createPush}=await import('../src/mobile/push.js');const dir=folder(t),file=path.join(dir,'fake-service-account.json');const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});fs.writeFileSync(file,JSON.stringify({client_email:'fixture@fixture.invalid',project_id:'fixture-project',private_key:privateKey.export({type:'pkcs8',format:'pem'})}),{mode:0o600});
 let oauth=0,delivery=0;const p=createPush({credentialsFile:file,targets:()=>[{id:'device',token:'fixture-registration'}],fetchImpl:async(url,options)=>{assert.ok(url.startsWith('https://'));if(url==='https://oauth2.googleapis.com/token'){oauth++;assert.equal(new URLSearchParams(options.body).get('grant_type'),'urn:ietf:params:oauth:grant-type:jwt-bearer');return new Response(JSON.stringify({access_token:'fixture-oauth'}));}assert.equal(url,'https://fcm.googleapis.com/v1/projects/fixture-project/messages:send');const body=JSON.parse(options.body);assert.deepEqual(Object.keys(body.message.data).sort(),['epoch','id','serverId','type']);assert.ok(!JSON.stringify(body).includes('TOP SECRET'));delivery++;return new Response('{}');}});
 await p.send({id:1,type:'job_result',epoch:'epoch',serverId:'server',text:'TOP SECRET'});await p.send({id:2,type:'approval',epoch:'epoch',serverId:'server'});assert.equal(oauth,1);assert.equal(delivery,2);
});
test('mobile/discovery: user opt-in controls only metadata advertisement; loopback-only bridges are never advertised',async()=>{
 const {createDiscovery}=await import('../src/mobile/discovery.js');let starts=0,stops=0;const fake=()=>({publish:()=>{starts++;return{stop(){stops++;},on(){}}},destroy(){}});
 const d=createDiscovery({host:'0.0.0.0',port:8787,serverId:'fixture',factory:fake});assert.equal(d.status().enabled,false);await d.start();assert.equal(starts,0);await d.set(true);assert.equal(d.status().advertising,true);await d.set(false);assert.equal(stops,1);
 const loop=createDiscovery({host:'127.0.0.1',factory:fake});await assert.rejects(loop.set(true),/loopback/);
});
