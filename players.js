import { supabase } from './supabase-client.js';

const $ = id => document.getElementById(id);
const list = $('listings');
const count = $('count');
const search = $('search');
const sport = $('sport');
const city = $('city');
const chips = $('activeFilters');
const nearbyList = $('nearbyListings');
const params = new URLSearchParams(location.search);

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const norm = value => String(value || '').toLowerCase();
const money = value => `₱${Number(value).toLocaleString('en-PH', { maximumFractionDigits: 2 })}`;

let venues = [];
let loadState = 'loading';

const nearbyCourts = [
  {
    name:'Lipa Elite Pickleball',
    city:'Lipa City, Batangas',
    address:'Mercado De Lipa, Purok 6 MK Lina St, Brgy. San Sebastian',
    sport:'Pickleball',
    courtCount:'5 indoor courts',
    image:'https://lipaelitepickleball.com/logo.png',
    imageFit:'contain',
    url:'https://lipaelitepickleball.com/'
  },
  {
    name:'The Pickle Yard Lipa South',
    city:'Lipa City, Batangas',
    address:'Purok 5, Lipa City, Batangas',
    sport:'Pickleball',
    courtCount:'4 indoor courts',
    image:'https://baseline-prod.sgp1.digitaloceanspaces.com/6d030b319415d5d3275a0fabcbe58164.png',
    imageFit:'contain',
    url:'https://www.facebook.com/PYLipaSouth'
  },
  {
    name:'Lipa City Community Park Sports Area',
    city:'Lipa City, Batangas',
    address:'Lipa City, Batangas',
    sport:'Multi-sport',
    courtCount:'Public sports facilities',
    image:'https://www.dpwh.gov.ph/dpwh/sites/default/files/lipa_city_park_upgraded_facilities.jpg',
    imageFit:'contain',
    url:'https://www.google.com/maps/search/?api=1&query=Lipa+City+Community+Park+Batangas'
  }
];
let requestVersion = 0;

search.value = params.get('q') || '';
sport.value = params.get('sport') || '';
const initialCity = params.get('city');
if (initialCity) {
  city.insertAdjacentHTML('beforeend', `<option value="${esc(initialCity)}">${esc(initialCity)}</option>`);
  city.value = initialCity;
}

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

function renderNearbyCourts() {
  if (!nearbyList) return;
  nearbyList.innerHTML = nearbyCourts.map(venue => {
    const query = encodeURIComponent([venue.name, venue.address, venue.city].filter(Boolean).join(', '));
    const href = venue.url || `https://www.google.com/maps/search/?api=1&query=${query}`;
    return `<article class="venue-card nearby-card"><div class="cover">${venue.image ? `<img src="${esc(venue.image)}" alt="${esc(venue.name)}" loading="lazy" decoding="async" style="object-fit:contain;background:#fff;padding:14px;" onerror="this.hidden=true">` : ''}<small>NEARBY COURT</small></div><div class="card-body"><h3>${esc(venue.name)}</h3><div class="location">${esc([venue.city, venue.address].filter(Boolean).join(' · '))}</div><div class="tags"><span class="tag">${esc(venue.sport)}</span><span class="tag">${esc(venue.courtCount)}</span></div><p class="nearby-note">Local court reference. Booking and availability are handled directly by the venue until they join Courtly.</p><div class="card-foot"><span class="rate">External venue</span><a class="book" href="${href}" target="_blank" rel="noopener noreferrer">View court</a></div></div></article>`;
  }).join('');
}

