const { createClient } = require('@supabase/supabase-js');

function sendJson(res,status,body){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(body))}
function bodyOf(req){if(req.body&&typeof req.body==='object'&&!Buffer.isBuffer(req.body))return req.body;try{return JSON.parse(String(req.body||'{}'))}catch{return {}}}
function clean(v,max=200){return String(v||'').trim().slice(0,max)}
function allowedOrigin(req){const o=String(req.headers?.origin||'');if(!o)return true;return /^https:\/\/(www\.)?courtlyph\.com$/i.test(o)||/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o)||/^capacitor:\/\/localhost$/i.test(o)}
function bearer(req){const m=String(req.headers?.authorization||'').match(/^Bearer\s+(\S+)$/i);return m?.[1]||''}

module.exports=async function playerSocialProfile(req,res){
  if(req.method!=='POST'){res.setHeader('Allow','POST');return sendJson(res,405,{success:false,error:'Method not allowed.'})}
  if(!allowedOrigin(req))return sendJson(res,403,{success:false,error:'Request origin is not allowed.'});
  const env=process.env; const url=clean(env.SUPABASE_URL||env.VITE_SUPABASE_URL,500).replace(/\/$/,''); const serviceKey=clean(env.SUPABASE_SERVICE_ROLE_KEY,5000); const anonKey=clean(env.SUPABASE_ANON_KEY||env.VITE_SUPABASE_ANON_KEY,5000);
  if(!url||!serviceKey||!anonKey)return sendJson(res,503,{success:false,error:'Profile service is not configured.'});
  const token=bearer(req); if(!token)return sendJson(res,401,{success:false,error:'Please sign in again.'});
  const publicClient=createClient(url,anonKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:userData,error:userError}=await publicClient.auth.getUser(token); const user=userData?.user;
  if(userError||!user?.id)return sendJson(res,401,{success:false,error:'Your session expired. Please sign in again.'});
  const body=bodyOf(req); const fullName=clean(body.full_name,100), playerName=clean(body.player_name,40), email=String(user.email||'').toLowerCase(), skillLevel=clean(body.skill_level,40);
  if(!fullName||!playerName||!['Beginner','Intermediate','Advanced','Professional'].includes(skillLevel))return sendJson(res,400,{success:false,error:'Please complete your required profile details.'});
  const admin=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const provider=String(user.app_metadata?.provider||'');
  if(!provider)return sendJson(res,403,{success:false,error:'This social account could not be verified.'});
  const {error:roleError}=await admin.auth.admin.updateUserById(user.id,{app_metadata:{...(user.app_metadata||{}),account_type:'player'}});
  if(roleError)return sendJson(res,503,{success:false,error:'We could not finish setting up your player account.'});
  const record={id:user.id,full_name:fullName,player_name:playerName,email,phone:clean(body.phone,30)||null,skill_level:skillLevel,is_private:Boolean(body.is_private),preferred_sport:clean(body.preferred_sport,60)||null,public_location:clean(body.public_location,100)||null,avatar_url:clean(body.avatar_url,1000)||clean(user.user_metadata?.avatar_url||user.user_metadata?.picture,1000)||null,updated_at:new Date().toISOString()};
  const {error}=await admin.from('player_profiles').upsert(record,{onConflict:'id'}); if(error)return sendJson(res,503,{success:false,error:'We could not save your player profile.'});
  return sendJson(res,200,{success:true});
};