const json=(res,status,body)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));};
module.exports=async(req,res)=>{
 if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
 const base=(process.env.SUPABASE_URL||process.env.VITE_SUPABASE_URL||'').replace(/\/$/,'');
 const secret=process.env.SUPABASE_SERVICE_ROLE_KEY,anon=process.env.SUPABASE_ANON_KEY||process.env.VITE_SUPABASE_ANON_KEY;
 const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
 if(!base||!secret||!anon)return json(res,500,{error:'Receipt service is not configured.'});
 if(!token)return json(res,401,{error:'Sign in to download this receipt.'});
 try{
  const auth=await fetch(base+'/auth/v1/user',{headers:{apikey:anon,Authorization:'Bearer '+token}});
  if(!auth.ok)return json(res,401,{error:'Your session has expired.'});
  const user=await auth.json();
  const r=await fetch(base+'/rest/v1/payment_receipts?id=eq.'+encodeURIComponent(req.query.id||'')+'&select=*',{headers:{apikey:secret,Authorization:'Bearer '+secret}});
  if(!r.ok)throw new Error('Could not load receipt');
  const rows=await r.json(),receipt=rows[0];
  if(!receipt||receipt.player_id!==user.id)return json(res,404,{error:'Receipt not found.'});
  const lines=['OFFICIAL PAYMENT RECEIPT','Receipt No: '+receipt.receipt_number,'Date paid: '+new Date(receipt.paid_at).toLocaleString('en-PH',{timeZone:'Asia/Manila'}),'Player: '+receipt.player_name,'Description: '+receipt.description,'Booking reference: '+receipt.reference,'Payment method: '+(receipt.payment_method||'GCash'),'Amount paid: PHP '+Number(receipt.amount).toFixed(2),'','Thank you for booking with Courtly.','https://courtlyph.com'];
  const esc=s=>String(s??'').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)').replace(/[^\x20-\x7E]/g,'?');
  const cmd=['BT','/F1 18 Tf','50 790 Td','(COURTLY) Tj','/F1 10 Tf','0 -28 Td'];
  lines.forEach((line,i)=>{if(i)cmd.push('0 -18 Td');cmd.push('('+esc(line)+') Tj');});cmd.push('ET');
  const stream=cmd.join('\n'),objs=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length '+Buffer.byteLength(stream)+' >>\nstream\n'+stream+'\nendstream'];
  let pdf='%PDF-1.4\n',offsets=[0];for(let i=0;i<objs.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=(i+1)+' 0 obj\n'+objs[i]+'\nendobj\n';}const xref=Buffer.byteLength(pdf);pdf+='xref\n0 '+(objs.length+1)+'\n0000000000 65535 f \n';for(let i=1;i<offsets.length;i++)pdf+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';pdf+='trailer\n<< /Size '+(objs.length+1)+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';
  res.statusCode=200;res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition','attachment; filename="'+receipt.receipt_number+'.pdf"');res.end(Buffer.from(pdf));
 }catch(e){console.error(e);return json(res,500,{error:'Could not download this receipt.'});}
};
