import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigError = (!supabaseUrl || !supabaseAnonKey)
  ? 'Courtly is not connected to Supabase. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your environment.'
  : null;

export const supabase = supabaseConfigError ? null : createClient(
  supabaseUrl.replace(/\/$/, ''),
  supabaseAnonKey,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
);
