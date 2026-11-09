import test from 'node:test';
import assert from 'node:assert/strict';
import {bindPushSubscription} from '../push-subscription.js';
function fixture({errors=[],existing=true}={}) {
 const writes=[],removed=[];let account='owner',created=0;
 const subscription=id=>({endpoint:'https://push.example.test/'+id,toJSON:()=>({endpoint:'https://push.example.test/'+id,keys:{p256dh:'public',auth:'secret'}}),unsubscribe:async()=>{removed.push(id);return true;}});
 const client={auth:{getUser:async()=>({data:{user:{id:account}}})},from:()=>({upsert:async row=>{writes.push(row);return {error:errors.shift()};}})};
 return {writes,removed,args:{client,registration:{pushManager:{getSubscription:async()=>existing?subscription('old'):null}},userId:'owner',subscribe:async()=>{created++;return subscription('new-'+created);}},switchAccount:()=>{account='player';},created:()=>created};
}
test('switching player to owner replaces the browser endpoint after an RLS conflict',async()=>{
 const f=fixture({errors:[{code:'42501',message:'USING expression'},null]});
 const result=await bindPushSubscription(f.args);
 assert.deepEqual(f.removed,['old']);assert.equal(result.endpoint,'https://push.example.test/new-1');assert.equal(f.writes.length,2);
 assert.ok(f.writes.every(row=>row.user_id==='owner'));assert.notEqual(f.writes[0].endpoint,f.writes[1].endpoint);
});
test('an already owned endpoint is reused without unsubscribing',async()=>{
 const f=fixture();await bindPushSubscription(f.args);assert.equal(f.writes.length,1);assert.equal(f.created(),0);assert.deepEqual(f.removed,[]);
});
test('a new device is saved once; network errors do not rotate the endpoint',async()=>{
 const f=fixture({existing:false});await bindPushSubscription(f.args);assert.equal(f.created(),1);assert.equal(f.writes.length,1);
 const g=fixture({errors:[{code:'NETWORK_ERROR'}]});await assert.rejects(bindPushSubscription(g.args));assert.deepEqual(g.removed,[]);
});
test('a stale account never writes or unsubscribes another login’s device',async()=>{
 const f=fixture();f.switchAccount();await assert.rejects(bindPushSubscription(f.args),/account changed/);assert.equal(f.writes.length,0);assert.deepEqual(f.removed,[]);
});
test('a persistent permission failure is bounded to one fresh subscription attempt',async()=>{
 const f=fixture({errors:[{code:'42501'},{code:'42501'}]});await assert.rejects(bindPushSubscription(f.args),/could not be saved/);assert.equal(f.writes.length,2);assert.equal(f.created(),1);
});
