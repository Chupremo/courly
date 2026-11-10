// A browser subscription belongs to one signed-in account. RLS deliberately
// prevents an upsert from taking another account's existing endpoint.
export async function bindPushSubscription({ client, registration, userId, subscribe, userAgent = '' }) {
  const assertAccount = async () => {
    const { data, error } = await client.auth.getUser();
    if (error || !userId || data?.user?.id !== userId) throw new Error('Your account changed. Sign in again before enabling notifications.');
  };
  const save = async subscription => {
    await assertAccount();
    const json = subscription?.toJSON?.();
    if (!json?.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error('This phone could not register for notifications. Please try again.');
    return client.from('push_subscriptions').upsert({
      user_id: userId, endpoint: json.endpoint, p256dh: json.keys.p256dh,
      auth_secret: json.keys.auth, user_agent: userAgent, updated_at: new Date().toISOString()
    }, { onConflict: 'endpoint' });
  };
  await assertAccount();
  let subscription = await registration.pushManager.getSubscription();
  const reused = Boolean(subscription);
  subscription ||= await subscribe();
  let { error } = await save(subscription);
  if (!error) return subscription;
  const conflict = error.code === '42501' || error.code === '23505' || /row.level security/i.test(error.message || '');
  if (!reused || !conflict) throw error;
  await assertAccount();
  // Invalidate only this browser's old endpoint. Never change the old
  // database row's owner or broaden access to other users' subscriptions.
  const previousEndpoint = subscription.endpoint || subscription.toJSON().endpoint;
  if (!await subscription.unsubscribe()) throw new Error('Could not reset this phone’s notifications. Close and reopen Courtly, then try again.');
  subscription = await subscribe();
  if ((subscription.endpoint || subscription.toJSON().endpoint) === previousEndpoint) throw new Error('Please close and reopen Courtly to reconnect notifications to this account.');
  ({ error } = await save(subscription));
  if (error) throw new Error('Notifications could not be saved for this account. Please sign in again and retry.');
  return subscription;
}
