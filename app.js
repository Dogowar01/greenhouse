'use strict';

// ============================================================
// STATE
// ============================================================

const APP_VERSION = '1.0.0';
const STORAGE_KEY = 'greenhouse_v1';

const state = {
  plants: [],
  logs: [],
  settings: {
    proxyUrl: '',
    locationLat: null,
    locationLng: null,
    locationName: '',
  },
  weather: null,
  weatherFetched: false,
  currentScreen: 'home',
  currentPlantId: null,
  chatHistory: [],
  calendarContent: null,
  calendarMonth: null,
  pendingPlantPhoto: null,
  pendingIdentification: null,
  editingPlantId: null,
};

// ============================================================
// STORAGE
// ============================================================

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      plants: state.plants,
      logs: state.logs,
      settings: state.settings,
      calendarContent: state.calendarContent,
      calendarMonth: state.calendarMonth,
      chatHistory: state.chatHistory,
    }));
  } catch (e) {
    console.error('Storage error:', e);
  }
}

function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    const data = JSON.parse(saved);
    if (data.plants) state.plants = data.plants;
    if (data.logs) state.logs = data.logs;
    if (data.settings) state.settings = { ...state.settings, ...data.settings };
    if (data.calendarContent) state.calendarContent = data.calendarContent;
    if (data.calendarMonth) state.calendarMonth = data.calendarMonth;
    if (data.chatHistory) state.chatHistory = data.chatHistory;
  } catch (e) {
    console.error('Load error:', e);
  }
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// ============================================================
// WEATHER — Open-Meteo (free, no key)
// ============================================================

