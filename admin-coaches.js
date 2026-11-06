import { supabase } from './supabase-client.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
const money = (value) => '₱' + Number(value || 0).toLocaleString('en-PH', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
});
const date = (value) => value
  ? new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' }).format(new Date(value))
  : '—';
const media = (path) => {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return supabase.storage.from('courtly-coach-media').getPublicUrl(path).data.publicUrl || '';
};
let state = null;

function message(text, type = 'error') {
  const box = $('adminMessage');
  box.textContent = text;
  box.className = `notice ${type}`;
  box.classList.remove('hidden');
}
function pill(status) {
  const value = String(status || 'unknown').toLowerCase();
  const allowed = ['paid','approved','active','verified','overdue','rejected','suspended','issued','partially_paid','submitted','pending'];
  const css = allowed.includes(value) ? value : '';
  return `<span class="pill ${css}">${esc(value.replaceAll('_', ' '))}</span>`;
}
function stat(label, value, detail = '') {
  return `<div class="kpi"><small>${esc(label)}</small><strong>${esc(value)}</strong>${detail ? `<div class="muted">${esc(detail)}</div>` : ''}</div>`;
}
function coachCard(coach) {
  const avatar = media(coach.profile_image_path);
  const cover = media(coach.cover_image_path);
  const name = coach.coach_name || 'Courtly Coach';
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  const profileUrl = coach.slug ? `/coach/${encodeURIComponent(coach.slug)}` : '';
  const publishedLabel = coach.is_published ? 'Published' : 'Draft';
  const verificationLabel = coach.is_verified ? 'Verified' : 'Not verified';
  return `
    <article class="coach-market-card">
      <div class="coach-market-cover">${cover ? `<img src="${esc(cover)}" alt="${esc(name)} cover photo" loading="lazy">` : ''}</div>
      <div class="coach-market-body">
        <div class="coach-market-identity">
          ${avatar
            ? `<img class="coach-market-avatar" src="${esc(avatar)}" alt="${esc(name)} profile photo" loading="lazy">`
            : `<div class="coach-market-avatar" aria-label="No profile photo">${esc(initials || 'C')}</div>`}
          <div class="coach-market-name">
            <strong>${esc(name)} ${coach.is_verified ? '<span class="pill verified">Verified</span>' : ''}</strong>
            <small>${esc(coach.sport || 'Sport not set')} · ${esc(coach.city || 'Location not set')}</small>
          </div>
        </div>
        <p class="coach-market-description">${esc(coach.coaching_bio || 'This coach has not added a coaching introduction yet.')}</p>
        <div class="coach-market-meta">
          <span>Hourly coaching rate<strong>${money(coach.hourly_rate)}/hr</strong></span>
          <span>Experience<strong>${Number(coach.experience_years || 0)} years</strong></span>
        </div>
        <div class="coach-market-status">
          ${pill(publishedLabel)}
          ${pill(coach.billing_status || 'billing not set')}
          ${coach.is_verified ? pill('verified') : pill('pending')}
        </div>
        <div class="coach-market-actions">
          ${profileUrl ? `<a class="btn ghost" href="${esc(profileUrl)}" target="_blank" rel="noopener">View profile</a>` : '<span></span>'}
          <button class="btn lime" type="button" data-verify="${esc(coach.id)}" data-value="${!coach.is_verified}">
            ${coach.is_verified ? 'Remove badge' : 'Verify coach'}
          </button>
        </div>
      </div>
    </article>`;
}
function renderRemittances(rows) {
  const host = $('remittanceList');
  if (!rows.length) {
    host.innerHTML = '<div class="empty">No coach remittances submitted yet.</div>';
    return;
  }
  host.innerHTML = `<table class="table"><thead><tr>
    <th>Coach</th><th>Invoice</th><th>Amount</th><th>Method / reference</th><th>Submitted</th><th>Status</th><th>Review</th>
  </tr></thead><tbody>${rows.map((row) => `<tr>
    <td><strong>${esc(row.coach_name || 'Coach')}</strong></td>
    <td>${esc(row.invoice_id || '—')}</td>
    <td>${money(row.amount)}</td>
    <td>${esc(row.payment_method || '—')}<div class="muted">${esc(row.payment_reference || '')}</div></td>
    <td>${date(row.submitted_at)}</td>
    <td>${pill(row.status)}</td>
    <td>${row.status === 'submitted'
      ? `<div class="row"><button class="btn lime" type="button" data-remit="${esc(row.id)}" data-decision="approved">Approve</button><button class="btn ghost" type="button" data-remit="${esc(row.id)}" data-decision="rejected">Reject</button></div>`
      : '—'}</td>
  </tr>`).join('')}</tbody></table>`;
}
function renderInvoices(rows) {
  const host = $('invoiceList');
  if (!rows.length) {
    host.innerHTML = '<div class="empty">No coach invoices have been generated yet.</div>';
    return;
  }
  host.innerHTML = `<table class="table"><thead><tr>
    <th>Invoice</th><th>Coach</th><th>Issued</th><th>Due</th><th>Amount due</th><th>Paid</th><th>Status</th>
  </tr></thead><tbody>${rows.map((invoice) => `<tr>
    <td><strong>${esc(invoice.invoice_number || '—')}</strong></td>
    <td>${esc(invoice.coach_name || 'Coach')}</td>
    <td>${date(invoice.issued_at)}</td>
    <td>${date(invoice.due_at)}</td>
    <td>${money(invoice.amount_due)}</td>
    <td>${money(invoice.amount_paid)}</td>
    <td>${pill(invoice.status)}</td>
  </tr>`).join('')}</tbody></table>`;
}
function render(data) {
  state = data;
  const coaches = data.coaches || [];
  const remittances = data.remittances || [];
  const invoices = data.invoices || [];
  $('summaryGrid').innerHTML = [
    stat('Total coaches', coaches.length),
    stat('Published profiles', coaches.filter((coach) => coach.is_published).length),
    stat('Verified coaches', coaches.filter((coach) => coach.is_verified).length),
    stat('Pending remittances', remittances.filter((row) => row.status === 'submitted').length)
  ].join('');
  $('coachCount').textContent = `${coaches.length} coach profile${coaches.length === 1 ? '' : 's'}`;
  $('coachGrid').innerHTML = coaches.length
    ? coaches.map(coachCard).join('')
    : '<div class="empty" style="grid-column:1/-1">No coach profiles have registered yet.</div>';
  renderRemittances(remittances);
  renderInvoices(invoices);

  $('coachGrid').querySelectorAll('[data-verify]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const verified = button.dataset.value === 'true';
        const { error } = await supabase.rpc('admin_set_coach_verification', {
          p_coach_id: button.dataset.verify,
          p_verified: verified
        });
        if (error) throw error;
        message(verified ? 'Coach verified successfully.' : 'Coach verification badge removed.', 'success');
        await load();
      } catch (error) {
        message(error.message || 'Could not update coach verification.');
      } finally {
        button.disabled = false;
      }
    });
  });

  $('remittanceList').querySelectorAll('[data-remit]').forEach((button) => {
    button.addEventListener('click', async () => {
      const decision = button.dataset.decision;
      const note = decision === 'rejected' ? (prompt('Reason for rejection (optional):') || '') : null;
      if (!confirm(decision === 'approved'
        ? 'Approve this remittance? Confirm the funds have arrived in Courtly’s receiving account.'
        : 'Reject this remittance submission?')) return;
      button.disabled = true;
      try {
        const { error } = await supabase.rpc('review_coach_remittance', {
          p_remittance_id: button.dataset.remit,
          p_decision: decision,
          p_admin_note: note
        });
        if (error) throw error;
        message(`Remittance ${decision}.`, 'success');
        await load();
      } catch (error) {
        message(error.message || 'Could not review the remittance.');
      } finally {
        button.disabled = false;
      }
    });
  });
}
async function load() {
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  if (!auth?.user) {
    location.replace('/login.html?next=/admin-coaches.html');
    return;
  }
  const { data, error } = await supabase.rpc('get_courtly_admin_coach_data');
  if (error) throw error;
  render(data || {});
}
$('refreshBtn').addEventListener('click', () => load().catch((error) => message(error.message || 'Could not refresh coach data.')));
$('logoutBtn').addEventListener('click', async () => {
  const { error } = await supabase.auth.signOut();
  if (error) {
    message(error.message || 'Could not sign out.');
    return;
  }
  location.assign('/login.html');
});
load().catch((error) => {
  message(error.message || 'Could not load admin coach data.');
  $('coachGrid').innerHTML = '<div class="empty" style="grid-column:1/-1">Admin access is required. Make sure this account is allowlisted as a Courtly administrator.</div>';
  $('remittanceList').innerHTML = '<div class="empty">Admin data is unavailable.</div>';
  $('invoiceList').innerHTML = '<div class="empty">Admin data is unavailable.</div>';
});
