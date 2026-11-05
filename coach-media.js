import { Upload } from 'tus-js-client';
import { supabase } from './supabase-client.js';

export const COACH_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
export const COACH_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function validateCoachImage(file) {
  if (!file) throw new Error('Choose an image first.');
  if (!COACH_IMAGE_TYPES.includes(file.type)) throw new Error('Use a JPG, PNG or WEBP image.');
  if (file.size > COACH_MEDIA_MAX_BYTES) throw new Error('Coach photos must be 100 MB or smaller.');
  return true;
}

export async function uploadCoachImage(file, userId, folder, onProgress = () => {}) {
  validateCoachImage(file);
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!session?.access_token || session.user.id !== userId) throw new Error('Your coach session expired. Please sign in again.');
  const projectUrl = String(import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
  const apiKey = import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
  if (!projectUrl) throw new Error('Supabase URL is not configured.');
  const projectRef = new URL(projectUrl).hostname.split('.')[0];
  const endpoint = `https://${projectRef}.storage.supabase.co/storage/v1/upload/resumable`;
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${userId}/${folder}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
  await new Promise((resolve, reject) => {
    const upload = new Upload(file, {
      endpoint,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: { authorization: `Bearer ${session.access_token}`, ...(apiKey ? { apikey: apiKey } : {}) },
      metadata: { bucketName: 'courtly-coach-media', objectName: path, contentType: file.type, cacheControl: '3600' },
      chunkSize: 6 * 1024 * 1024,
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      onError: error => reject(new Error(`Photo upload failed: ${error.message || error}`)),
      onProgress: (uploaded, total) => onProgress(Math.round(uploaded / total * 100)),
      onSuccess: resolve
    });
    upload.findPreviousUploads().then(previous => { if (previous.length) upload.resumeFromPreviousUpload(previous[0]); upload.start(); }).catch(reject);
  });
  return path;
}

export function coachMediaUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return supabase.storage.from('courtly-coach-media').getPublicUrl(path).data.publicUrl;
}