async function fetchWeather() {
  if (state.weatherFetched) return;

  if (!state.settings.locationLat) {
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000 });
      });
      state.settings.locationLat = pos.coords.latitude;
      state.settings.locationLng = pos.coords.longitude;
      saveState();
    } catch (_) {
      // Tamar Valley default
      state.settings.locationLat = -41.44;
      state.settings.locationLng = 147.13;
      state.settings.locationName = 'Tamar Valley, Tasmania';
      saveState();
    }
  }

  try {
    const { locationLat: lat, locationLng: lng } = state.settings;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weathercode,precipitation,windspeed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode,precipitation_probability_max&timezone=auto&forecast_days=3`;
    const res = await fetch(url);
    state.weather = await res.json();
    state.weatherFetched = true;
    if (state.currentScreen === 'home') renderCurrentScreen();
  } catch (e) {
    console.error('Weather fetch failed:', e);
  }
}

function weatherDesc(code) {
  const map = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Icy fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
    80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
    95: 'Thunderstorm',
  };
  return map[code] || 'Variable';
}

function weatherEmoji(code) {
  if (code <= 1) return '☀️';
  if (code === 2) return '⛅';
  if (code === 3) return '☁️';
  if (code >= 45 && code <= 48) return '🌫️';
  if (code >= 51 && code <= 67) return '🌧️';
  if (code >= 71 && code <= 77) return '❄️';
  if (code >= 80 && code <= 82) return '🌦️';
  if (code >= 95) return '⛈️';
  return '🌤️';
}

function isRaining(code) {
  return (code >= 51 && code <= 82);
}

// ============================================================
// CLAUDE API
// ============================================================

async function callClaude(messages, system = '') {
  const { proxyUrl } = state.settings;
  if (!proxyUrl) throw new Error('No proxy URL configured — go to Settings to add it.');

  const body = { model: 'claude-opus-4-7', max_tokens: 1500, messages };
  if (system) body.system = system;

  const res = await fetch(proxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.content[0].text;
}

async function identifyPlant(base64) {
  const text = await callClaude([{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
      { type: 'text', text: `Identify this plant. Return only valid JSON:
{
  "commonName": "string",
  "scientificName": "string",
  "confidence": "high"|"medium"|"low",
  "description": "one sentence",
  "careProfile": {
    "wateringFrequency": "string",
    "sunlight": "string",
    "temperature": "string",
    "notes": "2-3 short tips"
  }
}` }
    ],
  }], 'You are a plant identification expert. Always respond with valid JSON only, no markdown.');
  return JSON.parse(text);
}

async function diagnosePlant(base64, plant) {
  const ctx = [
    `Plant: ${plant.nickname} (${plant.species}${plant.scientificName ? ' / ' + plant.scientificName : ''})`,
    `Location: ${plant.location}${plant.windowDirection ? ', ' + plant.windowDirection + '-facing window' : ''}`,
    plant.microclimatNotes ? `Microclimate: ${plant.microclimatNotes}` : '',
    `Pot: ${[plant.potSize, plant.potType].filter(Boolean).join(' ')} pot`,
    `Last watered: ${formatDate(plant.lastWatered)}`,
    `Last fertilised: ${formatDate(plant.lastFertilised)}`,
    state.weather ? `Weather now: ${weatherDesc(state.weather.current.weathercode)}, ${Math.round(state.weather.current.temperature_2m)}°C` : '',
  ].filter(Boolean).join('\n');

  const text = await callClaude([{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
      { type: 'text', text: `Diagnose this plant issue.\n\nPlant profile:\n${ctx}\n\nReturn only valid JSON:\n{\n  "diagnoses": [\n    {\n      "condition": "string",\n      "confidence": 0-100,\n      "explanation": "string",\n      "symptoms": "string",\n      "fix": "string",\n      "urgency": "low"|"medium"|"high"\n    }\n  ],\n  "differentiating": "string or null",\n  "immediateAction": "string"\n}` }
    ],
  }], 'You are an expert plant pathologist. Return only valid JSON, no markdown.');
  return JSON.parse(text);
}

async function generateCalendarTasks(plants) {
  const month = new Date().toLocaleString('en-AU', { month: 'long' });
  const year = new Date().getFullYear();
  const season = getSeason();
  const plantList = plants.length
    ? plants.map(p => `- ${p.nickname} (${p.species}, ${p.location})`).join('\n')
    : '- No plants added yet';

  const text = await callClaude([{
    role: 'user',
    content: `Garden calendar for ${month} ${year} — ${season}, Southern Hemisphere, Tamar Valley Tasmania.\n\nMy plants:\n${plantList}\n\nReturn only valid JSON:\n{\n  "month": "${month} ${year}",\n  "season": "${season}",\n  "summary": "string",\n  "tasmaniaNote": "string",\n  "tasks": [\n    {\n      "category": "Watering"|"Feeding"|"Pruning"|"Pest & Disease"|"Propagation"|"Seasonal Prep"|"General",\n      "task": "string",\n      "plants": ["string"],\n      "priority": "essential"|"recommended"|"optional",\n      "timing": "string"\n    }\n  ]\n}`,
  }], 'You are an expert Tasmanian horticulturalist specialising in the Tamar Valley. Southern hemisphere seasons. Always respond with valid JSON only, no markdown.');
  return JSON.parse(text);
}

async function askGreenhouseAI(userMessage) {
  const plant = state.currentPlantId ? state.plants.find(p => p.id === state.currentPlantId) : null;

  let system = `You are Greenhouse, a friendly and knowledgeable plant care assistant. You speak conversationally, always explaining the "why" behind advice. You are tailored for Tasmania, Australia — Tamar Valley area, southern hemisphere, temperate maritime climate. Be warm but concise.

Today: ${new Date().toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. Season: ${getSeason()}.`;

  if (state.weather) {
    const code = state.weather.current.weathercode;
    system += `\nWeather: ${weatherDesc(code)}, ${Math.round(state.weather.current.temperature_2m)}°C.`;
    if (isRaining(code)) system += ' (raining today — outdoor plants don\'t need watering)';
    if (state.weather.daily.temperature_2m_min[0] < 4) system += ' Frost risk tonight.';
  }

  if (state.plants.length) {
    system += '\n\nUser\'s plants:\n' + state.plants.map(p =>
      `- ${p.nickname} (${p.species}, ${p.location}${p.windowDirection ? ', ' + p.windowDirection + '-facing' : ''})`
    ).join('\n');
  }

  if (plant) {
    system += `\n\nCurrently discussing: ${plant.nickname} (${plant.species}). Last watered: ${formatDate(plant.lastWatered)}. Last fertilised: ${formatDate(plant.lastFertilised)}. ${plant.microclimatNotes || ''}`;
  }

  const messages = [...state.chatHistory, { role: 'user', content: userMessage }];
  const reply = await callClaude(messages, system);

  state.chatHistory.push({ role: 'user', content: userMessage });
  state.chatHistory.push({ role: 'assistant', content: reply });
  if (state.chatHistory.length > 20) state.chatHistory = state.chatHistory.slice(-20);
  saveState();
  return reply;
}

// ============================================================
// UTILITIES
// ============================================================

function getSeason() {
  const m = new Date().getMonth();
  if (m >= 2 && m <= 4) return 'Autumn';
  if (m >= 5 && m <= 7) return 'Winter';
  if (m >= 8 && m <= 10) return 'Spring';
  return 'Summer';
}

function formatDate(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso), now = new Date();
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return `${diff} days ago`;
  if (diff < 30) return `${Math.floor(diff / 7)}w ago`;
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

function daysSince(iso) {
  if (!iso) return Infinity;
  return Math.floor((Date.now() - new Date(iso)) / 86400000);
}

function getTimeOfDay() {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}

function plantEmoji(plant) {
  const s = (plant.species || '').toLowerCase();
  if (s.includes('cactus') || s.includes('succulent') || s.includes('aloe')) return '🌵';
  if (s.includes('fern')) return '🌿';
  if (s.includes('orchid')) return '🌸';
  if (s.includes('rose')) return '🌹';
  if (s.includes('tomato')) return '🍅';
  if (s.includes('basil') || s.includes('mint') || s.includes('herb')) return '🌱';
  if (plant.location === 'outdoor') return '🌳';
  return '🪴';
}

function needsWater(plant) {
  if (!plant.lastWatered) return true;
  const threshold = plant.location === 'outdoor' ? 3 : 7;
  return daysSince(plant.lastWatered) >= threshold;
}

function plantsNeedingAttention() {
  return state.plants.filter(needsWater);
}

function logTypeIcon(type) {
  return { watered: '💧', fertilised: '🌿', repotted: '🪣', diagnosed: '🔬', note: '📝' }[type] || '📝';
}

function cap(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

// ============================================================
// IMAGE
// ============================================================

function compressImage(file, maxW = 800, quality = 0.72) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality).split(',')[1]);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ============================================================
// ROUTER
// ============================================================

function navigate(screen, plantId = null) {
  state.currentScreen = screen;
  if (plantId !== null) state.currentPlantId = plantId;
  updateNav();
  renderCurrentScreen();
  window.scrollTo(0, 0);
}

function updateNav() {
  ['home', 'plants', 'calendar', 'chat', 'settings'].forEach(s => {
    document.getElementById(`nav-${s}`)?.classList.toggle('active', state.currentScreen === s);
  });
}

function renderCurrentScreen() {
  const app = document.getElementById('app');
  const screens = {
    home: renderHome,
    plants: renderPlantList,
    plant: () => renderPlantProfile(state.currentPlantId),
    'add-plant': renderAddPlant,
    'confirm-id': renderConfirmId,
    'plant-details-form': renderPlantDetailsForm,
    diagnose: () => renderDiagnose(state.currentPlantId),
    chat: renderChat,
    calendar: renderCalendar,
    settings: renderSettings,
  };
  app.innerHTML = (screens[state.currentScreen] || renderHome)();
}

// ============================================================
// SCREEN: HOME
// ============================================================

function renderHome() {
  const attention = plantsNeedingAttention();
  const w = state.weather;

  const weatherHtml = w
    ? `<div class="weather-widget">
        <div class="weather-main">
          <span class="weather-emoji">${weatherEmoji(w.current.weathercode)}</span>
          <div>
            <div class="weather-temp">${Math.round(w.current.temperature_2m)}°C</div>
            <div class="weather-desc">${weatherDesc(w.current.weathercode)}</div>
          </div>
        </div>
        ${isRaining(w.current.weathercode) ? '<div class="weather-note rain-note">🌧️ Raining — skip outdoor watering today</div>' : ''}
        ${w.daily.temperature_2m_min[0] < 4 ? '<div class="weather-note frost-note">❄️ Frost risk tonight — bring tender plants in</div>' : ''}
      </div>`
    : `<div class="weather-widget"><div class="loading-weather">Fetching local weather...</div></div>`;

  const attentionHtml = state.plants.length === 0 ? '' : attention.length > 0
    ? `<div class="section-header">
        <span class="section-title">Needs attention</span>
        <span class="badge-count">${attention.length}</span>
      </div>
      <div class="attention-list">
        ${attention.slice(0, 4).map(p => `
          <div class="attention-card" onclick="navigate('plant','${p.id}')">
            <div class="attention-plant-icon">${plantEmoji(p)}</div>
            <div class="attention-info">
              <div class="attention-name">${p.nickname}</div>
              <div class="attention-reason">${!p.lastWatered ? 'Never watered yet' : `Last watered ${formatDate(p.lastWatered)}`}</div>
            </div>
            <div class="attention-arrow">›</div>
          </div>`).join('')}
      </div>`
    : `<div class="all-good"><span class="all-good-icon">✓</span><span>All plants are looked after</span></div>`;

  const recent = [...state.plants].reverse().slice(0, 4);

  return `
    <div class="screen screen-home">
      <div class="home-header">
        <div>
          <h1 class="app-title">🌿 Greenhouse</h1>
          <p class="home-greeting">Good ${getTimeOfDay()}</p>
        </div>
        <div class="stat-chip">${state.plants.length} plant${state.plants.length !== 1 ? 's' : ''}</div>
      </div>
      ${weatherHtml}
      ${state.plants.length === 0
        ? `<div class="empty-state">
            <div class="empty-icon">🪴</div>
            <h2 class="empty-title">Add your first plant</h2>
            <p class="empty-text">Photograph a plant to identify it, or add one manually.</p>
            <button class="btn-primary" onclick="navigate('add-plant')">Add a plant</button>
          </div>`
        : `${attentionHtml}
           <div class="section-header" style="margin-top:20px">
             <span class="section-title">Your plants</span>
             <button class="link-btn" onclick="navigate('plants')">See all</button>
           </div>
           <div class="plant-grid">${recent.map(plantCardHtml).join('')}</div>`
      }
    </div>
    <div class="fab-container">
      <button class="fab" onclick="navigate('add-plant')" title="Add plant">+</button>
    </div>`;
}

function plantCardHtml(p) {
  const water = needsWater(p);
  return `
    <div class="plant-card${water ? ' plant-card-attention' : ''}" onclick="navigate('plant','${p.id}')">
      <div class="plant-card-photo">
        ${p.photo
          ? `<img src="data:image/jpeg;base64,${p.photo}" alt="${p.nickname}" loading="lazy">`
          : `<div class="plant-card-emoji">${plantEmoji(p)}</div>`}
      </div>
      <div class="plant-card-info">
        <div class="plant-card-name">${p.nickname}</div>
        <div class="plant-card-species">${p.species || 'Unknown species'}</div>
        <div class="plant-card-status ${water ? 'status-attention' : 'status-ok'}">
          ${water ? '💧 Needs water' : `✓ ${formatDate(p.lastWatered)}`}
        </div>
      </div>
    </div>`;
}

// ============================================================
// SCREEN: PLANT LIST
// ============================================================

function renderPlantList() {
  return `
    <div class="screen">
      <div class="screen-header">
        <h2 class="screen-title">My Plants</h2>
        <button class="btn-sm" onclick="navigate('add-plant')">+ Add</button>
      </div>
      ${state.plants.length === 0
        ? `<div class="empty-state">
            <div class="empty-icon">🌱</div>
            <h2 class="empty-title">No plants yet</h2>
            <p class="empty-text">Tap the + button to add your first plant.</p>
            <button class="btn-primary" onclick="navigate('add-plant')">Add a plant</button>
          </div>`
        : `<div class="filter-row">
            <button class="filter-btn active" onclick="filterPlants('all',this)">All (${state.plants.length})</button>
            <button class="filter-btn" onclick="filterPlants('indoor',this)">Indoor</button>
            <button class="filter-btn" onclick="filterPlants('outdoor',this)">Outdoor</button>
            <button class="filter-btn" onclick="filterPlants('attention',this)">⚠ Needs care</button>
          </div>
          <div class="plant-grid" id="plant-grid">${state.plants.map(plantCardHtml).join('')}</div>`
      }
    </div>
    <div class="fab-container">
      <button class="fab" onclick="navigate('add-plant')">+</button>
    </div>`;
}

function filterPlants(filter, btn) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const sets = {
    indoor: state.plants.filter(p => p.location === 'indoor'),
    outdoor: state.plants.filter(p => p.location === 'outdoor'),
    attention: plantsNeedingAttention(),
    all: state.plants,
  };
  document.getElementById('plant-grid').innerHTML = (sets[filter] || state.plants).map(plantCardHtml).join('');
}

// ============================================================
// SCREEN: PLANT PROFILE
// ============================================================

function renderPlantProfile(id) {
  const p = state.plants.find(pl => pl.id === id);
  if (!p) return `<div class="screen"><p style="color:var(--text-muted);padding:40px 0">Plant not found.</p></div>`;

  const logs = state.logs.filter(l => l.plantId === id).slice().reverse().slice(0, 12);

  return `
    <div class="screen-profile">
      <div class="profile-hero">
        <button class="back-btn" onclick="navigate('plants')">‹ Plants</button>
        ${p.photo
          ? `<img src="data:image/jpeg;base64,${p.photo}" class="profile-photo" alt="${p.nickname}">`
          : `<div class="profile-photo-placeholder">${plantEmoji(p)}</div>`}
      </div>
      <div class="profile-content">
        <div class="profile-name-row">
          <div style="flex:1">
            <h1 class="profile-name">${p.nickname}</h1>
            <p class="profile-species">${p.species}${p.scientificName ? ` · <em>${p.scientificName}</em>` : ''}</p>
          </div>
          <button class="icon-btn" onclick="startEditPlant('${p.id}')">✎</button>
        </div>

        <div class="care-status-row">
          <div class="care-status-item">
            <div class="care-status-label">Watered</div>
            <div class="care-status-value${needsWater(p) ? ' status-attention' : ''}">${formatDate(p.lastWatered)}</div>
          </div>
          <div class="care-status-item">
            <div class="care-status-label">Fertilised</div>
            <div class="care-status-value">${formatDate(p.lastFertilised)}</div>
          </div>
          <div class="care-status-item">
            <div class="care-status-label">Location</div>
            <div class="care-status-value">${p.location === 'indoor' ? '🏠' : '🌳'} ${cap(p.location)}</div>
          </div>
        </div>

        <div class="action-row">
          <button class="action-btn" onclick="logCare('${p.id}','watered')">💧 Watered</button>
          <button class="action-btn" onclick="logCare('${p.id}','fertilised')">🌿 Fertilised</button>
          <button class="action-btn" onclick="logCare('${p.id}','repotted')">🪣 Repotted</button>
        </div>

        <div class="ai-actions">
          <button class="ai-btn" onclick="navigate('diagnose','${p.id}')">
            <span class="ai-btn-icon">🔬</span>
            <div>
              <div class="ai-btn-title">Diagnose a problem</div>
              <div class="ai-btn-sub">Upload a photo of a sick leaf</div>
            </div>
          </button>
          <button class="ai-btn" onclick="startChatAboutPlant('${p.id}')">
            <span class="ai-btn-icon">💬</span>
            <div>
              <div class="ai-btn-title">Ask about this plant</div>
              <div class="ai-btn-sub">Chat with Greenhouse AI</div>
            </div>
          </button>
        </div>

        <div class="details-section">
          <h3 class="section-heading">Details</h3>
          <div class="details-grid">
            ${[
              p.potSize && ['Pot size', cap(p.potSize)],
              p.potType && ['Pot type', cap(p.potType)],
              p.windowDirection && ['Window', p.windowDirection + '-facing'],
              p.microclimatNotes && ['Microclimate', p.microclimatNotes],
              ['Added', formatDate(p.dateAdded)],
            ].filter(Boolean).map(([label, val]) =>
              `<div class="detail-item"><span class="detail-label">${label}</span><span class="detail-value">${val}</span></div>`
            ).join('')}
          </div>
        </div>

        ${logs.length > 0 ? `
          <div class="history-section">
            <h3 class="section-heading">History</h3>
            <div class="history-list">
              ${logs.map(l => `
                <div class="history-item">
                  <span class="history-icon">${logTypeIcon(l.type)}</span>
                  <div class="history-info">
                    <span class="history-type">${cap(l.type)}</span>
                    ${l.note ? `<span class="history-note">${l.note}</span>` : ''}
                  </div>
                  <span class="history-date">${formatDate(l.date)}</span>
                </div>`).join('')}
            </div>
          </div>` : ''}

        <div style="margin-top:24px;padding-bottom:8px">
          <button class="delete-btn" onclick="deletePlant('${p.id}')">Remove plant</button>
        </div>
      </div>
    </div>`;
}

function logCare(plantId, type) {
  const p = state.plants.find(pl => pl.id === plantId);
  if (!p) return;
  const now = new Date().toISOString();
  if (type === 'watered') p.lastWatered = now;
  if (type === 'fertilised') p.lastFertilised = now;
  state.logs.push({ id: generateId(), plantId, type, date: now, note: '', photo: null });
  saveState();
  navigate('plant', plantId);
  showToast(`✓ ${cap(type)} logged`);
}

function deletePlant(plantId) {
  if (!confirm('Remove this plant? All history will be deleted.')) return;
  state.plants = state.plants.filter(p => p.id !== plantId);
  state.logs = state.logs.filter(l => l.plantId !== plantId);
  saveState();
  navigate('plants');
}

function startChatAboutPlant(plantId) {
  state.currentPlantId = plantId;
  navigate('chat');
}

function startEditPlant(plantId) {
  state.editingPlantId = plantId;
  state.pendingIdentification = { ...state.plants.find(p => p.id === plantId) };
  navigate('plant-details-form');
}

// ============================================================
// SCREEN: ADD PLANT
// ============================================================

function renderAddPlant() {
  const hasProxy = !!state.settings.proxyUrl;
  return `
    <div class="screen">
      <div class="screen-header">
        <button class="back-btn" onclick="navigate('plants')">‹ Back</button>
        <h2 class="screen-title">Add a Plant</h2>
      </div>
      <div class="add-options">
        <div class="add-option" onclick="document.getElementById('photo-id-input').click()">
          <div class="add-option-icon">📸</div>
          <div class="add-option-title">Identify by photo</div>
          <div class="add-option-sub">Take or upload a photo — AI identifies the species and builds a care profile instantly</div>
          <input type="file" id="photo-id-input" accept="image/*" capture="environment" style="display:none" onchange="handlePhotoId(this)">
        </div>
        <div class="add-option" onclick="state.pendingIdentification=null;state.editingPlantId=null;navigate('plant-details-form')">
          <div class="add-option-icon">✏️</div>
          <div class="add-option-title">Add manually</div>
          <div class="add-option-sub">Enter the plant name and details yourself</div>
        </div>
      </div>
      ${!hasProxy ? `<div class="setup-notice">
        <strong>⚙️ AI not configured yet</strong>
        Photo identification needs the Greenhouse AI. Add your proxy URL in Settings — takes about 5 minutes to set up.
        <br><button class="btn-sm" onclick="navigate('settings')" style="margin-top:10px">Go to Settings</button>
      </div>` : ''}
    </div>`;
}

async function handlePhotoId(input) {
  if (!input.files[0]) return;
  if (!state.settings.proxyUrl) {
    showToast('Please set up your API proxy in Settings first.');
    return;
  }
  document.getElementById('app').innerHTML = `
    <div class="screen loading-screen">
      <div class="loading-spinner">🌿</div>
      <p class="loading-text">Identifying your plant...</p>
      <p class="loading-sub">Claude is analysing the photo</p>
    </div>`;
  try {
    const base64 = await compressImage(input.files[0]);
    state.pendingPlantPhoto = base64;
    state.pendingIdentification = await identifyPlant(base64);
    state.editingPlantId = null;
    navigate('confirm-id');
  } catch (e) {
    showToast('Could not identify — try again or add manually.');
    navigate('add-plant');
  }
}

// ============================================================
// SCREEN: CONFIRM ID
// ============================================================

function renderConfirmId() {
  const id = state.pendingIdentification;
  if (!id) { navigate('add-plant'); return ''; }

  const confColor = { high: 'var(--green)', medium: 'var(--gold)', low: 'var(--red)' }[id.confidence] || 'var(--text-muted)';
  const confLabel = { high: '● High confidence', medium: '◑ Medium confidence', low: '○ Low confidence' }[id.confidence] || '';

  return `
    <div class="screen">
      <div class="screen-header">
        <button class="back-btn" onclick="navigate('add-plant')">‹ Back</button>
        <h2 class="screen-title">Is this right?</h2>
      </div>
      ${state.pendingPlantPhoto
        ? `<img src="data:image/jpeg;base64,${state.pendingPlantPhoto}" class="confirm-photo" alt="Plant photo">`
        : ''}
      <div class="id-result">
        <div class="id-name">${id.commonName || id.nickname || ''}</div>
        <div class="id-scientific"><em>${id.scientificName || ''}</em></div>
        <div class="id-confidence" style="color:${confColor}">${confLabel}</div>
        <p class="id-description">${id.description || ''}</p>
        ${id.careProfile ? `
          <div class="care-preview">
            <div class="care-preview-title">Care overview</div>
            <div class="care-preview-grid">
              ${[
                ['Watering', id.careProfile.wateringFrequency],
                ['Light', id.careProfile.sunlight],
                ['Temp', id.careProfile.temperature],
              ].map(([l, v]) => v ? `<div class="care-preview-item"><span class="cp-label">${l}</span><span class="cp-value">${v}</span></div>` : '').join('')}
            </div>
            ${id.careProfile.notes ? `<p style="font-size:0.8rem;color:var(--text-muted);margin-top:8px;line-height:1.5">${id.careProfile.notes}</p>` : ''}
          </div>` : ''}
      </div>
      <div class="confirm-actions">
        <button class="btn-primary" onclick="navigate('plant-details-form')">Yes, that's it →</button>
        <button class="btn-secondary" onclick="state.pendingIdentification=null;navigate('plant-details-form')">No, enter manually</button>
      </div>
    </div>`;
}

// ============================================================
// SCREEN: PLANT DETAILS FORM
// ============================================================

function renderPlantDetailsForm() {
  const id = state.pendingIdentification;
  const isEditing = !!state.editingPlantId;

  const v = (field, fallback = '') => {
    if (id && id[field] !== undefined) return id[field] || fallback;
    return fallback;
  };

  const nickname = v('nickname', v('commonName', ''));
  const species = v('species', v('commonName', ''));
  const scientificName = v('scientificName', '');
  const location = v('location', 'indoor');
  const windowDirection = v('windowDirection', '');
  const potSize = v('potSize', '');
  const potType = v('potType', '');
  const microclimatNotes = v('microclimatNotes', '');

  const dirOpts = ['N','S','E','W',''].map(d => `
    <label class="radio-label">
      <input type="radio" name="windowDirection" value="${d}" ${windowDirection === d ? 'checked' : ''}> ${d || 'None'}
    </label>`).join('');

  const sizeOpts = ['', 'small', 'medium', 'large', 'extra large', 'in ground']
    .map(s => `<option value="${s}" ${potSize === s ? 'selected' : ''}>${s ? cap(s) : 'Select...'}</option>`).join('');

  const typeOpts = ['', 'terracotta', 'plastic', 'ceramic', 'fabric', 'in ground']
    .map(s => `<option value="${s}" ${potType === s ? 'selected' : ''}>${s ? cap(s) : 'Select...'}</option>`).join('');

  return `
    <div class="screen">
      <div class="screen-header">
        <button class="back-btn" onclick="${isEditing ? `navigate('plant','${state.editingPlantId}')` : "navigate('add-plant')"}">‹ Back</button>
        <h2 class="screen-title">${isEditing ? 'Edit Plant' : 'Plant Details'}</h2>
      </div>
      <form onsubmit="savePlantForm(event)" class="plant-form">
        <div class="form-group">
          <label class="form-label">Nickname *</label>
          <input class="form-input" name="nickname" value="${nickname}" placeholder="e.g. Big Monstera" required>
        </div>
        <div class="form-group">
          <label class="form-label">Species / Common Name *</label>
          <input class="form-input" name="species" value="${species}" placeholder="e.g. Monstera Deliciosa" required>
        </div>
        <div class="form-group">
          <label class="form-label">Scientific Name</label>
          <input class="form-input" name="scientificName" value="${scientificName}" placeholder="e.g. Monstera deliciosa">
        </div>
        <div class="form-group">
          <label class="form-label">Location *</label>
          <div class="radio-group">
            <label class="radio-label"><input type="radio" name="location" value="indoor" ${location === 'indoor' ? 'checked' : ''}> 🏠 Indoor</label>
            <label class="radio-label"><input type="radio" name="location" value="outdoor" ${location === 'outdoor' ? 'checked' : ''}> 🌳 Outdoor</label>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Window Direction (indoor)</label>
          <div class="radio-group">${dirOpts}</div>
        </div>
        <div class="form-group">
          <label class="form-label">Pot Size</label>
          <select class="form-input" name="potSize">${sizeOpts}</select>
        </div>
        <div class="form-group">
          <label class="form-label">Pot Type</label>
          <select class="form-input" name="potType">${typeOpts}</select>
        </div>
        <div class="form-group">
          <label class="form-label">Microclimate Notes</label>
          <input class="form-input" name="microclimatNotes" value="${microclimatNotes}" placeholder="e.g. near heater, gets afternoon draught">
        </div>
        ${!isEditing ? `
          <div class="form-group">
            <label class="form-label">Photo (optional)</label>
            <div class="photo-upload-area" id="form-photo-area" onclick="document.getElementById('form-photo-input').click()">
              ${state.pendingPlantPhoto
                ? `<img src="data:image/jpeg;base64,${state.pendingPlantPhoto}" class="form-photo-preview" alt="Plant">`
                : '<div class="photo-upload-placeholder">📷 Tap to add a photo</div>'}
            </div>
            <input type="file" id="form-photo-input" accept="image/*" capture="environment" style="display:none" onchange="handleFormPhoto(this)">
          </div>` : ''}
        <button type="submit" class="btn-primary">${isEditing ? 'Save Changes' : 'Add Plant'}</button>
      </form>
    </div>`;
}

async function handleFormPhoto(input) {
  if (!input.files[0]) return;
  const base64 = await compressImage(input.files[0]);
  state.pendingPlantPhoto = base64;
  const area = document.getElementById('form-photo-area');
  if (area) area.innerHTML = `<img src="data:image/jpeg;base64,${base64}" class="form-photo-preview" alt="Plant">`;
}

function savePlantForm(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const get = k => (fd.get(k) || '').trim();

  if (state.editingPlantId) {
    const p = state.plants.find(pl => pl.id === state.editingPlantId);
    if (p) {
      p.nickname = get('nickname');
      p.species = get('species');
      p.scientificName = get('scientificName');
      p.location = get('location');
      p.windowDirection = get('windowDirection');
      p.potSize = get('potSize');
      p.potType = get('potType');
      p.microclimatNotes = get('microclimatNotes');
    }
    const id = state.editingPlantId;
    state.editingPlantId = null;
    state.pendingIdentification = null;
    saveState();
    navigate('plant', id);
    showToast('✓ Plant updated');
  } else {
    const plant = {
      id: generateId(),
      nickname: get('nickname'),
      species: get('species'),
      scientificName: get('scientificName'),
      location: get('location'),
      windowDirection: get('windowDirection'),
      potSize: get('potSize'),
      potType: get('potType'),
      microclimatNotes: get('microclimatNotes'),
      photo: state.pendingPlantPhoto || null,
      dateAdded: new Date().toISOString(),
      lastWatered: null,
      lastFertilised: null,
    };
    state.plants.push(plant);
    state.pendingPlantPhoto = null;
    state.pendingIdentification = null;
    saveState();
    showToast(`🪴 ${plant.nickname} added!`);
    navigate('plant', plant.id);
  }
}

// ============================================================
// SCREEN: DIAGNOSE
// ============================================================

function renderDiagnose(plantId) {
  const p = state.plants.find(pl => pl.id === plantId);
  const hasProxy = !!state.settings.proxyUrl;
  return `
    <div class="screen">
      <div class="screen-header">
        <button class="back-btn" onclick="navigate('plant','${plantId}')">‹ ${p?.nickname || 'Plant'}</button>
        <h2 class="screen-title">Diagnose</h2>
      </div>
      ${!hasProxy
        ? `<div class="setup-notice">
            <strong>⚙️ AI not configured</strong>
            Diagnosis needs the Greenhouse AI proxy. Set it up in Settings.
            <br><button class="btn-sm" onclick="navigate('settings')" style="margin-top:10px">Go to Settings</button>
          </div>`
        : `<p class="diagnose-hint" style="margin-bottom:16px;font-size:0.87rem;color:var(--text-dim);line-height:1.6">
            Take a clear, close-up photo of the affected leaf or area. Claude will analyse it using ${p?.nickname || 'this plant'}'s full profile and your local conditions.
          </p>
          <div class="photo-upload-area large" id="diagnose-area" onclick="document.getElementById('diagnose-input').click()">
            <div class="photo-upload-placeholder">
              <div style="font-size:2.5rem">📷</div>
              <div style="margin-top:10px">Photograph the affected area</div>
            </div>
          </div>
          <input type="file" id="diagnose-input" accept="image/*" capture="environment" style="display:none" onchange="handleDiagnosePhoto(this,'${plantId}')">`
      }
    </div>`;
}

async function handleDiagnosePhoto(input, plantId) {
  if (!input.files[0]) return;
  const p = state.plants.find(pl => pl.id === plantId);

  const reader = new FileReader();
  reader.onload = e => {
    const area = document.getElementById('diagnose-area');
    if (area) area.innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover">`;
  };
  reader.readAsDataURL(input.files[0]);

  await new Promise(r => setTimeout(r, 600));
  document.getElementById('app').innerHTML = `
    <div class="screen loading-screen">
      <div class="loading-spinner">🔬</div>
      <p class="loading-text">Diagnosing${p ? ' ' + p.nickname : ''}...</p>
      <p class="loading-sub">Checking against plant profile and local conditions</p>
    </div>`;

  try {
    const base64 = await compressImage(input.files[0]);
    const result = await diagnosePlant(base64, p);
    renderDiagnoseResult(result, plantId);
  } catch (err) {
    showToast('Diagnosis failed — check your connection and try again.');
    navigate('diagnose', plantId);
  }
}

