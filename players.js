import { supabase } from './supabase-client.js';

const $ = id => document.getElementById(id);
const list = $('listings');
const count = $('count');
const search = $('search');
const sport = $('sport');
const city = $('city');
const chips = $('activeFilters');
const params = new URLSearchParams(location.search);
const isDemo = params.get('demo') === '1';
const clientDemoVenue = {
  id: 'client-demo-lipa', sample: true, slug: 'client-demo-lipa',
  demoBookingUrl: '/demo-booking.html?slug=demo-lipa-pickleball-hub',
  name: 'DEMO · Lipa Pickleball Hub', address: 'Presentation venue · Lipa City',
  city: 'Lipa City, Batangas', courts: [
    { id: 'demo-c1', name: 'Court 1 · Indoor', sport: 'Pickleball', hourly_rate: 350 },
    { id: 'demo-c2', name: 'Court 2 · Indoor', sport: 'Pickleball', hourly_rate: 350 },
    { id: 'demo-c3', name: 'Court 3 · Outdoor', sport: 'Pickleball', hourly_rate: 300 }
  ]
};
const localVenueShowcase = [
  {
    id:'external-lipa-elite', external:true, name:'Lipa Elite Pickleball',
    address:'Mercado De Lipa, Purok 6 MK Lina St, Brgy. San Sebastian',
    city:'Lipa City, Batangas', externalUrl:'https://lipaelitepickleball.com/',
    courts:Array.from({length:5},(_,i)=>({id:'lep-'+i,name:'Indoor Court '+(i+1),sport:'Pickleball',hourly_rate:500}))
  },
  {
    id:'external-pickle-yard', external:true, name:'The Pickle Yard Lipa South',
    address:'Purok 5, Lipa City, Batangas', city:'Lipa City, Batangas',
    externalUrl:'https://www.facebook.com/PYLipaSouth',
    courts:Array.from({length:4},(_,i)=>({id:'pyl-'+i,name:'Indoor Court '+(i+1),sport:'Pickleball',hourly_rate:500}))
  }
];
const sampleVenues = [clientDemoVenue, ...localVenueShowcase];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const norm = value => String(value || '').toLowerCase();
const money = value => `₱${value.toLocaleString('en-PH', { maximumFractionDigits: 2 })}`;
let venues = [];
let loadState = 'loading';
let requestVersion = 0;

search.value = params.get('q') || '';
sport.value = params.get('sport') || '';
const initialCity = params.get('city');
if (initialCity) { city.insertAdjacentHTML('beforeend', `<option value="${esc(initialCity)}">${esc(initialCity)}</option>`); city.value = initialCity; }

