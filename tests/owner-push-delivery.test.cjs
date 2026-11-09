const test=require('node:test');
const assert=require('node:assert/strict');
const {createECDH,createDecipheriv,hkdfSync}=require('node:crypto');
const {pushBookingNotifications}=require('../server/courtly-web-push.cjs');
const {createHandler}=require('../api/notifications/process.js');
const key=createECDH('prime256v1');key.generateKeys();
const receiver=createECDH('prime256v1');receiver.generateKeys();
const notifications=[{id:'new',recipient_user_id:'owner',audience:'owner',type:'new_booking'},{id:'review',recipient_user_id:'owner',audience:'owner',type:'payment_review'}];
function harness({subscribed=true,providerStatus=201}={}){
 const calls=[],requests=[];
 return {calls,requests,backend:{
  rpc:async name=>{assert.equal(name,'courtly_get_vapid_private_key');return key.getPrivateKey().toString('base64url');},
  rest:async(path,options)=>{calls.push({path,options});if(options)return [];
   if(path.startsWith('push_subscriptions')){assert.match(path,/user_id=eq.owner/);return subscribed?[{id:'device',endpoint:'https://push.example.test/send',p256dh:receiver.getPublicKey().toString('base64url'),auth_secret:Buffer.alloc(16,7).toString('base64url')}]:[];}
   return path.includes('booking_id=')?notifications:[{id:'new'},{id:'review'}];
  }},fetchImpl:async(url,options)=>{requests.push({url,options});return {ok:providerStatus===201,status:providerStatus};}};
}
test('a pending booking sends new-booking and payment-review alerts to owner devices',async()=>{
 const h=harness();const result=await pushBookingNotifications({...h,source:{type:'court_booking',id:'booking'},sourceRow:{payment_status:'awaiting_verification'}});
 assert.equal(result.sent,2);assert.equal(h.requests.length,2);assert.equal(h.calls.filter(x=>x.options?.method==='PATCH').length,2);
 assert.match(h.requests[0].options.headers.Authorization,/^vapid t=/);assert.ok(h.requests[0].options.body.length>100);
 // Independently decrypt using RFC 8291 HKDF. A push service accepting bytes
 // does not prove that the phone can decrypt and display the notification.
 const body=h.requests[0].options.body,salt=body.subarray(0,16),publicLength=body[20],serverPublic=body.subarray(21,21+publicLength);
 const shared=receiver.computeSecret(serverPublic);
 const keyInfo=Buffer.concat([Buffer.from('WebPush: info\0'),receiver.getPublicKey(),serverPublic]);
 const ikm=Buffer.from(hkdfSync('sha256',shared,Buffer.alloc(16,7),keyInfo,32));
 const cek=Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16));
 const nonce=Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12));
 const ciphertext=body.subarray(21+publicLength);const decipher=createDecipheriv('aes-128-gcm',cek,nonce);decipher.setAuthTag(ciphertext.subarray(-16));
 const plain=Buffer.concat([decipher.update(ciphertext.subarray(0,-16)),decipher.final()]);assert.equal(plain.at(-1),2);
 const payload=JSON.parse(plain.subarray(0,-1));assert.equal(payload.url,'/owner-portal.html?view=bookings');assert.equal(payload.badge,2);

});
test('no device or failed delivery leaves the alert available for retry',async()=>{
 for(const options of [{subscribed:false},{providerStatus:503}]){const h=harness(options);await pushBookingNotifications({...h,source:{type:'court_booking',id:'booking'},sourceRow:{}});assert.equal(h.calls.filter(x=>x.options?.method==='PATCH').length,0);}
});
test('expired device endpoints are removed',async()=>{
 const h=harness({providerStatus:410});await pushBookingNotifications({...h,source:{type:'court_booking',id:'booking'},sourceRow:{}});assert.equal(h.calls.filter(x=>x.options?.method==='DELETE').length,2);
});
test('phone push runs after source authorization and before paused email delivery',async()=>{
 const order=[];let body;const response={setHeader(){},end(value){body=value;}};
 const handler=createHandler({env:{COURTLY_EMAIL_ENABLED:'false'},pushBookingNotifications:async()=>{order.push('push');},backend:{
  authenticate:async()=>{order.push('auth');return {id:'player'};},authorizeSource:async()=>{order.push('authorize');return {};},
  readiness:async()=>{order.push('readiness');return {ready:true};},rpc:async()=>null
 }});
 await handler({method:'POST',body:{type:'court_booking',id:'00000000-0000-4000-8000-000000000001'},headers:{}},response);
 assert.deepEqual(order.slice(0,3),['auth','authorize','push']);assert.equal(response.statusCode,503);assert.match(body,/EMAIL_DELIVERY_PAUSED/);
});