function renderDiagnoseResult(result, plantId) {
  const urgencyColor = { low: 'var(--green)', medium: 'var(--gold)', high: 'var(--red)' };

  document.getElementById('app').innerHTML = `
    <div class="screen">
      <div class="screen-header">
        <button class="back-btn" onclick="navigate('plant','${plantId}')">‹ Back</button>
        <h2 class="screen-title">Diagnosis</h2>
      </div>
      ${result.immediateAction ? `
        <div class="immediate-action">
          <div class="ia-label">Do this now</div>
          <div class="ia-text">${result.immediateAction}</div>
        </div>` : ''}
      <div class="diagnosis-list">
        ${(result.diagnoses || []).map((d, i) => `
          <div class="diagnosis-card${i === 0 ? ' diagnosis-primary' : ''}">
            <div class="diagnosis-header">
              <div class="diagnosis-condition">${d.condition}</div>
              <div class="diagnosis-confidence" style="color:${urgencyColor[d.urgency] || 'var(--gold)'}">
                ${d.confidence}% · ${d.urgency || '—'} urgency
              </div>
            </div>
            <p class="diagnosis-explanation">${d.explanation}</p>
            ${d.symptoms ? `<p class="diagnosis-symptoms"><strong>Signs:</strong> ${d.symptoms}</p>` : ''}
            <div class="diagnosis-fix">
              <div class="fix-label">How to fix it</div>
              <p class="fix-text">${d.fix}</p>
            </div>
          </div>`).join('')}
      </div>
      ${result.differentiating ? `
        <div class="differentiate-note">
          <strong>Telling the difference:</strong> ${result.differentiating}
        </div>` : ''}
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px">
        <button class="btn-primary" onclick="saveDiagnosis('${plantId}','${encodeURIComponent(result.diagnoses?.[0]?.condition || 'Diagnosis')}')">Save to history</button>
        <button class="btn-secondary" onclick="navigate('plant','${plantId}')">Back to plant</button>
      </div>
    </div>`;
}

