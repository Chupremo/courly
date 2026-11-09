const CACHE='courtly-shell-v1';
const SHELL=['/','/offline.html','/courtly-app-icon.svg'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if(request.mode==='navigate'){
    event.respondWith(fetch(request).catch(()=>caches.match('/offline.html')));
    return;
  }
  if(['style','script','image','font'].includes(request.destination)){
    event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{
      if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));}
      return response;
    }).catch(()=>cached)));
  }
});


const COURTLY_PUSH_ICON='/courtly-app-icon.svg';

self.addEventListener('push',event=>{
  let payload={};
  try{payload=event.data?event.data.json():{};}catch{payload={title:'Courtly',body:event.data?.text?.()||'You have a new Courtly notification.'};}
  const title=payload.title||'Courtly';
  const body=payload.body||'You have a new Courtly notification.';
  const badgeCount=Math.max(0,Number(payload.badge||payload.unreadCount||0));
  const url=payload.url||'/player-dashboard.html?view=bookings';
  event.waitUntil((async()=>{
    try{
      if(self.navigator?.setAppBadge){
        if(badgeCount>0)await self.navigator.setAppBadge(badgeCount);
        else if(self.navigator.clearAppBadge)await self.navigator.clearAppBadge();
      }
    }catch{}
    await self.registration.showNotification(title,{
      body,
      icon:COURTLY_PUSH_ICON,
      badge:COURTLY_PUSH_ICON,
      tag:payload.tag||'courtly-notification',
      renotify:true,
      data:{url}
    });
  })());
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const target=event.notification?.data?.url||'/player-dashboard.html?view=bookings';
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of windows){
      try{
        const clientUrl=new URL(client.url);
        if(clientUrl.origin===self.location.origin){
          await client.navigate(target);
          return client.focus();
        }
      }catch{}
    }
    return self.clients.openWindow(target);
  })());
});
