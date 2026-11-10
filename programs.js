import { supabase, supabaseConfigError } from './supabase-client.js';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>'₱'+Number(v||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
const media=p=>p?( /^https?:/i.test(p)?p:supabase.storage.from('courtly-coach-media').getPublicUrl(p).data.publicUrl):'';
function card(p){
  const cover=media(p.cover_image_path);
  const start=p.starts_at?new Date(p.starts_at).toLocaleString('en-PH',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}):'Start date to be confirmed';
  const total=Number(p.price_per_enrollee||0)+25;
  return `<article class="coach-list-card">
    <div class="coach-list-cover">${cover?`<img loading="lazy" decoding="async" src="${esc(cover)}" alt="${esc(p.title)}">`:''}<span class="coach-pill" style="position:absolute;top:12px;left:12px">${esc(p.sport||'Program')}</span></div>
    <div class="coach-list-body">
      <h3 style="font:700 17px Poppins;color:#001a47;margin:0 0 6px">${esc(p.title)}</h3>
      <small style="color:#63718a">By ${esc(p.coach_name)}${p.is_verified?' · Verified coach':''}</small>
      <p class="coach-list-bio">${esc((p.description||'Structured coaching program.').slice(0,150))}</p>
      <div class="coach-list-details">
        <span>Total program<strong>${Number(p.total_hours||0)} hours</strong></span>
        <span>Available spots<strong>${Number(p.spots_remaining||0)}</strong></span>
      </div>
      <div class="coach-note" style="margin-top:12px">${esc(p.city||p.location_text||'Location to be confirmed')} · ${esc(start)}</div>
      <div class="coach-summary" style="margin-top:14px">
        <div class="coach-summary-row"><span>Program price</span><strong>${money(p.price_per_enrollee)}</strong></div>
        <div class="coach-summary-row"><span>Convenience Fee</span><strong>₱25.00</strong></div>
        <div class="coach-summary-row total"><span>Total per enrollee</span><strong>${money(total)}</strong></div>
      </div>
      <div class="coach-list-actions" style="margin-top:14px">
        <a class="coach-btn outline" href="/coach/${encodeURIComponent(p.coach_slug)}">View coach</a>
        <a class="coach-btn lime" href="/coach-booking.html?coach=${encodeURIComponent(p.coach_slug)}&program=${encodeURIComponent(p.program_id)}">Enroll</a>
      </div>
    </div>
  </article>`;
}
async function load(){
  if(!supabase){$('programResults').innerHTML='<div class="coach-empty">'+esc(supabaseConfigError)+'</div>';return;}
  const {data,error}=await supabase.rpc('browse_coach_programs',{
    p_search:$('programSearch').value.trim()||null,
    p_sport:$('programSport').value||null,
    p_city:$('programCity').value.trim()||null,
    p_limit:100,p_offset:0
  });
  if(error)throw error;
  const rows=data||[];
  $('programResults').innerHTML=rows.length?rows.map(card).join(''):'<div class="coach-empty" style="grid-column:1/-1"><strong>No programs found</strong><p>Published coach programs will appear here automatically.</p></div>';
}
function showError(error){
  $('programMessage').textContent=error.message||'Unable to load coaching programs.';
  $('programResults').innerHTML='<div class="coach-empty" style="grid-column:1/-1">We could not load coaching programs. Please refresh the page.</div>';
}
$('programFilters').addEventListener('submit',event=>{event.preventDefault();load().catch(showError)});
let timer;
$('programSearch').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>load().catch(showError),250)});
load().catch(showError);
