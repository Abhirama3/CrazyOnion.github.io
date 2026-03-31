/* ═══════════════════════════════════════════════
   DARPANA — app.js
   All dashboard logic lives here.

   HOW THIS FILE IS ORGANISED:
   1. Credentials
   2. Login / Logout
   3. Clock
   4. MQTT Connection & Real Sensor Data
   5. Sparkline chart
   6. Toggle handlers (door, relays)
   7. PIR intrusion alerts
   8. System event log
   9. Initialisation
═══════════════════════════════════════════════ */


/* ══════════════════════════════════
   1. CREDENTIALS
══════════════════════════════════ */
const USERS = {
  admin:    'darpana123',
  operator: 'op9999'
};


/* ══════════════════════════════════
   2. LOGIN / LOGOUT
══════════════════════════════════ */
document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('inp-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('inp-user').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('inp-pass').focus(); });
document.getElementById('logout-btn').addEventListener('click', doLogout);

function doLogin() {
  const username = document.getElementById('inp-user').value.trim();
  const password = document.getElementById('inp-pass').value;
  const errorEl  = document.getElementById('login-error');

  if (USERS[username] && USERS[username] === password) {
    document.getElementById('login-screen').style.display = 'none';
    const db = document.getElementById('dashboard');
    db.style.display = 'flex';
    db.style.flexDirection = 'column';
    initDashboard();
  } else {
    errorEl.textContent = '⚠  ACCESS DENIED — invalid credentials';
    document.getElementById('inp-pass').value = '';
  }
}

function doLogout() {
  // Disconnect MQTT cleanly on logout
  if (mqttClient) mqttClient.end();
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('inp-user').value = '';
  document.getElementById('inp-pass').value = '';
  document.getElementById('login-error').textContent = '';
  clearInterval(clockTimer);
  clearInterval(uptimeTimer);
}


/* ══════════════════════════════════
   3. CLOCK
══════════════════════════════════ */
let clockTimer;

function startClock() {
  function tick() {
    document.getElementById('clock').textContent =
      new Date().toLocaleTimeString('en-GB');
  }
  tick();
  clockTimer = setInterval(tick, 1000);
}


/* ══════════════════════════════════
   4. MQTT CONNECTION & REAL SENSOR DATA

   This replaces the old simulated random data.
   ESP32 publishes to these topics:
     home/dht22/temperature  →  e.g. "28.5"
     home/dht22/humidity     →  e.g. "65.2"
     home/pir/motion         →  "1" (motion) or "0" (clear)

   Dashboard subscribes and updates UI automatically.
══════════════════════════════════ */

// HiveMQ public broker — free, no account needed
// Uses WebSocket (wss) because browsers cannot use raw MQTT
const MQTT_BROKER = 'wss://broker.hivemq.com:8884/mqtt';

// MQTT topics — must match exactly what ESP32 publishes to
const TOPIC_TEMP   = 'home/dht22/temperature';
const TOPIC_HUM    = 'home/dht22/humidity';
const TOPIC_PIR    = 'home/pir/motion';

let mqttClient;
let tempHistory = Array(20).fill(null); // stores last 20 temperature readings

function connectMQTT() {
  setMQTTStatus('connecting');

  mqttClient = mqtt.connect(MQTT_BROKER, {
    clientId: 'darpana_dashboard_' + Math.random().toString(16).slice(2, 8),
    clean: true,
    reconnectPeriod: 5000  // auto-reconnect every 5 seconds if disconnected
  });

  // Successfully connected to broker
  mqttClient.on('connect', () => {
    setMQTTStatus('connected');
    addLogEntry('dot-green', 'MQTT', 'Connected to broker. Waiting for ESP32 data...');

    // Subscribe to all ESP32 sensor topics
    mqttClient.subscribe(TOPIC_TEMP);
    mqttClient.subscribe(TOPIC_HUM);
    mqttClient.subscribe(TOPIC_PIR);
  });

  // Message received from ESP32
  mqttClient.on('message', (topic, message) => {
    const val = message.toString();

    if (topic === TOPIC_TEMP) {
      const temp = parseFloat(val);
      if (!isNaN(temp)) updateTemperature(temp);
    }
    else if (topic === TOPIC_HUM) {
      const hum = parseFloat(val);
      if (!isNaN(hum)) updateHumidity(hum);
    }
    else if (topic === TOPIC_PIR) {
      if (val === '1' && !pirAlarmed) triggerPIRAlert();
      if (val === '0' && pirAlarmed)  clearPIRAlert();
    }
  });

  // Connection lost
  mqttClient.on('disconnect', () => {
    setMQTTStatus('disconnected');
    addLogEntry('dot-red', 'MQTT', 'Disconnected from broker.');
  });

  // Connection error
  mqttClient.on('error', (err) => {
    setMQTTStatus('disconnected');
    addLogEntry('dot-red', 'MQTT', 'Error: ' + err.message);
  });

  // Trying to reconnect
  mqttClient.on('reconnect', () => {
    setMQTTStatus('connecting');
  });
}

// Updates the MQTT status indicator in the top bar
function setMQTTStatus(state) {
  const el = document.getElementById('mqtt-status');
  if (state === 'connected') {
    el.textContent = '⬤ ESP32 LIVE';
    el.style.color = 'var(--c-green)';
  } else if (state === 'connecting') {
    el.textContent = '⬤ CONNECTING';
    el.style.color = 'var(--c-amber)';
  } else {
    el.textContent = '⬤ OFFLINE';
    el.style.color = 'var(--c-red)';
  }
}

// Called when a new temperature value arrives from ESP32
function updateTemperature(temp) {
  document.getElementById('stat-temp').innerHTML = temp + '<span class="stat-unit">°C</span>';
  document.getElementById('clim-temp').textContent = temp + '°';

  // Add to sparkline history, drop oldest
  tempHistory.push(temp);
  tempHistory.shift();

  // Only draw sparkline once we have real data
  const realData = tempHistory.filter(v => v !== null);
  if (realData.length > 1) drawSparkline('spark-temp', realData, '#00c8e0');
}

// Called when a new humidity value arrives from ESP32
function updateHumidity(hum) {
  document.getElementById('stat-hum').innerHTML = hum + '<span class="stat-unit">%</span>';
  document.getElementById('clim-hum').textContent = hum + '%';
}


/* ══════════════════════════════════
   5. SPARKLINE CHART
══════════════════════════════════ */
function drawSparkline(canvasId, dataArray, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const W = canvas.offsetWidth || 340;
  const H = 48;
  canvas.width  = W;
  canvas.height = H;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const min   = Math.min(...dataArray);
  const max   = Math.max(...dataArray);
  const range = max - min || 1;
  const n     = dataArray.length;

  const pts = dataArray.map((v, i) => ({
    x: (i / (n - 1)) * W,
    y: H - ((v - min) / range) * (H - 8) - 4
  }));

  // Fill
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fillStyle = color + '18';
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.5;
  ctx.stroke();
}


/* ══════════════════════════════════
   6. TOGGLE HANDLERS
══════════════════════════════════ */

// Door lock
document.getElementById('tog-door').addEventListener('change', function () {
  const unlocked = this.checked;
  document.getElementById('lbl-door').textContent     = unlocked ? 'UNLOCKED' : 'LOCKED';
  document.getElementById('lbl-door').style.color     = unlocked ? 'var(--c-green)' : 'var(--c-amber)';
  document.getElementById('lock-icon').textContent    = unlocked ? '🔓' : '🔒';
  document.getElementById('lock-state').textContent   = unlocked ? 'UNLOCKED' : 'LOCKED';
  document.getElementById('lock-state').style.color   = unlocked ? 'var(--c-green)' : 'var(--c-amber)';
  document.getElementById('lock-sub').textContent     = unlocked ? 'Remote override active' : 'Door secured';
  document.getElementById('stat-door').textContent    = unlocked ? 'OPEN' : 'LOCKED';
  addLogEntry(unlocked ? 'dot-amber' : 'dot-green', 'DOOR / SYS-002',
    unlocked ? 'Remote override — door unlocked.' : 'Door re-locked via dashboard.');
});

// OTP reveal
const OTP_VALUE = generateOTP();
document.getElementById('otp-btn').addEventListener('click', function () {
  const display = document.getElementById('otp-code');
  if (display.textContent === '••••••') {
    display.textContent = OTP_VALUE;
    this.textContent = 'HIDE CODE';
    addLogEntry('dot-amber', 'DOOR / SYS-002', 'OTP code revealed by operator.');
  } else {
    display.textContent = '••••••';
    this.textContent = 'REVEAL CODE';
  }
});

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Relay 1
document.getElementById('tog-r1').addEventListener('change', function () {
  const on = this.checked;
  document.getElementById('lbl-r1').textContent = on ? 'ON' : 'OFF';
  document.getElementById('lbl-r1').style.color = on ? 'var(--c-cyan)' : '';
  updateDeviceCount();
  addLogEntry(on ? 'dot-green' : 'dot-amber', 'RELAY-1 / SYS-004',
    on ? 'LED / Light 1 turned ON.' : 'LED / Light 1 turned OFF.');
});

// Relay 2
document.getElementById('tog-r2').addEventListener('change', function () {
  const on = this.checked;
  document.getElementById('lbl-r2').textContent = on ? 'ON' : 'OFF';
  document.getElementById('lbl-r2').style.color = on ? 'var(--c-cyan)' : '';
  updateDeviceCount();
  addLogEntry(on ? 'dot-green' : 'dot-amber', 'RELAY-2 / SYS-004',
    on ? 'Motor / Fan turned ON.' : 'Motor / Fan turned OFF.');
});

function updateDeviceCount() {
  const active = [
    document.getElementById('tog-r1'),
    document.getElementById('tog-r2')
  ].filter(t => t.checked).length;
  document.getElementById('dev-active').textContent = active;
}


/* ══════════════════════════════════
   7. PIR INTRUSION ALERTS
   Now triggered automatically by MQTT
   when ESP32 sends "1" to home/pir/motion
══════════════════════════════════ */
let pirAlarmed = false;

document.getElementById('pir-test-btn').addEventListener('click', triggerPIRAlert);
document.getElementById('notif-close').addEventListener('click', clearPIRAlert);

function triggerPIRAlert() {
  pirAlarmed = true;

  document.getElementById('notif-banner').classList.add('visible');
  document.getElementById('notif-text').textContent =
    '⚠  Motion detected! PIR sensor triggered at ' + new Date().toLocaleTimeString('en-GB');

  document.getElementById('pir-stat-card').classList.add('alarmed');
  document.getElementById('stat-pir').textContent     = 'MOTION';
  document.getElementById('stat-pir-sub').textContent = 'Alert triggered!';

  document.getElementById('pir-ring').classList.add('alarmed');
  const stateEl = document.getElementById('pir-state');
  stateEl.textContent = 'MOTION';
  stateEl.classList.add('alarmed');

  const log = document.getElementById('pir-log');
  const row = document.createElement('div');
  row.className = 'ev-row';
  row.innerHTML = `
    <div class="ev-dot dot-red"></div>
    <div class="ev-time">${new Date().toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'})}</div>
    <div class="ev-msg">⚠ Motion detected! Intrusion alert fired.</div>
  `;
  log.prepend(row);

  addLogEntry('dot-red', 'PIR / SYS-003', 'INTRUSION ALERT — motion detected!');
}

function clearPIRAlert() {
  pirAlarmed = false;
  document.getElementById('notif-banner').classList.remove('visible');
  document.getElementById('pir-stat-card').classList.remove('alarmed');
  document.getElementById('stat-pir').textContent     = 'CLEAR';
  document.getElementById('stat-pir-sub').textContent = 'No motion detected';
  document.getElementById('pir-ring').classList.remove('alarmed');
  const stateEl = document.getElementById('pir-state');
  stateEl.textContent = 'CLEAR';
  stateEl.classList.remove('alarmed');
  addLogEntry('dot-green', 'PIR / SYS-003', 'Alert dismissed by operator.');
}


/* ══════════════════════════════════
   8. SYSTEM EVENT LOG
══════════════════════════════════ */
const MAX_LOG_ROWS = 8;

function addLogEntry(dotClass, system, message) {
  const logEl = document.getElementById('sys-log');
  const time  = new Date().toLocaleTimeString('en-GB');

  const row = document.createElement('div');
  row.className = 'log-row';
  row.innerHTML = `
    <div class="log-dot ${dotClass}"></div>
    <div class="log-time">${time}</div>
    <div class="log-sys">${system}</div>
    <div class="log-msg">${message}</div>
  `;

  logEl.prepend(row);

  while (logEl.children.length > MAX_LOG_ROWS) {
    logEl.removeChild(logEl.lastChild);
  }
}


/* ══════════════════════════════════
   UPTIME COUNTER
══════════════════════════════════ */
let uptimeTimer;
let uptimeSeconds = 0;

function startUptime() {
  uptimeTimer = setInterval(() => {
    uptimeSeconds++;
    const m = String(Math.floor(uptimeSeconds / 60)).padStart(2, '0');
    const s = String(uptimeSeconds % 60).padStart(2, '0');
    document.getElementById('dev-uptime').textContent = m + ':' + s;
  }, 1000);
}


/* ══════════════════════════════════
   9. INITIALISATION
══════════════════════════════════ */
function initDashboard() {
  startClock();
  connectMQTT();   // connects to broker and subscribes to ESP32 topics
  startUptime();

  addLogEntry('dot-green', 'SYSTEM',            'DARPANA dashboard initialised.');
  addLogEntry('dot-green', 'CLIMATE / SYS-001', 'Waiting for DHT22 data from ESP32...');
  addLogEntry('dot-green', 'DOOR / SYS-002',    'Servo + keypad system ready.');
  addLogEntry('dot-green', 'PIR / SYS-003',     'Intrusion monitoring armed.');
  addLogEntry('dot-green', 'RELAY / SYS-004',   'Device control online. 0/2 active.');
}