function saveDiagnosis(plantId, conditionEncoded) {
  const condition = decodeURIComponent(conditionEncoded);
  state.logs.push({ id: generateId(), plantId, type: 'diagnosed', date: new Date().toISOString(), note: condition, photo: null });
  saveState();
  showToast('✓ Saved to plant history');
  navigate('plant', plantId);
}

// ============================================================
// SCREEN: CHAT
// ============================================================

function renderChat() {
  const plant = state.currentPlantId ? state.plants.find(p => p.id === state.currentPlantId) : null;
  const hasProxy = !!state.settings.proxyUrl;

  const suggestions = plant ? [
    'Why might the leaves be going yellow?',
    `Is it time to repot ${plant.nickname}?`,
    `What should I do with it this ${getSeason().toLowerCase()}?`,
  ] : [
    'Which of my plants need attention right now?',
    'Is it safe to water my outdoor plants today?',
    `What should I be doing in the garden this ${getSeason().toLowerCase()}?`,
  ];

  return `
    <div class="screen screen-chat">
      <div class="screen-header">
        <h2 class="screen-title">Ask Greenhouse</h2>
        ${plant ? `<div class="chat-context-pill">about ${plant.nickname}</div>` : ''}
        <button class="link-btn" onclick="clearChat()">Clear</button>
      </div>
      ${!hasProxy ? `<div class="setup-notice">
        <strong>⚙️ AI not configured</strong>
        Chat needs the Greenhouse AI proxy. Set it up in Settings.
        <br><button class="btn-sm" onclick="navigate('settings')" style="margin-top:10px">Go to Settings</button>
      </div>` : ''}
      <div class="chat-messages" id="chat-messages">
        ${state.chatHistory.length === 0
          ? `<div class="chat-welcome">
              <div class="chat-welcome-icon">🌿</div>
              <p>Hi! I'm Greenhouse. I know about your plants, the local conditions, and what's happening in the garden right now. What would you like to know?</p>
            </div>
            <div class="chat-suggestions">
              ${suggestions.map(s => `<button class="suggestion-chip" onclick="sendSuggestion(this)">${s}</button>`).join('')}
            </div>`
          : chatMessagesHtml()}
      </div>
      <div class="chat-input-row">
        <input class="chat-input" id="chat-input" placeholder="Ask anything about your plants…" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat()}">
        <button class="chat-send-btn" onclick="sendChat()">↑</button>
      </div>
    </div>`;
}

