// Vercel serverless function: issue a branded receipt after confirmed payment.
const json = (res, status, body) => { res.statusCode=status; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(body)); };
const env = (key, fallback) => process.env[key] || fallback;
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pdfEscape = (v) => String(v ?? '').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)').replace(/[^\x20-\x7E]/g,'?');
function makePdf(lines) {
  const commands = ['BT','/F1 18 Tf','50 790 Td','(COURTLY) Tj','/F1 10 Tf','0 -28 Td'];
  lines.forEach((line,i)=>{ if(i) commands.push('0 -18 Td'); commands.push('('+pdfEscape(line)+') Tj'); });
  commands.push('ET');
  const stream=commands.join('\n');
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length '+Buffer.byteLength(stream,'utf8')+' >>\nstream\n'+stream+'\nendstream'
  ];
  let out='%PDF-1.4\n', offsets=[0];
  for(let i=0;i<objects.length;i++){ offsets.push(Buffer.byteLength(out,'utf8')); out+=(i+1)+' 0 obj\n'+objects[i]+'\nendobj\n'; }
  const xref=Buffer.byteLength(out,'utf8'); out+='xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n';
  for(let i=1;i<offsets.length;i++) out+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';
  out+='trailer\n<< /Size '+(objects.length+1)+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';
  return Buffer.from(out,'utf8');
}
async function rest(path, key, options={}) {
  const base=env('SUPABASE_URL',env('VITE_SUPABASE_URL','')).replace(/\/$/,'');
  const r=await fetch(base+'/rest/v1/'+path,{...options,headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',...(options.headers||{})}});
  const t=await r.text(); if(!r.ok) throw new Error('Supabase request failed ('+r.status+'): '+t.slice(0,300));
  return t?JSON.parse(t):null;
}
module.exports = async (req,res) => {
  if(req.method!=='POST') return json(res,405,{error:'Method not allowed'});
  const base=env('SUPABASE_URL',env('VITE_SUPABASE_URL',''));
  const secret=process.env.SUPABASE_SERVICE_ROLE_KEY, resend=process.env.RESEND_API_KEY;
  const anon=env('SUPABASE_ANON_KEY',env('VITE_SUPABASE_ANON_KEY',''));
  if(!base||!secret||!resend||!anon) return json(res,500,{error:'Receipt service is not fully configured.'});
  const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  if(!token) return json(res,401,{error:'Sign in is required.'});
  try {
    const auth=await fetch(base.replace(/\/$/,'')+'/auth/v1/user',{headers:{apikey:anon,Authorization:'Bearer '+token}});
    if(!auth.ok) return json(res,401,{error:'Your session is invalid. Please sign in again.'});
    const actor=await auth.json();
    const {type,id}=req.body||{};
    if(!['court_booking','coaching_booking'].includes(type)||!id) return json(res,400,{error:'Invalid booking reference.'});
    const table=type==='court_booking'?'bookings':'coaching_bookings';
    const rows=await rest(table+'?id=eq.'+encodeURIComponent(id)+'&select=*',secret);
    const booking=rows?.[0];
    if(!booking) return json(res,404,{error:'Booking not found.'});
    if(booking.payment_status!=='confirmed') return json(res,409,{error:'A receipt is available only after payment is confirmed.'});
    const allowed=type==='court_booking' ? (actor.id===booking.player_id || actor.id===booking.owner_id) : (actor.id===booking.player_id || actor.id===booking.coach_id);
    if(!allowed) return json(res,403,{error:'You are not authorized to issue this receipt.'});
    const playerRows=await rest('player_profiles?id=eq.'+encodeURIComponent(booking.player_id)+'&select=id,email,full_name,player_name',secret);
    const player=playerRows?.[0]||{};
    const email=(type==='court_booking'?(booking.customer_email||player.email):player.email)||'';
    if(!email) return json(res,422,{error:'The player account has no email address.'});
    const ref=type==='court_booking'?booking.reference:booking.booking_reference;
    const amount=Number(type==='court_booking'?booking.total:booking.subtotal);
    const title=type==='court_booking'?'Court booking':'Coaching session';
    const venueRows=type==='court_booking'&&booking.venue_id?await rest('venues?id=eq.'+encodeURIComponent(booking.venue_id)+'&select=name',secret):[];
    const description=type==='court_booking'?'Court reservation at '+(venueRows?.[0]?.name||'Courtly venue'):'Coaching session with '+(booking.coach_name_snapshot||'Courtly coach');
    const existing=await rest('payment_receipts?source_type=eq.'+type+'&source_id=eq.'+encodeURIComponent(id)+'&select=*',secret);
    let receipt=existing?.[0];
    if(!receipt){
      const payload={source_type:type,source_id:id,player_id:booking.player_id,player_email:email,player_name:player.player_name||player.full_name||booking.customer_name||'Courtly Player',description,reference:ref,amount,payment_method:booking.payment_method||'GCash',paid_at:booking.paid_at||booking.confirmed_at||new Date().toISOString()};
      const created=await rest('payment_receipts?on_conflict=source_type,source_id',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify(payload)});
      receipt=created?.[0]|| (await rest('payment_receipts?source_type=eq.'+type+'&source_id=eq.'+encodeURIComponent(id)+'&select=*',secret))?.[0];
    }
    if(!receipt) throw new Error('Could not create or retrieve the receipt record.');
    if(receipt.email_status==='sent') return json(res,200,{success:true,already_sent:true,receipt:{id:receipt.id,receipt_number:receipt.receipt_number}});
    const claimed=await rest('payment_receipts?id=eq.'+encodeURIComponent(receipt.id)+'&email_status=eq.pending',{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({email_status:'processing',email_error:null})});
    if(!claimed?.length) return json(res,200,{success:true,already_processing:true,receipt:{id:receipt.id,receipt_number:receipt.receipt_number}});
    const paid=new Date(receipt.paid_at).toLocaleString('en-PH',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'});
    const lines=['OFFICIAL PAYMENT RECEIPT','Receipt No: '+receipt.receipt_number,'Date paid: '+paid,'Player: '+receipt.player_name,'Description: '+receipt.description,'Booking reference: '+receipt.reference,'Payment method: '+(receipt.payment_method||'GCash'),'Amount paid: PHP '+amount.toFixed(2),'','Thank you for booking with Courtly.','https://courtlyph.com'];
    const pdf=makePdf(lines);
    const logo='https://courtlyph.com/courtly-logo.png';
    const emailResp=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+resend,'Content-Type':'application/json'},body:JSON.stringify({from:env('COURTLY_RECEIPT_FROM','Courtly Receipts <receipts@courtlyph.com>'),to:[email],subject:'Your Courtly payment receipt '+receipt.receipt_number,html:'<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#15213d"><div style="padding:24px;background:#0a1128;text-align:center"><img src="'+logo+'" alt="Courtly" style="max-width:180px;max-height:64px;object-fit:contain"></div><div style="padding:28px"><h2>Payment confirmed</h2><p>Hi '+esc(receipt.player_name)+', your payment has been confirmed. Your official receipt is attached.</p><p><b>Receipt:</b> '+esc(receipt.receipt_number)+'<br><b>Booking:</b> '+esc(receipt.reference)+'<br><b>Description:</b> '+esc(receipt.description)+'<br><b>Amount paid:</b> ₱'+amount.toFixed(2)+'<br><b>Date:</b> '+esc(paid)+'</p><p>Thank you for choosing Courtly.</p><a href="https://courtlyph.com/player-dashboard.html?view=bookings">View your Courtly activity</a></div></div>',attachments:[{filename:receipt.receipt_number+'.pdf',content:pdf.toString('base64')} ]})});
    if(!emailResp.ok){const err=await emailResp.text();await rest('payment_receipts?id=eq.'+receipt.id,{method:'PATCH',body:JSON.stringify({email_status:'failed',email_error:err.slice(0,500)})});return json(res,502,{error:'Receipt was saved, but email delivery failed.'});}
    await rest('payment_receipts?id=eq.'+receipt.id,{method:'PATCH',body:JSON.stringify({email_status:'sent',email_sent_at:new Date().toISOString(),email_error:null})});
    return json(res,200,{success:true,receipt:{id:receipt.id,receipt_number:receipt.receipt_number}});
  } catch(error){console.error('Courtly receipt error:',error);return json(res,500,{error:'Could not issue the receipt. Please retry.'});}
};
