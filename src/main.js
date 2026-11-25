import { io } from 'socket.io-client';
const SERVER_URL =
  window.location.hostname === 'localhost' ||
  window.location.hostname.startsWith('192.168.') ||
  window.location.hostname.startsWith('10.')
    ? undefined
    : 'https://autumn-street-rod.onrender.com';

const socket = io(SERVER_URL);

import './style.css';
import { INITIAL_STATE, CARS, PARTS, OPPONENTS } from './data/gameData.js';
import { RaceEngine } from './race/RaceEngine.js';

let state = JSON.parse(localStorage.getItem('autumn_rod_save')) || structuredClone(INITIAL_STATE);
const save = () => localStorage.setItem('autumn_rod_save', JSON.stringify(state));

const screenEl = document.getElementById('screen-container');
const topBar = document.getElementById('top-bar');
const raceHud = document.getElementById('race-hud');
let currentScreen = 'garage';

const engine = new RaceEngine(document.getElementById('race-canvas'), (won, opponent) => {
  raceHud.classList.add('hidden');
  topBar.classList.remove('hidden');
  screenEl.classList.remove('hidden');

  if (won) {
    state.money += opponent.bet;
    alert(`NYERTÉL ${opponent.name} ellen! +$${opponent.bet}`);
  } else {
    state.money = Math.max(0, state.money - Math.round(opponent.bet / 2));
    alert(`VESZTETTÉL ${opponent.name} ellen! -$${Math.round(opponent.bet / 2)}`);
  }
  save();
  renderScreen('diner');
});

function getStats() {
  const base = { ...CARS[state.carId].baseStats };
  Object.values(state.equippedParts).forEach((partId) => {
    const p = PARTS.find((x) => x.id === partId);
    if (p) Object.entries(p.bonus).forEach(([k, v]) => (base[k] = (base[k] || 0) + v));
  });
  return base;
}

function updateTopBar() {
  document.getElementById('ui-money').textContent = `$${state.money.toLocaleString()}`;
  document.getElementById('ui-car-name').textContent = CARS[state.carId].name;
  document.querySelectorAll('#top-bar nav button').forEach((btn) => {
    btn.classList.toggle('active-tab', btn.dataset.screen === currentScreen);
  });
}

function renderScreen(name) {
  currentScreen = name;
  updateTopBar();

  if (name === 'garage') {
    const s = getStats();
    screenEl.style.backgroundImage = "url('/images/garage.jpg'), var(--bg-grad)";
    screenEl.innerHTML = `
      <div class="card" style="max-width:440px; margin:0 auto;">
        <h2>Garázs – ${CARS[state.carId].name}</h2>
        <div class="stat-row"><span>Gyorsulás</span><b>${s.accel}</b></div>
        <div class="stat-row"><span>Végsebesség</span><b>${Math.round(s.topSpeed * 3.6)} km/h</b></div>
        <div class="stat-row"><span>Tapadás</span><b>${s.grip}</b></div>
        <div class="stat-row"><span>Karosszéria</span><b>${Math.round(s.armor * 100)}%</b></div>
      </div>`;
  } else if (name === 'shop') {
    screenEl.style.backgroundImage = "url('/images/shop.jpg'), var(--bg-grad)";
    screenEl.innerHTML = `<div class="grid">${PARTS.map((p) => {
      const owned = state.ownedParts.includes(p.id);
      const eq = state.equippedParts[p.slot] === p.id;
      return `<div class="card">
        <h3>${p.name}</h3>
        <p>${p.desc}</p>
        <p>Ár: <b>$${p.price}</b></p>
        <button class="${eq ? '' : 'primary'}" data-buy="${p.id}">
          ${eq ? 'Felszerelve' : owned ? 'Felszerelés' : 'Megvétel'}
        </button>
      </div>`;
    }).join('')}</div>`;
  } else if (name === 'diner') {
    screenEl.style.backgroundImage = "url('/images/diner.jpg'), var(--bg-grad)";
    screenEl.innerHTML = `
      <div class="card" style="max-width:960px; margin:0 auto 16px auto;">
        <h3>Online 1v1 (PC vs. Telefon)</h3>
        <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
          <button class="primary" id="btn-mp-drag">Szoba: Gyorsulás</button>
          <button class="primary" id="btn-mp-circuit">Szoba: Kanyargós</button>
          <input id="mp-code-input" type="tel" maxlength="4" placeholder="4 jegyű kód"
                 style="height:44px; width:130px; padding:0 12px; border-radius:8px; border:2px solid var(--amber); background:#182230; color:#fff; font-size:16px; font-weight:700;">
          <button id="btn-mp-join">Csatlakozás</button>
          <span id="mp-status" style="color:var(--amber); font-weight:700;"></span>
        </div>
      </div>
      <div class="grid">${OPPONENTS.map((o) => `
        <div class="card">
          <h3>${o.name}</h3>
          <p>${o.car} · ${o.mode === 'circuit' ? 'Városi kör' : o.distance + ' m gyorsulás'}</p>
          <p>Tét: <b>$${o.bet}</b></p>
          <button class="primary" data-race="${o.id}">Kihívás</button>
        </div>`).join('')}</div>`;
  }
}