function chatMessagesHtml() {
  return state.chatHistory.map(m => `
    <div class="chat-message ${m.role === 'user' ? 'chat-user' : 'chat-ai'}">
      <div class="message-bubble">${m.content.replace(/\n/g, '<br>')}</div>
    </div>`).join('');
}

function sendSuggestion(btn) {
  const input = document.getElementById('chat-input');
  if (input) input.value = btn.textContent;
  sendChat();
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input?.value.trim();
  if (!text) return;
  if (!state.settings.proxyUrl) { showToast('Please configure your API proxy in Settings first.'); return; }
  input.value = '';

  const msgs = document.getElementById('chat-messages');
  msgs.innerHTML = chatMessagesHtml() + `
    <div class="chat-message chat-user"><div class="message-bubble">${text}</div></div>
    <div class="chat-message chat-ai" id="thinking"><div class="message-bubble thinking">🌿 thinking...</div></div>`;
  msgs.scrollTop = msgs.scrollHeight;

  try {
    await askGreenhouseAI(text);
    msgs.innerHTML = chatMessagesHtml();
    msgs.scrollTop = msgs.scrollHeight;
  } catch (err) {
    const t = document.getElementById('thinking');
    if (t) t.innerHTML = `<div class="message-bubble error">Sorry, I couldn't respond right now. Check your connection and API settings.</div>`;
  }
}

