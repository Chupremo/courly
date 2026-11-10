import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../owner-portal.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('async function setVenueCurrentLocation(){'),html.indexOf('\nfunction billingPage'));
function setup(geolocation){
 const nodes=Object.fromEntries(['venueGeoStatus','venueGeoButton','vLatitude','vLongitude','vName','vOwner','vEmail','vPhone','vLocation','vCity','vSport','vDescription','vSlug'].map(id=>[id,{value:id.startsWith('vLati')||id==='vLongitude'?'':'sample',textContent:'',disabled:false}]));
 const db={venue:{latitude:14,longitude:121,slugLocked:true}};let saved=0;const messages=[];
 const context={$:id=>nodes[id],navigator:{geolocation},db,ownerBusy:false,toast:m=>messages.push(m),document:{querySelectorAll:()=>[]},structuredClone,ownerAction:fn=>fn(),persist:async()=>{saved++;},render(){},ACTIVE_DEMO:false};
 vm.createContext(context);vm.runInContext(source,context);
 return {nodes,db,messages,context,saved:()=>saved};
}
test('denied permission explains alternatives and preserves saved location',async()=>{
 const a=setup({getCurrentPosition(_ok,fail){fail({code:1});}});
 await a.context.setVenueCurrentLocation();
 assert.match(a.nodes.venueGeoStatus.textContent,/Website Settings/);
 assert.match(a.nodes.venueGeoStatus.textContent,/enter coordinates/);
 assert.equal(a.db.venue.latitude,14);assert.equal(a.nodes.venueGeoButton.disabled,false);
});
test('GPS fills editable fields without changing saved venue until submission',async()=>{
 const a=setup({getCurrentPosition(ok){ok({coords:{latitude:13.94112345,longitude:121.16312345}});}});
 await a.context.setVenueCurrentLocation();
 assert.equal(a.nodes.vLatitude.value,13.941123);assert.equal(a.db.venue.latitude,14);
});
test('blank coordinates save city-only location without creating zero coordinates',async()=>{
 const a=setup();await a.context.saveVenue({preventDefault(){}});
 assert.equal(a.db.venue.latitude,null);assert.equal(a.db.venue.longitude,null);assert.equal(a.saved(),1);
});
test('partial and invalid coordinates do not save',async()=>{
 for(const pair of [['14',''],['91','121'],['14','181'],['NaN','121']]){
 const a=setup();[a.nodes.vLatitude.value,a.nodes.vLongitude.value]=pair;
 await a.context.saveVenue({preventDefault(){}});assert.equal(a.saved(),0);assert.match(a.messages[0],/both valid coordinates/);
 }
});
test('manual coordinates save even when geolocation is unavailable',async()=>{
 const a=setup();a.nodes.vLatitude.value='13.9411';a.nodes.vLongitude.value='121.1631';
 await a.context.saveVenue({preventDefault(){}});assert.equal(a.db.venue.latitude,13.9411);assert.equal(a.db.venue.longitude,121.1631);assert.equal(a.saved(),1);
});
