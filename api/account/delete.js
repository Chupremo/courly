const { Buffer } = require('node:buffer');
const { createClient } = require('@supabase/supabase-js');
const { createBackend, ServiceError, json, fail } = require('../../server/courtly-backend.cjs');

function createHandler(dependencies = {}) {
  return async function deleteAccount(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return json(res, 405, { error: 'Method not allowed.' });
    }
    const env = dependencies.env || process.env;
    try {
      let body = {};
      try { body = Buffer.isBuffer(req.body) || typeof req.body === 'string' ? JSON.parse(String(req.body)) : (req.body || {}); } catch {}
      if (body.confirmation !== 'DELETE') throw new ServiceError(400, 'CONFIRMATION_REQUIRED', 'Type DELETE to confirm permanent account deletion.');
      const backend = dependencies.backend || createBackend({ env, fetchImpl: dependencies.fetchImpl });
      const actor = await backend.authenticate(req);
      const profiles = await backend.rest(`player_profiles?id=eq.${actor.id}&select=id,avatar_url`);
      if (!profiles?.[0]) throw new ServiceError(409, 'PLAYER_ACCOUNT_REQUIRED', 'Only player accounts can be deleted from this screen.');

      const base = String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
      const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
      const admin = dependencies.admin || createClient(base, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false }
      });

      const avatarPath = String(profiles[0].avatar_url || '');
      if (avatarPath && !/^https?:\/\//i.test(avatarPath)) {
        const { error: avatarError } = await admin.storage.from('courtly-player-avatars').remove([avatarPath]);
        if (avatarError && !/not found/i.test(avatarError.message || '')) throw avatarError;
      }

      await backend.rpc('courtly_prepare_player_account_deletion', { p_user_id: actor.id });
      const { error: deleteError } = await admin.auth.admin.deleteUser(actor.id);
      if (deleteError) throw deleteError;

      return json(res, 200, { success: true });
    } catch (error) {
      return fail(res, error, 'Courtly player account deletion failed');
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
