import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../player-dashboard.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function uploadProfileAvatar('),source.indexOf('async function loadPlayerActivity()'));
function setup({uploadError=null,sessionId='player-1'}={}){
 const calls=[],messages=[];const status={textContent:''};const label={setAttribute(){},removeAttribute(){}};const input={files:[{type:'image/jpeg',size:1200}],disabled:false,value:'photo.jpg',closest:()=>label};
 const context=vm.createContext({Date,crypto:{randomUUID:()=> 'unique-photo'},view:'profile',user:{id:'player-1'},profile:{},$:()=>status,notify:m=>messages.push(m),renderProfile(){calls.push('render');},setHeader(){},async resolvePlayerAvatar(){calls.push('signed-url');},supabase:{auth:{getSession:async()=>({data:{session:{user:{id:sessionId}}},error:null})},storage:{from(bucket){return {async upload(path,file,options){calls.push({bucket,path,file,options});return {error:uploadError};}};}},from(){return {update(data){calls.push({update:data});return {eq(){return {select(){return {single:async()=>({data:{avatar_url:data.avatar_url},error:null})};}};}};}}}}});
 vm.runInContext(code,context);context.event={target:input};return {context,input,status,calls,messages,upload:()=>vm.runInContext('uploadProfileAvatar(event)',context)};
}
test('avatar uploads a new owned path without upsert and saves it only after success',async()=>{
 const app=setup();await app.upload();const upload=app.calls.find(c=>c.path);assert.equal(upload.path,'player-1/avatar-unique-photo.jpg');assert.equal(upload.options.upsert,false);assert.equal(upload.bucket,'courtly-player-avatars');assert.ok(app.calls.find(c=>c.update));assert.match(app.status.textContent,/updated/);assert.equal(app.input.disabled,false);
});
test('failed storage upload preserves existing profile and displays the error beside the button',async()=>{
 const app=setup({uploadError:new Error('Upload unavailable')});await app.upload();assert.equal(app.calls.some(c=>c.update),false);assert.equal(app.status.textContent,'Upload unavailable');assert.equal(app.input.disabled,false);assert.equal(app.input.value,'');
});
test('oversized photo is rejected before network access',async()=>{
 const app=setup();app.input.files[0].size=9*1024*1024;await app.upload();assert.equal(app.calls.length,0);assert.match(app.status.textContent,/8 MB/);
});
test('stale session cannot upload to a previous player folder',async()=>{
 const app=setup({sessionId:'different-player'});await app.upload();assert.equal(app.calls.length,0);assert.match(app.status.textContent,/sign in again/);
});
