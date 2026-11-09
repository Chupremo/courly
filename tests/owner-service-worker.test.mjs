import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('../public/service-worker.js',import.meta.url),'utf8');
test('the built worker receives owner push, badges the app and wakes the open portal',async()=>{
 const handlers={},shown=[],badges=[],messages=[];let navigated;
 const client={url:'https://www.courtlyph.com/owner-portal',postMessage:x=>messages.push(x),navigate:async x=>{navigated=x;},focus:()=>true};
 const self={location:{origin:'https://www.courtlyph.com'},addEventListener:(n,fn)=>handlers[n]=fn,navigator:{setAppBadge:async x=>badges.push(x)},registration:{showNotification:async(...args)=>shown.push(args)},clients:{matchAll:async()=>[client]}};
 vm.runInNewContext(source,{self,URL,console});
 let done;const data={title:'New court reservation',body:'A player booked your court.',url:'/owner-portal.html?view=bookings',badge:2,tag:'courtly-test'};
 handlers.push({data:{json:()=>data},waitUntil:p=>done=p});await done;
 assert.deepEqual(badges,[2]);assert.equal(shown[0][0],data.title);assert.equal(shown[0][1].data.url,data.url);assert.equal(messages[0].type,'courtly-notification');
 handlers.notificationclick({notification:{close(){},data:{url:data.url}},waitUntil:p=>done=p});await done;assert.equal(navigated,data.url);
});
test('scripts use the latest network response and only use cached code while offline',async()=>{
 const handlers={};let offline=false,stored=0;
 const cached={version:'old'},fresh={version:'new',ok:true,clone(){return this;}};
 const self={location:{origin:'https://www.courtlyph.com'},addEventListener:(n,fn)=>handlers[n]=fn};
 vm.runInNewContext(source,{self,URL,console,caches:{match:async()=>cached,open:async()=>({put:async()=>{stored++;}})},fetch:async()=>{if(offline)throw Error('offline');return fresh;}});
 const request={method:'GET',url:'https://www.courtlyph.com/assets/owner.js',destination:'script'};
 let result;const jobs=[];handlers.fetch({request,respondWith:p=>result=p,waitUntil:p=>jobs.push(p)});assert.equal(await result,fresh);await Promise.all(jobs);assert.equal(stored,1);
 offline=true;handlers.fetch({request,respondWith:p=>result=p,waitUntil:p=>jobs.push(p)});assert.equal(await result,cached);
});
test('root and public workers stay identical so Vite cannot ship a worker without push support',()=>{
 assert.equal(source,readFileSync(new URL('../service-worker.js',import.meta.url),'utf8'));
});
