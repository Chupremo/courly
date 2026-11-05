from pathlib import Path
import re, json
root=Path('/mnt/data/Courtly_Release')

# 1) Global navigation role resolution: recognize existing player profiles even if old metadata is incomplete.
p=root/'courtly-global-nav.js'
s=p.read_text()
old="""  if (type === 'player') {
    const { data: profile } = await supabase.from('player_profiles').select('player_name,full_name').eq('id', user.id).maybeSingle();
    return { role: 'player', displayName: profile?.player_name || profile?.full_name || user.user_metadata?.player_name || user.email?.split('@')[0] || 'Player' };
  }
  if (type === 'venue_owner' || type === 'owner' || type === 'business_owner') {
    const { data: venue } = await supabase.from('venues').select('name,owner_name').eq('owner_id', user.id).order('created_at',{ascending:true}).limit(1).maybeSingle();
    return { role: 'owner', displayName: venue?.owner_name || venue?.name || user.user_metadata?.owner_name || 'Venue owner' };
  }
  const { data: venue } = await supabase.from('venues').select('name,owner_name').eq('owner_id', user.id).order('created_at',{ascending:true}).limit(1).maybeSingle();
  if (venue) return { role: 'owner', displayName: venue.owner_name || venue.name || 'Venue owner' };
  return { role: 'guest', displayName: 'Guest' };
"""
new="""  if (type === 'player') {
    const { data: profile } = await supabase.from('player_profiles').select('player_name,full_name').eq('id', user.id).maybeSingle();
    return { role: 'player', displayName: profile?.player_name || profile?.full_name || user.user_metadata?.player_name || user.email?.split('@')[0] || 'Player' };
  }
  if (type === 'venue_owner' || type === 'owner' || type === 'business_owner') {
    const { data: venue } = await supabase.from('venues').select('name,owner_name').eq('owner_id', user.id).order('created_at',{ascending:true}).limit(1).maybeSingle();
    return { role: 'owner', displayName: venue?.owner_name || venue?.name || user.user_metadata?.owner_name || 'Venue owner' };
  }
  // Older player accounts may have a profile row but incomplete auth metadata.
  const { data: profile } = await supabase.from('player_profiles').select('player_name,full_name').eq('id', user.id).maybeSingle();
  if (profile) return { role: 'player', displayName: profile.player_name || profile.full_name || user.email?.split('@')[0] || 'Player' };
  const { data: venue } = await supabase.from('venues').select('name,owner_name').eq('owner_id', user.id).order('created_at',{ascending:true}).limit(1).maybeSingle();
  if (venue) return { role: 'owner', displayName: venue.owner_name || venue.name || 'Venue owner' };
  return { role: 'guest', displayName: 'Guest' };
"""
if old not in s: raise SystemExit('nav role block not found')
s=s.replace(old,new)
s=s.replace("mount();\nsupabase?.auth.onAuthStateChange(() => { renderHeader().catch(console.warn); });", "mount();")
p.write_text(s)

# 2) Ensure existing player users are recognized by profile row at venue booking gate.
p=root/'venue.html'; s=p.read_text()
s=s.replace("""  if(user?.user_metadata?.account_type==='player')return true;
  const intent={kind,venueSlug:slug,eventId:event?.id||null,date:localDateForSelection(selectedDate),start:selectedStart,end:selectedEnd,courtId:selectedCourtId,createdAt:new Date().toISOString()};
""", """  if(user){
    const {data:playerProfile, error:profileError}=await supabase.from('player_profiles').select('id').eq('id',user.id).maybeSingle();
    if(profileError)throw profileError;
    if(playerProfile)return true;
  }
  const intent={kind,venueSlug:slug,eventId:event?.id||null,date:localDateForSelection(selectedDate),start:selectedStart,end:selectedEnd,courtId:selectedCourtId,createdAt:new Date().toISOString()};
""")
s=s.replace("""  const {data:{user}}=await supabase.auth.getUser();
  if(user?.user_metadata?.account_type!=='player')return;
  sessionStorage.removeItem(PENDING_BOOKING_INTENT_KEY);
""", """  const {data:{user}}=await supabase.auth.getUser();
  if(!user)return;
  const {data:playerProfile,error:profileError}=await supabase.from('player_profiles').select('id').eq('id',user.id).maybeSingle();
  if(profileError)throw profileError;
  if(!playerProfile)return;
  sessionStorage.removeItem(PENDING_BOOKING_INTENT_KEY);
""")
# prefill old player accounts based on profile record rather than just metadata.
s=s.replace("""    if (!user || user.user_metadata?.account_type !== 'player') return;
    const { data: profile, error } = await supabase.from('player_profiles')
""", """    if (!user) return;
    const { data: profile, error } = await supabase.from('player_profiles')
""")
p.write_text(s)