function render() {
  if (loadState !== 'ready') return;
  const q = norm(search.value.trim());
  const selectedSport = norm(sport.value);
  const selectedCity = norm(city.value);

  const filtered = venues.filter(venue => {
    const courts = venue.courts || [];
    const text = [venue.name, venue.address, venue.city, venue.sport, ...courts.map(c => c.name), ...courts.map(c => c.sport)].join(' ').toLowerCase();
    return (!q || text.includes(q))
      && (!selectedSport || courts.some(c => norm(c.sport).includes(selectedSport)) || norm(venue.sport).includes(selectedSport))
      && (!selectedCity || norm(venue.city) === selectedCity);
  });

  count.textContent = `${filtered.length} ${filtered.length === 1 ? 'venue' : 'venues'} found`;

  if (!filtered.length) {
    const hasFilters = Boolean(q || selectedSport || selectedCity);
    list.innerHTML = `<div class="empty"><b>${hasFilters ? 'No venues match these filters.' : 'No published venues are available yet.'}</b><p>${hasFilters ? 'Try a different search, sport or location.' : 'Published Courtly venues will appear here automatically.'}</p>${hasFilters ? '<button type="button" class="results-action" data-action="clear">Clear all filters</button>' : ''}</div>`;
    return;
  }

  list.innerHTML = filtered.map(venue => {
    const courts = (venue.courts || []).filter(c => !selectedSport || norm(c.sport).includes(selectedSport));
    const sports = [...new Set(courts.map(c => c.sport).filter(Boolean))];
    const rates = courts.map(rate).filter(value => value !== null);
    const min = rates.length ? Math.min(...rates) : null;
    const cover = venue.cover_url || venue.logo_url || courts.find(c => c.image_url)?.image_url;
    const bookingHref = venue.slug ? `/book/${encodeURIComponent(venue.slug)}` : '';

    return `<article class="venue-card"><div class="cover">${cover ? `<img src="${esc(cover)}" alt="${esc(venue.name)} venue photo" loading="lazy" decoding="async" width="640" height="360">` : ''}<small>COURTLY VENUE</small></div><div class="card-body"><h3>${esc(venue.name)}</h3><div class="location">${esc([venue.city, venue.address].filter(Boolean).join(' · ') || 'Location not provided')}</div><div class="tags">${(sports.length ? sports : [venue.sport || 'Sports venue']).slice(0, 4).map(s => `<span class="tag">${esc(s)}</span>`).join('')}<span class="tag">${courts.length} ${selectedSport ? 'matching' : 'active'} ${courts.length === 1 ? 'court' : 'courts'}</span></div><div class="courts">${courts.slice(0, 3).map(c => `<div class="court-row"><span>${esc(c.name)}${c.sport ? ' · ' + esc(c.sport) : ''}</span><b>${rate(c) === null ? 'Rate not listed' : money(rate(c)) + '/hr'}</b></div>`).join('')}${courts.length > 3 ? `<div class="court-row"><span>+ ${courts.length - 3} more ${courts.length - 3 === 1 ? 'court' : 'courts'}</span></div>` : ''}</div><div class="card-foot"><div class="rate">${min === null ? 'Rates not listed' : `From <strong>${money(min)}</strong>/hr`}</div>${bookingHref ? `<a class="book" href="${bookingHref}" aria-label="View ${esc(venue.name)}">View venue</a>` : '<span class="tag">Details coming soon</span>'}</div></div></article>`;
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
    if (!supabase) throw new Error('Courtly venue service is not configured.');

    const { data, error } = await supabase
      .from('venues')
      .select('id,slug,name,address,city,sport,logo_url,cover_url,is_published,activation_status,courts(id,name,sport,hourly_rate,off_peak_rate,is_active,image_url)')
      .eq('is_published', true)
      .in('activation_status', ['trial', 'active'])
      .order('created_at', { ascending: false });

    if (error) throw error;
    if (version !== requestVersion) return;

    venues = (data || []).map(v => ({
      ...v,
      courts: (v.courts || []).filter(c => c.is_active !== false)
    })).filter(v => v.courts.length > 0);

    loadState = 'ready';
    setCities();
    updateFilters();
  } catch (error) {
    if (version !== requestVersion) return;
    console.error('Courtly venue listings could not be loaded:', error);
    venues = [];
    loadState = 'error';
    setCities();
    count.textContent = 'Venues unavailable';
    list.innerHTML = '<div class="error" role="status"><b>We couldn’t load venue listings.</b><p>Please try again.</p><button class="results-action" type="button" data-action="retry">Retry</button></div>';
  } finally {
    if (version === requestVersion) list.setAttribute('aria-busy', 'false');
  }
}

function clearFilters() {
  search.value = '';
  sport.value = '';
  city.value = '';
  updateFilters();
  search.focus();
}

[search, sport, city].forEach(el => el.addEventListener('input', updateFilters));
$('clear').addEventListener('click', clearFilters);

chips.addEventListener('click', event => {
  const key = event.target.closest('[data-clear-filter]')?.dataset.clearFilter;
  const input = { q: search, sport, city }[key];
  if (input) {
    input.value = '';
    updateFilters();
    input.focus();
  }
});

list.addEventListener('click', event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'retry') load();
  else if (action === 'clear') clearFilters();
});

list.addEventListener('error', event => {
  if (event.target.tagName === 'IMG') event.target.hidden = true;
}, true);

renderNearbyCourts();
load();
