import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../player-dashboard.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('function playerUiIcon('),source.indexOf('function playerCardMarkup('));
function setup({rows=[],venues=[],sport='Pickleball',locals=[]}={}) {
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',handlers:{},addEventListener(event,fn){this.handlers[event]=fn;}});return nodes.get(id);};
 const root={innerHTML:'',querySelectorAll(){return [];}};const visits=[];
 const context=vm.createContext({Date,Set,URL,root,$:node,profile:{preferred_sport:sport},selectedSport:sport,user:{id:'player'},playerDisplayName:()=>'<Bonn>',esc:x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),venues,nearbyCourts:locals,nearbyVenueRows:[],nearbyVenueLocation:null,nearbyVenueCard:()=>'',playerHomePosts:[],profileAvatarUrl:'',normalizeBookings:()=>rows,bookingCard:r=>`<article>BOOKING:${r.id}</article>`,venueCard:v=>`<article>VENUE:${v.id}</article>`,avatarMarkup:()=>'',playerHomePostCard:()=>'',notificationPermissionCard:()=>'',renderPlayerNotifications(){},history:{pushState(...args){visits.push(args);}},window:{scrollTo(){}},render(){},submitPlayerHomePost(){},openSportModal(){},selectSport(){},deletePlayerHomePost(){}});
 vm.runInContext(code,context);return {context,node,root,visits,run:expression=>vm.runInContext(expression,context)};
}
test('next game uses real future bookings and excludes cancelled/rejected games',()=>{
 const now=Date.now(),app=setup({rows:[{id:'cancelled',starts_at:new Date(now+1000).toISOString(),status:'cancelled'},{id:'later',starts_at:new Date(now+7200000).toISOString()},{id:'next',starts_at:new Date(now+3600000).toISOString()},{id:'past',starts_at:new Date(now-3600000).toISOString()}]});
 app.run('renderHome()');assert.match(app.root.innerHTML,/BOOKING:next/);assert.doesNotMatch(app.root.innerHTML,/BOOKING:cancelled|BOOKING:later|BOOKING:past/);
});
test('news is removed while posts and the escaped player name remain',()=>{
 const app=setup();app.run('renderHome()');assert.doesNotMatch(app.root.innerHTML,/sportsNewsSection|Philippine Sports News/);assert.match(app.root.innerHTML,/playerHomeFeed/);assert.match(app.root.innerHTML,/&lt;Bonn&gt;/);assert.doesNotMatch(app.root.innerHTML,/<Bonn>/);
});
test('home search passes query and selected sport to Discover',()=>{
 const app=setup();app.run('renderHome()');app.node('homeVenueQuery').value='  Lipa  ';app.node('homeVenueSearch').handlers.submit({preventDefault(){}});assert.equal(app.run('discoverSearch'),'Lipa');assert.equal(app.run('discoverSport'),'Pickleball');assert.equal(app.run('view'),'discover');assert.equal(app.visits[0][2],'/player-dashboard.html?view=discover');
});
test('venue recommendations follow the chosen sport without inventing nearby distances',()=>{
 const app=setup({venues:[{id:'pickleball',courts:[{sport:'Pickleball',is_active:true}]},{id:'basketball',courts:[{sport:'Basketball',is_active:true}]}]});const html=app.run('homeCourtsSection()');assert.match(html,/VENUE:pickleball/);assert.doesNotMatch(html,/VENUE:basketball|km away/);
});
test('external local courts remain distinguished from Courtly bookings',()=>{
 const app=setup({locals:[{name:'Local court',city:'Lipa',sport:'Pickleball',image:'https://example.com/image.jpg',courtCount:'Indoor courts',url:'https://example.com/'}]});const html=app.run('homeCourtsSection()');assert.match(html,/Book directly/);assert.match(html,/rel="noopener noreferrer"/);assert.match(html,/object-fit:contain/);
});
test('booking periods include ongoing games and exclude rejected payments',()=>{
 const app=setup();app.context.row={starts_at:'2026-11-09T09:00:00+08:00',ends_at:'2026-11-09T11:00:00+08:00'};assert.equal(app.run("isUpcomingBooking(row,Date.parse('2026-11-09T10:00:00+08:00'))"),true);app.context.row.payment_status='rejected';assert.equal(app.run("isUpcomingBooking(row,Date.parse('2026-11-09T10:00:00+08:00'))"),false);
});
