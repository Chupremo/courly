import test from 'node:test';
import assert from 'node:assert/strict';
import { watchOwnerWorkspace } from '../owner-live.js';
const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
function harness(load) {
  const events = {}, subscriptions = [], updates = [];
  let status, poll, removed = false, cleared = false;
  const eventTarget = { addEventListener(n,fn){events[n]=fn;}, removeEventListener(n,fn){if(events[n]===fn)delete events[n];} };
  const document = {...eventTarget,visibilityState:'visible'};
  const window = {...eventTarget,navigator:{serviceWorker:eventTarget}};
  const channel = { on(type,filter,fn){subscriptions.push({filter,fn});return this;}, subscribe(fn){status=fn;return this;} };
  const stop = watchOwnerWorkspace({client:{channel:()=>channel,removeChannel:()=>{removed=true;}},userId:'owner',venueId:'venue',load,onUpdate:x=>updates.push(x),document,window,timers:{setInterval(fn){poll=fn;return 1;},clearInterval(){cleared=true;}}});
  return {events,subscriptions,updates,document,stop,status:x=>status(x),poll:()=>poll(),clean:()=>removed&&cleared};
}
test('owner changes are scoped; events during a load trigger a second read without overlap',async()=>{
  let resolve, active=0,max=0,calls=0;
  const h=harness(async()=>{calls++;max=Math.max(max,++active);if(calls===1)await new Promise(r=>resolve=r);active--;return {revision:calls};});
  h.subscriptions[0].fn({new:{id:'alert'}});h.subscriptions[1].fn({new:{id:'booking'}});
  assert.equal(calls,1);resolve();await flush();
  assert.equal(calls,2);assert.equal(max,1);assert.equal(h.updates.at(-1).workspace.revision,2);
  assert.equal(h.subscriptions[0].filter.filter,'recipient_user_id=eq.owner');
  assert.equal(h.subscriptions[1].filter.filter,'venue_id=eq.venue');h.stop();
});
test('resume and reconnect recover missed changes; fallback retries without a socket',async()=>{
  let revision=1;const h=harness(async()=>({revision}));await flush();
  h.document.visibilityState='hidden';revision=2;h.subscriptions[1].fn({});await flush();assert.equal(h.updates.length,1);
  h.document.visibilityState='visible';h.events.visibilitychange();await flush();assert.equal(h.updates.at(-1).workspace.revision,2);
  revision=3;h.status('SUBSCRIBED');await flush();assert.equal(h.updates.at(-1).workspace.revision,3);
  revision=4;h.status('CHANNEL_ERROR');h.poll();await flush();assert.equal(h.updates.at(-1).workspace.revision,4);
  h.stop();assert.ok(h.clean());assert.equal(h.events.visibilitychange,undefined);
});
test('unchanged recovery reads do not redraw the portal and failed loads can retry',async()=>{
  let fail=true;const h=harness(async()=>{if(fail)throw new Error('offline');return {revision:1};});await flush();fail=false;
  h.poll();await flush();assert.equal(h.updates.length,1);h.poll();await flush();assert.equal(h.updates.length,1);h.stop();
});