function rate(court) {
  const raw = court.off_peak_rate != null && String(court.off_peak_rate).trim() !== '' ? court.off_peak_rate : court.hourly_rate;
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function updateFilters() {
  const url = new URL(location.href);
  const selections = [['q', search.value.trim()], ['sport', sport.value], ['city', city.value]];
  for (const [key, value] of selections) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  chips.innerHTML = selections.filter(([, value]) => value).map(([key, value]) =>
    `<button class="filter-chip" type="button" data-clear-filter="${key}" aria-label="Remove ${key === 'q' ? 'search' : key} filter: ${esc(value)}">${esc(value)} <span aria-hidden="true">×</span></button>`
  ).join('');
  chips.hidden = !selections.some(([, value]) => value);
  render();
}

function render() {
  // Changing a filter must not replace a network error or a pending request with a false empty result.
  if (loadState !== 'ready') return;
  const q = norm(search.value.trim()), selectedSport = norm(sport.value), selectedCity = norm(city.value);
  const filtered = venues.filter(venue => {
    const courts = venue.courts || [];
    const text = [venue.name, venue.address, venue.city, ...courts.map(c => c.name), ...courts.map(c => c.sport)].join(' ').toLowerCase();
    return (!q || text.includes(q)) && (!selectedSport || courts.some(c => norm(c.sport).includes(selectedSport))) && (!selectedCity || norm(venue.city) === selectedCity);
  });
  count.textContent = `${filtered.length} ${filtered.length === 1 ? 'venue' : 'venues'} found${isDemo ? ' · demo listings' : ''}`;
  if (!filtered.length) {
    const hasFilters = Boolean(q || selectedSport || selectedCity);
    list.innerHTML = `<div class="empty"><b>${hasFilters ? 'No venues match these filters.' : 'No venues are listed yet.'}</b><p>${hasFilters ? 'Try a different search, sport or location.' : 'Please check back soon for courts near you.'}</p>${hasFilters ? '<button type="button" class="results-action" data-action="clear">Clear all filters</button>' : ''}</div>`;
    return;
  }
  list.innerHTML = filtered.map(venue => {
    const courts = (venue.courts || []).filter(c => !selectedSport || norm(c.sport).includes(selectedSport));
    const sports = [...new Set(courts.map(c => c.sport).filter(Boolean))];
    const rates = courts.map(rate).filter(value => value !== null);
    const min = rates.length ? Math.min(...rates) : null;
    const cover = venue.cover_url || venue.logo_url || courts.find(c => c.image_url)?.image_url;
    const bookingHref = venue.demoBookingUrl || venue.externalUrl || (venue.slug ? `/venue.html?slug=${encodeURIComponent(venue.slug)}` : '');
    return `<article class="venue-card"><div class="cover"><span aria-hidden="true">⌂</span>${cover ? `<img src="${esc(cover)}" alt="${esc(venue.name)} venue photo" loading="lazy" decoding="async" width="640" height="360">` : ''}<small>${venue.sample ? 'CLIENT DEMO' : venue.external ? 'NEARBY · NOT YET ON COURTLY' : 'COURTLY VENUE'}</small></div><div class="card-body"><h3>${esc(venue.name)}</h3><div class="location">${esc([venue.city, venue.address].filter(Boolean).join(' · ') || 'Location not provided')}</div><div class="tags">${(sports.length ? sports : ['Sports venue']).slice(0, 4).map(s => `<span class="tag">${esc(s)}</span>`).join('')}<span class="tag">${courts.length} ${selectedSport ? 'matching' : 'active'} ${courts.length === 1 ? 'court' : 'courts'}</span></div><div class="courts">${courts.slice(0, 3).map(c => `<div class="court-row"><span>${esc(c.name)}${c.sport ? ' · ' + esc(c.sport) : ''}</span><b>${rate(c) === null ? 'Rate not listed' : money(rate(c)) + '/hr'}</b></div>`).join('')}${courts.length > 3 ? `<div class="court-row"><span>+ ${courts.length - 3} more ${courts.length - 3 === 1 ? 'court' : 'courts'}</span></div>` : ''}</div><div class="card-foot"><div class="rate">${min === null ? 'Rates not listed' : `From <strong>${money(min)}</strong>/hr`}</div>${bookingHref ? `<a class="book" href="${bookingHref}" ${venue.external ? 'target="_blank" rel="noopener noreferrer"' : ''} aria-label="${venue.sample ? 'Open demo booking for' : 'View'} ${esc(venue.name)}">${venue.sample ? 'Try demo booking' : venue.external ? 'Visit official page' : 'View venue'} <span aria-hidden="true">→</span></a>` : '<span class="tag">Details coming soon</span>'}</div></div></article>`;
  }).join('');
}

function setCities() {
  const selected = city.value;
  const cities = [...new Set(venues.map(v => v.city).filter(Boolean))];
  if (selected && !cities.includes(selected)) cities.push(selected);
  cities.sort((a, b) => a.localeCompare(b));
  city.innerHTML = '<option value="">All locations</option>' + cities.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
  city.value = selected;
}

async function load() {
  const version = ++requestVersion;
  loadState = 'loading';
  list.setAttribute('aria-busy', 'true');
  count.textContent = 'Loading venues…';
  list.innerHTML = '<div class="loading" role="status">Finding courts and venues…</div>';
  try {
    let data;
    data = sampleVenues;
    if (version !== requestVersion) return;
    venues = data.map(v => ({ ...v, courts: (v.courts || []).filter(c => c.is_active !== false) }));
    loadState = 'ready';
    setCities();
    updateFilters();
  } catch (error) {
    if (version !== requestVersion) return;
    console.error('Courtly venue listings could not be loaded:', error);
    venues = sampleVenues;
    loadState = 'ready';
    setCities();
    updateFilters();
    count.textContent = 'Demo venue available · live venues temporarily unavailable';
    list.insertAdjacentHTML('beforeend','<div class="error" role="status"><b>Live venue listings are temporarily unavailable.</b><p>The client demo venue above is still fully interactive for presentations.</p><button class="results-action" type="button" data-action="retry">Retry live venues</button></div>');
  } finally {
    if (version === requestVersion) list.setAttribute('aria-busy', 'false');
  }
}

function clearFilters() {
  search.value = ''; sport.value = ''; city.value = '';
  updateFilters();
  search.focus();
}
[search, sport, city].forEach(el => el.addEventListener('input', updateFilters));
$('clear').addEventListener('click', clearFilters);
chips.addEventListener('click', event => {
  const key = event.target.closest('[data-clear-filter]')?.dataset.clearFilter;
  const input = { q: search, sport, city }[key];
  if (input) { input.value = ''; updateFilters(); input.focus(); }
});
list.addEventListener('click', event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'retry') load();
  else if (action === 'clear') clearFilters();
});
list.addEventListener('error', event => {
  if (event.target.tagName === 'IMG') event.target.hidden = true;
}, true);
load();