# 3) Add a clear guest browsing message to the public venue directory.
p=root/'players.html'; s=p.read_text()
marker='<main class="wrap">\n<section class="search-panel">'
replacement='''<main class="wrap">
<div class="guest-browse-hint"><strong>Browse freely.</strong> View published venues, active courts, prices and available times without an account. A free player account is required only when you book a court or join Open Play.</div>
<section class="search-panel">'''
if marker not in s: raise SystemExit('players main marker not found')
s=s.replace(marker,replacement,1)
# Add style near .search-panel declaration.
style_marker='.search-panel{background:white;'
style_add='.guest-browse-hint{margin:18px 0 0;padding:12px 15px;border:1px solid #dce8bd;border-radius:12px;background:#f5fbe9;color:#526078;font-size:12px;line-height:1.55}.guest-browse-hint strong{color:#001A47;font-weight:700}\n.search-panel{background:white;'
if style_marker not in s: raise SystemExit('players search css marker not found')
s=s.replace(style_marker,style_add,1)
p.write_text(s)

# 4) Player login should route a signed-in owner to their portal, and legacy player accounts by profile.
p=root/'player-login.html'; s=p.read_text()
old="""if (supabase) {
  supabase.auth.getSession().then(({ data, error }) => {
    if (error) return;
    const currentUser = data?.session?.user;
    if (currentUser?.user_metadata?.account_type === 'player') {
      location.replace(returnTo);
    }
  });
}
"""
new="""if (supabase) {
  supabase.auth.getSession().then(async ({ data, error }) => {
    if (error) return;
    const currentUser = data?.session?.user;
    if (!currentUser) return;
    const { data: profile } = await supabase.from('player_profiles').select('id').eq('id', currentUser.id).maybeSingle();
    if (profile || currentUser.user_metadata?.account_type === 'player') {
      location.replace(returnTo);
      return;
    }
    const { data: ownedVenue } = await supabase.from('venues').select('id').eq('owner_id', currentUser.id).limit(1).maybeSingle();
    if (ownedVenue || ['venue_owner','owner','business_owner'].includes(String(currentUser.user_metadata?.account_type || '').toLowerCase())) {
      location.replace('/owner-portal.html');
    }
  }).catch(error => console.warn('Could not resolve existing Courtly session:', error));
}
"""
if old not in s: raise SystemExit('player-login session redirect block not found')
s=s.replace(old,new)
p.write_text(s)

# 5) Player registration should not show an account-creation form to already signed-in members.
p=root/'player-register.html'; s=p.read_text()
needle="""    const returnTo = safeReturnTo(new URLSearchParams(location.search).get('returnTo'));
    const emailConfirmationRedirect = `${getCourtlyAppUrl()}/player-login.html?confirmed=1&returnTo=${encodeURIComponent(returnTo)}`;
"""
replace="""    const returnTo = safeReturnTo(new URLSearchParams(location.search).get('returnTo'));
    const emailConfirmationRedirect = `${getCourtlyAppUrl()}/player-login.html?confirmed=1&returnTo=${encodeURIComponent(returnTo)}`;
    // Registered users should be routed to their existing workspace, not shown signup again.
    supabase?.auth.getSession().then(async ({data,error})=>{
      if(error || !data?.session?.user) return;
      const activeUser=data.session.user;
      const {data:existingPlayer}=await supabase.from('player_profiles').select('id').eq('id',activeUser.id).maybeSingle();
      if(existingPlayer || activeUser.user_metadata?.account_type==='player'){
        location.replace(returnTo);
        return;
      }
      const {data:ownedVenue}=await supabase.from('venues').select('id').eq('owner_id',activeUser.id).limit(1).maybeSingle();
      if(ownedVenue || ['venue_owner','owner','business_owner'].includes(String(activeUser.user_metadata?.account_type||'').toLowerCase())) location.replace('/owner-portal.html');
    }).catch(error=>console.warn('Could not resolve existing Courtly session:',error));
"""
if needle not in s: raise SystemExit('player-register returnTo block not found')
s=s.replace(needle,replace)
p.write_text(s)

# 6) Community sign-in panel wording is consistent with the dropdown nav.
p=root/'community.html'; s=p.read_text()
s=s.replace('<div class="signin-actions"><a class="community-primary" href="/player-login.html">Player login</a><a class="community-secondary" href="/login.html">Owner login</a></div>', '<div class="signin-actions"><a class="community-primary" href="/player-login.html">Log in as player</a><a class="community-secondary" href="/login.html">Log in as business owner</a></div>')
p.write_text(s)

# 7) Add cache version bump for shared navigation to make sure new role-aware menu is served.
for p in root.glob('*.html'):
    s=p.read_text(errors='ignore')
    if 'courtly-global-nav.js?v=20261105-2' in s:
        p.write_text(s.replace('courtly-global-nav.js?v=20261105-2','courtly-global-nav.js?v=20261105-3'))
    if 'courtly-global-nav.css?v=20261105-2' in s:
        q=p.read_text(errors='ignore')
        p.write_text(q.replace('courtly-global-nav.css?v=20261105-2','courtly-global-nav.css?v=20261105-3'))

print('Applied public navigation, guest browsing, auth return, and session routing updates.')