function clearChat() {
  state.chatHistory = [];
  state.currentPlantId = null;
  saveState();
  navigate('chat');
}

// ============================================================
// SCREEN: CALENDAR
// ============================================================

function renderCalendar() {
  const monthKey = new Date().toLocaleString('en-AU', { month: 'long', year: 'numeric' });
  const fresh = state.calendarContent && state.calendarMonth === monthKey;
  const hasProxy = !!state.settings.proxyUrl;

  return `
    <div class="screen">
      <div class="screen-header">
        <h2 class="screen-title">Garden Calendar</h2>
        <button class="link-btn" id="cal-btn" onclick="refreshCalendar()">${fresh ? 'Refresh' : 'Generate'}</button>
      </div>
      ${!hasProxy
        ? `<div class="setup-notice">
            <strong>⚙️ AI not configured</strong>
            The garden calendar is generated by Claude based on your plants and Tasmania's seasonal conditions.
            <br><button class="btn-sm" onclick="navigate('settings')" style="margin-top:10px">Go to Settings</button>
          </div>`
        : fresh
          ? renderCalendarContent(state.calendarContent)
          : `<div class="calendar-empty">
              <div style="font-size:2.5rem;margin-bottom:12px">📅</div>
              <p style="color:var(--text-dim);margin-bottom:20px;font-size:0.88rem;line-height:1.6">
                Generate your personalised <strong>${monthKey}</strong> garden plan — tailored to your specific plants and the Tamar Valley's conditions.
              </p>
              <button class="btn-primary" onclick="refreshCalendar()">Generate ${monthKey} tasks</button>
            </div>`}
    </div>`;
}