screenEl.addEventListener('click', (e) => {
  const buyId = e.target.dataset.buy;
  if (buyId) {
    const p = PARTS.find((x) => x.id === buyId);
    if (!state.ownedParts.includes(buyId)) {
      if (state.money < p.price) return alert('Nincs elég pénzed!');
      state.money -= p.price;
      state.ownedParts.push(buyId);
    }
    state.equippedParts[p.slot] = buyId;
    save();
    renderScreen('shop');
  }
  if (e.target.id === 'btn-mp-drag') {
    socket.emit('create_room', { mode: 'drag', track: null, carModel: CARS[state.carId].modelUrl });
  }
  if (e.target.id === 'btn-mp-circuit') {
    socket.emit('create_room', { mode: 'circuit', track: 'downtown', carModel: CARS[state.carId].modelUrl });
  }
  if (e.target.id === 'btn-mp-join') {
    const code = document.getElementById('mp-code-input').value.trim();
    if (code.length === 4) socket.emit('join_room', { code, carModel: CARS[state.carId].modelUrl });
  }
  
  const raceId = e.target.dataset.race;
  if (raceId) {
    const opp = OPPONENTS.find((x) => x.id === raceId);
    topBar.classList.add('hidden');
    screenEl.classList.add('hidden');
    raceHud.classList.remove('hidden');
    engine.start(getStats(), CARS[state.carId].modelUrl, opp);
  }
});

document.getElementById('btn-exit-race').addEventListener('click', () => {
  engine.stop();
  raceHud.classList.add('hidden');
  topBar.classList.remove('hidden');
  screenEl.classList.remove('hidden');
  renderScreen('diner');
});

document.querySelectorAll('#top-bar nav button').forEach((btn) =>
  btn.addEventListener('click', () => renderScreen(btn.dataset.screen))
);

socket.on('room_created', ({ code }) => {
  const el = document.getElementById('mp-status');
  if (el) el.textContent = `Szobakód: ${code} – Várakozás a másik játékosra...`;
});

socket.on('room_error', (msg) => alert(msg));

socket.on('match_start', ({ code, slot, mode, track, oppCarModel }) => {
  const mpOpponent = {
    name: 'Élő Ellenfél',
    modelUrl: oppCarModel,
    mode,
    track,
    laps: 1,
    distance: 450,
    bet: 500
  };
  topBar.classList.add('hidden');
  screenEl.classList.add('hidden');
  raceHud.classList.remove('hidden');
  engine.start(getStats(), CARS[state.carId].modelUrl, mpOpponent, { socket, code, slot });
});

socket.on('race_over', ({ winnerId }) => {
  if (!engine.running) return;
  engine.stop();
  raceHud.classList.add('hidden');
  topBar.classList.remove('hidden');
  screenEl.classList.remove('hidden');
  const won = winnerId === socket.id;
  if (won) {
    state.money += 500;
    alert('NYERTÉL az élő ellenfél ellen! +$500');
  } else {
    alert('Most a másik játékos volt gyorsabb!');
  }
  save();
  renderScreen('diner');
});

socket.on('opp_left', () => {
  if (!engine.running) return;
  engine.stop();
  raceHud.classList.add('hidden');
  topBar.classList.remove('hidden');
  screenEl.classList.remove('hidden');
  alert('Az ellenfél kilépett a futamból.');
  renderScreen('diner');
});

renderScreen('garage');
