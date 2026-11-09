import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../owner-push.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');
test('owner notification permission is requested in the tap before registration/network awaits',async()=>{
 const order=[];let saved;const button={disabled:false};
 const subscription={toJSON:()=>({endpoint:'https://push.example.test/device',keys:{p256dh:'key',auth:'auth'}})};
 const registration={update:async()=>{},pushManager:{getSubscription:async()=>subscription}};
 const navigator={serviceWorker:{register:async()=>{order.push('worker');return registration;},ready:Promise.resolve(registration)},userAgent:'test'};
 const Notification={permission:'default',requestPermission:()=>{order.push('permission');Notification.permission='granted';return Promise.resolve('granted');}};
 const context={navigator,Notification,console,Uint8Array,document:{getElementById:()=>null},supabase:{from:table=>({upsert:async value=>{saved={table,value};return {};}})}};
 context.window={Notification,PushManager:{},matchMedia:()=>({matches:true})};
 vm.runInNewContext(source+'\nownerId="venue-owner";',context);
 await context.window.courtlyEnableOwnerNotifications(button);
 assert.equal(order[0],'permission');assert.equal(saved.table,'push_subscriptions');assert.equal(saved.value.user_id,'venue-owner');assert.equal(button.disabled,false);
});