function renderCalendarContent(cal) {
  const priorityColor = { essential: 'var(--green)', recommended: 'var(--gold)', optional: 'var(--text-muted)' };
  const catIcon = {
    'Watering':'💧','Feeding':'🌿','Pruning':'✂️','Pest & Disease':'🔬',
    'Propagation':'🌱','Seasonal Prep':'🌡️','General':'📋',
  };
  return `
    <div class="calendar-content">
      <div class="cal-header">
        <div class="cal-month">${cal.month}</div>
        <div class="cal-season">🍂 ${cal.season}</div>
      </div>
      ${cal.summary ? `<p class="cal-summary">${cal.summary}</p>` : ''}
      ${cal.tasmaniaNote ? `<div class="tasmania-note">🗺️ ${cal.tasmaniaNote}</div>` : ''}
      <div class="task-list">
        ${(cal.tasks || []).map(t => `
          <div class="task-card">
            <div class="task-header">
              <span class="task-category">${catIcon[t.category] || '📋'} ${t.category}</span>
              <span class="task-priority" style="color:${priorityColor[t.priority] || 'var(--text-muted)'}">${t.priority}</span>
            </div>
            <p class="task-desc">${t.task}</p>
            ${t.plants?.length ? `<div class="task-plants">${t.plants.join(', ')}</div>` : ''}
            ${t.timing ? `<div class="task-timing">⏱ ${t.timing}</div>` : ''}
          </div>`).join('')}
      </div>
    </div>`;
}

