// Dynamic Open Graph landing page for Courtly activity shares.
const env=(key,fallback='')=>process.env[key]||fallback;
const htmlEscape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
module.exports=async(req,res)=>{
  const id=String(req.query?.id||'').trim();
  if(!/^[0-9a-f-]{36}$/i.test(id)){
    res.statusCode=400;res.setHeader('Content-Type','text/plain; charset=utf-8');return res.end('Missing or invalid activity ID.');
  }
  const base=env('SUPABASE_URL',env('VITE_SUPABASE_URL','')).replace(/\/$/,'');
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!base||!key){res.statusCode=503;res.setHeader('Content-Type','text/plain; charset=utf-8');return res.end('Courtly activity sharing is temporarily unavailable.');}
  try{
    const url=base+'/rest/v1/community_events?select=id,title,sport,event_type,starts_at,duration_minutes,location_name,address,city,description,banner_url,status,venues(name,city),courts(name)&id=eq.'+encodeURIComponent(id)+'&limit=1';
    const response=await fetch(url,{headers:{apikey:key,Authorization:'Bearer '+key}});
    if(!response.ok)throw new Error('Activity lookup failed.');
    const rows=await response.json(),event=rows?.[0];
    if(!event||event.status!=='published'){
      res.statusCode=404;res.setHeader('Content-Type','text/plain; charset=utf-8');return res.end('This Courtly activity is not available.');
    }
    const title=event.title+' | Courtly Activities & Games';
    const place=[event.venues?.name,event.courts?.name,event.city||event.venues?.city].filter(Boolean).join(' · ');
    const description=(event.description||('Join '+event.sport+' players at '+(place||event.location_name)+'.')).slice(0,240);
    const image=event.banner_url||'https://www.courtlyph.com/assets/courtly-logo.png';
    const page='https://www.courtlyph.com/community-event.html?id='+encodeURIComponent(id);
    const share='https://www.courtlyph.com/api/community-event-share?id='+encodeURIComponent(id);
    const output='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
      '<title>'+htmlEscape(title)+'</title><meta name="description" content="'+htmlEscape(description)+'">'+
      '<link rel="canonical" href="'+htmlEscape(page)+'">'+
      '<meta property="og:type" content="website"><meta property="og:site_name" content="Courtly">'+
      '<meta property="og:title" content="'+htmlEscape(title)+'"><meta property="og:description" content="'+htmlEscape(description)+'">'+
      '<meta property="og:url" content="'+htmlEscape(share)+'"><meta property="og:image" content="'+htmlEscape(image)+'">'+
      '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="1500">'+
      '<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="'+htmlEscape(title)+'">'+
      '<meta name="twitter:description" content="'+htmlEscape(description)+'"><meta name="twitter:image" content="'+htmlEscape(image)+'">'+
      '<meta http-equiv="refresh" content="0;url='+htmlEscape(page)+'"></head><body style="font-family:Arial,sans-serif;padding:32px;color:#071b3c">'+
      '<h1>'+htmlEscape(event.title)+'</h1><p>'+htmlEscape(description)+'</p><p><a href="'+htmlEscape(page)+'">Open activity on Courtly</a></p>'+
      '<script>location.replace('+JSON.stringify(page)+')</script></body></html>';
    res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','public, s-maxage=60, stale-while-revalidate=300');return res.end(output);
  }catch(error){
    console.error('Courtly activity share page error:',error);
    res.statusCode=500;res.setHeader('Content-Type','text/plain; charset=utf-8');return res.end('Could not load this Courtly activity.');
  }
};