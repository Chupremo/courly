-- COURTLY: sync missing player profile fields from Auth metadata for existing players.
-- Safe and additive. Existing non-empty profile values are preserved.
begin;

insert into public.player_profiles (
  id, full_name, player_name, email, phone, skill_level, is_private
)
select
  u.id,
  coalesce(nullif(trim(u.raw_user_meta_data->>'full_name'), ''), ''),
  coalesce(nullif(trim(u.raw_user_meta_data->>'player_name'), ''), nullif(trim(u.raw_user_meta_data->>'full_name'), ''), ''),
  coalesce(lower(u.email), ''),
  nullif(trim(u.raw_user_meta_data->>'phone'), ''),
  case when u.raw_user_meta_data->>'skill_level' in ('Beginner','Intermediate','Advanced','Professional')
       then u.raw_user_meta_data->>'skill_level' else 'Beginner' end,
  (u.raw_user_meta_data->>'is_private' = 'true')
from auth.users u
where u.raw_user_meta_data->>'account_type' = 'player'
on conflict (id) do update set
  full_name = case when trim(coalesce(public.player_profiles.full_name,'')) = '' then excluded.full_name else public.player_profiles.full_name end,
  player_name = case when trim(coalesce(public.player_profiles.player_name,'')) = '' then excluded.player_name else public.player_profiles.player_name end,
  email = case when trim(coalesce(public.player_profiles.email,'')) = '' then excluded.email else public.player_profiles.email end,
  phone = coalesce(public.player_profiles.phone, excluded.phone),
  updated_at = now();

commit;
