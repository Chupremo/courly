
/**
 * Ensure a signed-in Courtly player has a complete profile row.
 * Existing user-edited profile fields always take precedence.
 */

const VALID_SKILL_LEVELS = new Set([
  'Beginner',
  'Intermediate',
  'Advanced',
  'Professional'
]);

export async function syncPlayerProfile(supabase, user) {
  if (!supabase || !user?.id) {
    throw new Error(
      'A signed-in Courtly player is required to sync the profile.'
    );
  }

  const metadata = user.user_metadata || {};

  const { data: existing, error: readError } = await supabase
    .from('player_profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();

  if (readError) throw readError;

  const metadataFullName = String(
    metadata.full_name || ''
  ).trim();

  const metadataPlayerName = String(
    metadata.player_name || ''
  ).trim();

  const existingFullName = String(
    existing?.full_name || ''
  ).trim();

  const existingPlayerName = String(
    existing?.player_name || ''
  ).trim();

  const skillCandidate =
    existing?.skill_level ||
    metadata.skill_level ||
    'Beginner';

  const profileRecord = {
    id: user.id,

    full_name:
      existingFullName || metadataFullName,

    player_name:
      existingPlayerName ||
      metadataPlayerName ||
      existingFullName ||
      metadataFullName,

    email: String(
      user.email || existing?.email || ''
    ).trim().toLowerCase(),

    phone:
      existing?.phone ||
      metadata.phone ||
      null,

    skill_level: VALID_SKILL_LEVELS.has(skillCandidate)
      ? skillCandidate
      : 'Beginner',

    is_private:
      existing?.is_private ??
      Boolean(metadata.is_private),

    avatar_url:
      existing?.avatar_url || null,

    preferred_sport:
      existing?.preferred_sport ||
      metadata.preferred_sport ||
      null,

    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('player_profiles')
    .upsert(profileRecord, {
      onConflict: 'id'
    })
    .select('*')
    .single();

  if (error) throw error;

  return data;
}

export function playerDisplayName(profile, user) {
  return String(
    profile?.player_name ||
    profile?.full_name ||
    user?.user_metadata?.player_name ||
    user?.user_metadata?.full_name ||
    user?.email?.split('@')[0] ||
    'Player'
  ).trim() || 'Player';
}
