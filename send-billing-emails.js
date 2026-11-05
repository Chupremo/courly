const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const authorization = req.headers.authorization || '';
  if (!secret || authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized cron request' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.COURTLY_FROM_EMAIL;

  if (!supabaseUrl || !serviceKey) {
    return res.status(503).json({ error: 'Missing server-side Supabase configuration' });
  }
  if (!resendKey || !fromEmail) {
    return res.status(200).json({ skipped: true, reason: 'Email delivery is not configured. Invoices and reminders remain available in the Owner Portal.' });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { error: queueError } = await supabase.rpc('queue_courtly_billing_email_notices');
  if (queueError) return res.status(500).json({ error: `Could not queue billing emails: ${queueError.message}` });

  const { data: events, error: readError } = await supabase
    .from('courtly_billing_email_events')
    .select('id,recipient_email,subject,html_body')
    .eq('status', 'queued')
    .lte('send_after', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(50);

  if (readError) return res.status(500).json({ error: `Could not read billing email queue: ${readError.message}` });

  let sent = 0;
  let failed = 0;
  for (const event of events || []) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: fromEmail,
          to: [event.recipient_email],
          subject: event.subject,
          html: event.html_body
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || `Resend returned HTTP ${response.status}`);
      await supabase.from('courtly_billing_email_events')
        .update({ status: 'sent', sent_at: new Date().toISOString(), last_error: null })
        .eq('id', event.id);
      sent += 1;
    } catch (error) {
      await supabase.from('courtly_billing_email_events')
        .update({ status: 'failed', last_error: String(error.message || error).slice(0, 1000) })
        .eq('id', event.id);
      failed += 1;
    }
  }

  return res.status(200).json({ queued: (events || []).length, sent, failed });
};
