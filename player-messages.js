import { supabase, supabaseConfigError } from './supabase-client.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const initials = (value = 'Player') => String(value).trim().split(/\s+/).map((x) => x[0] || '').join('').slice(0, 2).toUpperCase() || 'P';
const state = { user: null, conversations: [], activeId: null, activePlayerId: null, activePlayerName: '', loading: false, composeOnOpen: false, timer: null };

function showMessage(text, type = 'success') {
  const node = $('pageMessage');
  node.textContent = text;
  node.className = 'page-message show ' + type;
}
function hideMessage() {
  $('pageMessage').className = 'page-message';
}
function formatTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}
function formatMessageTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}
function setThreadMode(active) {
  $('messagesShell').classList.toggle('has-thread', Boolean(active));
  $('messageBody').disabled = !active;
  $('sendButton').disabled = !active;
}
function renderConversationList() {
  const node = $('conversationList');
  if (!state.conversations.length) {
    node.innerHTML = '<div class="thread-empty" style="padding:25px 18px"><strong>No conversations yet</strong>Visit Players in your dashboard and choose Chat or Message on a public player profile.</div>';
    return;
  }
  node.innerHTML = state.conversations.map((conversation) => {
    const name = conversation.other_player_name || 'Courtly Player';
    return '<button class="conversation '+(conversation.conversation_id === state.activeId ? 'active' : '')+'" type="button" data-chat-id="'+esc(conversation.conversation_id)+'"><span class="conversation-avatar">'+esc(initials(name))+'</span><span class="conversation-copy"><strong>'+esc(name)+'</strong><small>'+esc(conversation.last_message || 'Start a conversation')+'</small></span><span class="conversation-time">'+esc(formatTime(conversation.last_message_at))+'</span></button>';
  }).join('');
}
function getActiveConversation() {
  return state.conversations.find((item) => item.conversation_id === state.activeId) || null;
}
function renderThread(rows) {
  const active = getActiveConversation();
  const name = active?.other_player_name || state.activePlayerName || 'Courtly Player';
  $('threadName').textContent = name;
  $('threadMeta').textContent = active?.other_sport ? active.other_sport + ' · Private player chat' : 'Private player chat';
  $('threadAvatar').textContent = initials(name);
  if (!rows.length) {
    $('threadMessages').innerHTML = '<div class="thread-empty"><strong>Start the conversation</strong>Send a friendly message to '+esc(name)+'. Your messages are only visible to the two players in this conversation.</div>';
  } else {
    $('threadMessages').innerHTML = rows.map((message) => '<div class="bubble '+(message.is_mine ? 'mine' : '')+'">'+esc(message.body).replace(/\n/g,'<br>')+'<small>'+(message.is_mine ? 'You' : esc(message.sender_name))+' · '+esc(formatMessageTime(message.created_at))+'</small></div>').join('');
  }
  $('threadMessages').scrollTop = $('threadMessages').scrollHeight;
  setThreadMode(true);
}
async function refreshConversations() {
  const { data, error } = await supabase.rpc('get_player_conversations');
  if (error) throw error;
  state.conversations = data || [];
  renderConversationList();
}
async function loadThread() {
  if (!state.activeId) { setThreadMode(false); return; }
  const { data, error } = await supabase.rpc('get_player_chat_messages', { p_conversation_id: state.activeId });
  if (error) throw error;
  renderThread(data || []);
}
async function openConversation(conversationId, playerId = null, playerName = '') {
  state.activeId = conversationId;
  state.activePlayerId = playerId;
  state.activePlayerName = playerName;
  await refreshConversations();
  await loadThread();
  const url = new URL(location.href);
  url.searchParams.set('conversation', conversationId);
  url.searchParams.delete('player');
  url.searchParams.delete('compose');
  history.replaceState({}, '', url);
  $('messageBody').focus({ preventScroll: true });
  if (!state.composeOnOpen) $('threadMessages').scrollTop = $('threadMessages').scrollHeight;
}
async function init() {
  if (!supabase) throw new Error(supabaseConfigError || 'Courtly is not connected to Supabase.');
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!session?.user) {
    const returnTo = location.pathname + location.search;
    location.replace('/player-login.html?returnTo=' + encodeURIComponent(returnTo));
    return;
  }
  state.user = session.user;
  const { data: profile, error: profileError } = await supabase.from('player_profiles').select('id').eq('id', state.user.id).maybeSingle();
  if (profileError) throw profileError;
  if (!profile) {
    await supabase.auth.signOut();
    location.replace('/player-login.html?switchAccount=1&returnTo=' + encodeURIComponent(location.pathname + location.search));
    return;
  }

  const params = new URLSearchParams(location.search);
  state.composeOnOpen = params.get('compose') === '1';
  const targetPlayerId = params.get('player');
  if (targetPlayerId) {
    const { data: conversationId, error } = await supabase.rpc('start_player_conversation', { p_other_player_id: targetPlayerId });
    if (error) throw error;
    state.activeId = conversationId;
    await refreshConversations();
    await loadThread();
    if (state.composeOnOpen) $('messageBody').focus({ preventScroll: true });
  } else {
    state.activeId = params.get('conversation') || null;
    await refreshConversations();
    if (!state.activeId && state.conversations.length) state.activeId = state.conversations[0].conversation_id;
    if (state.activeId) await loadThread();
    else setThreadMode(false);
  }
  renderConversationList();
}
$('conversationList').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-chat-id]');
  if (!button) return;
  hideMessage();
  try {
    state.composeOnOpen = false;
    await openConversation(button.dataset.chatId);
  } catch (error) {
    showMessage(error.message || 'Could not open this conversation.', 'error');
  }
});
$('sendForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = $('messageBody').value.trim();
  if (!body || !state.activeId || state.loading) return;
  state.loading = true;
  $('sendButton').disabled = true;
  try {
    const { error } = await supabase.rpc('send_player_message', { p_conversation_id: state.activeId, p_body: body });
    if (error) throw error;
    $('messageBody').value = '';
    await refreshConversations();
    await loadThread();
    $('messageBody').focus();
  } catch (error) {
    showMessage(error.message || 'Your message could not be sent.', 'error');
  } finally {
    state.loading = false;
    $('sendButton').disabled = !state.activeId;
  }
});
$('mobileBack').addEventListener('click', () => setThreadMode(false));
init().catch((error) => {
  console.error('Courtly player messages failed to load:', error);
  $('conversationList').innerHTML = '<div class="thread-empty" style="padding:22px 16px"><strong>Messages are unavailable</strong>'+esc(error.message || 'Please refresh and try again. If this is a new deployment, run migration 017 in Supabase.')+'</div>';
  $('threadMessages').innerHTML = '<div class="thread-empty"><strong>Unable to load chat</strong>Check your connection and player account, then refresh.</div>';
  showMessage(error.message || 'Unable to load messages.', 'error');
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.activeId && supabase) {
    refreshConversations().then(loadThread).catch(() => {});
  }
});