async function refreshCalendar() {
  if (!state.settings.proxyUrl) { showToast('Please configure your API proxy in Settings first.'); return; }
  const btn = document.getElementById('cal-btn');
  if (btn) { btn.textContent = 'Generating…'; btn.disabled = true; }

  try {
    const result = await generateCalendarTasks(state.plants);
    state.calendarContent = result;
    state.calendarMonth = new Date().toLocaleString('en-AU', { month: 'long', year: 'numeric' });
    saveState();
    navigate('calendar');
  } catch (err) {
    showToast('Could not generate calendar — check your API settings.');
    if (btn) { btn.textContent = 'Refresh'; btn.disabled = false; }
  }
}

// ============================================================
// SCREEN: SETTINGS
// ============================================================

function renderSettings() {
  const { proxyUrl, locationLat, locationLng, locationName } = state.settings;
  return `
    <div class="screen">
      <div class="screen-header">
        <h2 class="screen-title">Settings</h2>
      </div>

      <div class="settings-section">
        <h3 class="settings-heading">AI Connection</h3>
        <p class="settings-sub">Greenhouse uses Claude AI via a Cloudflare Worker proxy. <a href="#" onclick="showProxyHelp();return false" style="color:var(--blue-light)">Setup guide →</a></p>
        <div class="form-group" style="margin-bottom:12px">
          <label class="form-label">Proxy URL</label>
          <input class="form-input" id="proxy-input" type="url" value="${proxyUrl}" placeholder="https://your-worker.workers.dev">
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <button class="btn-primary" onclick="saveProxy()">Save</button>
          <button class="btn-secondary" id="test-btn" onclick="testConnection()">Test connection</button>
          <span id="test-result" style="font-size:0.82rem"></span>
        </div>
        ${!proxyUrl ? `
          <div class="proxy-setup-steps">
            <div class="setup-step-title">Quick setup</div>
            <ol class="setup-steps">
              <li>Sign up at <a href="https://workers.cloudflare.com" target="_blank" style="color:var(--blue-light)">workers.cloudflare.com</a> (free)</li>
              <li>Create a new Worker and paste in <code>worker.js</code> from this folder</li>
              <li>Add your Anthropic API key as a secret named <code>ANTHROPIC_API_KEY</code></li>
              <li>Deploy and paste the worker URL above</li>
            </ol>
          </div>` : ''}
      </div>

      <div class="settings-section">
        <h3 class="settings-heading">Location</h3>
        <p class="settings-sub">Used for weather data and care advice.</p>
        ${locationLat
          ? `<p class="settings-value">📍 ${locationName || `${locationLat.toFixed(2)}°, ${locationLng.toFixed(2)}°`}</p>
             <button class="btn-secondary" onclick="resetLocation()">Reset location</button>`
          : `<button class="btn-primary" onclick="requestLocation()">Enable location</button>`}
      </div>

      <div class="settings-section">
        <h3 class="settings-heading">Data</h3>
        <div style="display:flex;flex-direction:column;gap:10px">
          <button class="btn-secondary" onclick="exportData()">Export backup (JSON)</button>
          <button class="btn-secondary" onclick="document.getElementById('import-input').click()">Import backup (JSON)</button>
          <input type="file" id="import-input" accept=".json" style="display:none" onchange="importData(this)">
          <button class="delete-btn" onclick="clearAllData()">Clear all data</button>
        </div>
      </div>

      <div class="settings-section" style="text-align:center">
        <p class="settings-sub">Greenhouse v${APP_VERSION} · Built for Tasmania 🌿</p>
      </div>
    </div>`;
}

function saveProxy() {
  state.settings.proxyUrl = document.getElementById('proxy-input').value.trim();
  saveState();
  showToast('✓ Proxy URL saved');
}

async function testConnection() {
  const btn = document.getElementById('test-btn');
  const result = document.getElementById('test-result');
  btn.disabled = true; btn.textContent = 'Testing…';
  result.textContent = ''; result.style.color = '';
  try {
    const r = await callClaude([{ role: 'user', content: 'Reply with the single word: connected' }]);
    result.textContent = '✓ Connected!'; result.style.color = 'var(--green)';
  } catch (e) {
    result.textContent = '✗ ' + e.message; result.style.color = 'var(--red)';
  }
  btn.disabled = false; btn.textContent = 'Test connection';
}

async function requestLocation() {
  try {
    const pos = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000 }));
    state.settings.locationLat = pos.coords.latitude;
    state.settings.locationLng = pos.coords.longitude;
    state.settings.locationName = '';
    state.weatherFetched = false;
    saveState();
    showToast('✓ Location saved');
    navigate('settings');
  } catch (_) {
    showToast('Could not get location. Check browser permissions.');
  }
}

function resetLocation() {
  state.settings.locationLat = null;
  state.settings.locationLng = null;
  state.settings.locationName = '';
  state.weather = null;
  state.weatherFetched = false;
  saveState();
  navigate('settings');
}

function exportData() {
  const json = JSON.stringify({ plants: state.plants, logs: state.logs, exportedAt: new Date().toISOString() }, null, 2);
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([json], { type: 'application/json' })),
    download: `greenhouse-backup-${new Date().toISOString().slice(0,10)}.json`,
  });
  a.click();
}

async function importData(input) {
  if (!input.files[0]) return;
  try {
    const data = JSON.parse(await input.files[0].text());
    if (data.plants) state.plants = data.plants;
    if (data.logs) state.logs = data.logs;
    saveState();
    showToast(`✓ Imported ${state.plants.length} plants`);
    navigate('home');
  } catch (_) {
    showToast('Invalid backup file');
  }
}

function clearAllData() {
  if (!confirm('Clear all plants, logs, and chat history? This cannot be undone.')) return;
  Object.assign(state, { plants: [], logs: [], chatHistory: [], calendarContent: null, calendarMonth: null });
  saveState();
  navigate('home');
}

function showProxyHelp() {
  alert(`Greenhouse AI Setup\n\n1. Go to workers.cloudflare.com and sign up (free)\n2. Create a new Worker\n3. Paste the code from worker.js (included in this folder)\n4. Add a secret named ANTHROPIC_API_KEY with your key from console.anthropic.com\n5. Deploy and copy the worker URL here\n\nThe worker acts as a safe proxy so your API key is never exposed in the browser.`);
}

// ============================================================
// TOAST
// ============================================================

function showToast(msg) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('toast-visible')));
  setTimeout(() => { t.classList.remove('toast-visible'); setTimeout(() => t.remove(), 300); }, 2600);
}

// ============================================================
// INIT
// ============================================================

loadState();
fetchWeather();
navigate('home');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
