/**
 * ESP-01 Local Automation Server - Vanilla JS WebSocket Engine
 */

let socket = null;
let firebaseApp = null;
let firebaseDb = null;
let reconnectInterval = 1000;
const maxReconnectInterval = 10000;
let isLedOn = false;

// DOM Elements
const statusPill = document.getElementById('status-pill');
const statusText = document.getElementById('status-text');
const cloudPill = document.getElementById('cloud-pill');
const cloudText = document.getElementById('cloud-text');
const valUptime = document.getElementById('val-uptime');
const valHeap = document.getElementById('val-heap');
const valClients = document.getElementById('val-clients');
const btnLed = document.getElementById('btn-led');
const ledStateText = document.getElementById('led-state-text');
const consoleLog = document.getElementById('console-log');
const sensorContainer = document.getElementById('sensor-container');

// Connect WebSocket & MQTT Cloud on page load
window.addEventListener('DOMContentLoaded', () => {
    connectWebSocket();
    connectFirebaseCloud();
});

function connectFirebaseCloud() {
    if (typeof firebase === 'undefined') {
        updateCloudStatus('disconnected', 'Cloud Offline');
        return;
    }

    // IMPORTANT: The user must paste their API Key and Database URL here
    const firebaseConfig = {
        apiKey: "AIzaSyBlPvWL2ljiPY5UdFukQQjfkH82ep-fft4",
        databaseURL: "https://studio-3020558911-5e45b-default-rtdb.firebaseio.com",
        projectId: "studio-3020558911-5e45b"
    };

    if (firebaseConfig.apiKey === "YOUR_FIREBASE_API_KEY") {
        updateCloudStatus('disconnected', 'Cloud Not Configured');
        logEvent('system', 'Firebase is not configured. Please add your credentials in app.js.');
        return;
    }

    updateCloudStatus('connecting', 'Cloud Syncing...');
    logEvent('system', 'Connecting to Firebase Realtime Database...');

    try {
        firebaseApp = firebase.initializeApp(firebaseConfig);
        firebaseDb = firebase.database();

        updateCloudStatus('connected', 'Cloud Online');
        logEvent('system', 'Connected to Firebase! Listening for telemetry...');

        // Listen for telemetry updates
        const telemetryRef = firebaseDb.ref('/esp01/telemetry');
        telemetryRef.on('value', (snapshot) => {
            const dataStr = snapshot.val();
            if (dataStr) {
                try {
                    const data = JSON.parse(dataStr);
                    handleIncomingMessage(data);
                } catch (e) {
                    // Ignore parse errors
                }
            }
        });
    } catch (e) {
        updateCloudStatus('disconnected', 'Cloud Error');
        console.error(e);
    }
}

function updateCloudStatus(stateClass, labelText) {
    if (cloudPill && cloudText) {
        cloudPill.className = `status-pill status-${stateClass}`;
        cloudText.innerText = labelText;
    }
}

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Port 81 for WebSockets, or current host if running on port 81 directly
    const host = window.location.hostname || '192.168.4.1';
    const wsUrl = `${protocol}//${host}:81/`;

    updateStatus('connecting', 'Connecting...');
    logEvent('system', `Connecting to WebSocket at ${wsUrl}`);

    try {
        socket = new WebSocket(wsUrl);

        socket.onopen = () => {
            updateStatus('connected', 'Connected');
            logEvent('system', 'WebSocket connection established');
            reconnectInterval = 1000; // Reset reconnect backoff
            
            // Sync browser real-time clock to ESP-01 RTC
            const nowEpoch = Math.floor(Date.now() / 1000);
            sendCommand('time_sync', nowEpoch.toString());

            requestTelemetry();
        };

        socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleIncomingMessage(data);
            } catch (err) {
                logEvent('rx', `RAW RX: ${event.data}`);
            }
        };

        socket.onclose = (event) => {
            updateStatus('disconnected', 'Disconnected');
            logEvent('error', `WebSocket closed. Reconnecting in ${reconnectInterval / 1000}s...`);
            scheduleReconnect();
        };

        socket.onerror = (err) => {
            updateStatus('disconnected', 'Error');
            logEvent('error', 'WebSocket encountered an error.');
            socket.close();
        };

    } catch (e) {
        logEvent('error', `Socket creation failed: ${e.message}`);
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    setTimeout(() => {
        reconnectInterval = Math.min(reconnectInterval * 1.5, maxReconnectInterval);
        connectWebSocket();
    }, reconnectInterval);
}

function updateStatus(stateClass, labelText) {
    statusPill.className = `status-pill status-${stateClass}`;
    statusText.innerText = labelText;
}

function handleIncomingMessage(data) {
    if (data.type === 'telemetry') {
        valUptime.innerText = `${data.uptime}s`;
        valHeap.innerText = `${(data.freeHeap / 1024).toFixed(1)} KB`;
        valClients.innerText = data.clients;
        
        if (data.led !== undefined) {
            updateLedUI(data.led);
        }

        if (data.schedule) {
            syncScheduleFromTelemetry(data.schedule);
        }

        if (data.wifi) {
            syncWifiStatusUI(data.wifi);
        }

        // Render custom sensor telemetry if present
        renderSensorTelemetry(data);
    } 
    else if (data.type === 'ack') {
        logEvent('rx', `ACK received for command: ${data.command}`);
        if (data.led !== undefined) {
            updateLedUI(data.led);
        }
    }
    else if (data.type === 'wifi_scan') {
        renderWifiScanResults(data.networks);
    }
    else if (data.type === 'wifi_result') {
        if (data.success) {
            logEvent('system', `WiFi connected to: ${data.ssid}`);
        } else {
            logEvent('error', `WiFi failed to connect to: ${data.ssid}`);
        }
    }
    else if (data.type === 'wifi_status') {
        syncWifiStatusUI(data.wifi);
    }
    else if (data.type === 'system') {
        logEvent('system', `Server: ${data.status} (Client ID: ${data.clientId})`);
    }
}

function updateLedUI(state) {
    isLedOn = state;
    if (isLedOn) {
        btnLed.classList.add('active');
        ledStateText.innerText = 'ON';
    } else {
        btnLed.classList.remove('active');
        ledStateText.innerText = 'OFF';
    }
}

function renderSensorTelemetry(data) {
    // If telemetry contains custom sensor keys (anything other than base fields)
    const baseKeys = ['type', 'uptime', 'freeHeap', 'led', 'clients'];
    const sensorKeys = Object.keys(data).filter(k => !baseKeys.includes(k));

    if (sensorKeys.length > 0) {
        let html = '<div class="sensor-grid" style="display:grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px;">';
        sensorKeys.forEach(key => {
            html += `
                <div style="background: rgba(0,0,0,0.3); padding: 10px; border-radius: 8px; text-align: center;">
                    <div style="font-size: 0.75rem; color: var(--text-secondary); text-transform: uppercase;">${key}</div>
                    <div style="font-size: 1.2rem; font-weight: bold; color: var(--accent-blue); margin-top: 4px;">${data[key]}</div>
                </div>
            `;
        });
        html += '</div>';
        sensorContainer.innerHTML = html;
    }
}

function sendCommand(cmd, value = '') {
    const payloadObj = { command: cmd, value: value };
    const payloadStr = JSON.stringify(payloadObj);

    let sent = false;
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(payloadStr);
        sent = true;
    }

    if (firebaseDb) {
        firebaseDb.ref('/esp01/command').set(payloadStr);
        sent = true;
    }

    if (sent) {
        logEvent('tx', `TX: ${payloadStr}`);
    } else {
        logEvent('error', 'Cannot send command: Both local WebSocket and Firebase Cloud are disconnected.');
    }
}

function toggleLED() {
    sendCommand('toggle_led');
}

function turnOn() {
    sendCommand('turn_on');
}

function turnOff() {
    sendCommand('turn_off');
}

function pulseRelay(seconds) {
    sendCommand('pulse_on', seconds.toString());
    logEvent('tx', `Pulse timer triggered: ON for ${seconds}s`);
}

function emergencyStop() {
    sendCommand('emergency_off');
    logEvent('error', 'EMERGENCY STOP EXECUTED: All outputs & schedules disabled!');
}

function requestTelemetry() {
    sendCommand('get_telemetry');
}

function logEvent(type, message) {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const timestamp = new Date().toLocaleTimeString();
    entry.innerText = `[${timestamp}] ${message}`;

    consoleLog.appendChild(entry);
    consoleLog.scrollTop = consoleLog.scrollHeight;
}

function clearLogs() {
    consoleLog.innerHTML = '';
}

/* Weekly Schedule & Auto-Blink JS Engine */
let scheduleState = {
    enabled: false,
    autoBlink: false,
    days: 0,
    startH: 8,
    startM: 0,
    endH: 18,
    endM: 0
};

function toggleDayBtn(btn) {
    btn.classList.toggle('active');
}

function toggleScheduleEnable() {
    scheduleState.enabled = !scheduleState.enabled;
    updateScheduleUI();
    saveSchedule();
}

function toggleAutoBlink() {
    scheduleState.autoBlink = !scheduleState.autoBlink;
    sendCommand('set_autoblink', scheduleState.autoBlink ? 'true' : 'false');
}

function saveSchedule() {
    let daysMask = 0;
    document.querySelectorAll('.day-btn').forEach(btn => {
        if (btn.classList.contains('active')) {
            const dayBit = parseInt(btn.getAttribute('data-day'));
            daysMask |= (1 << dayBit);
        }
    });

    const startTime = document.getElementById('time-start').value || '08:00';
    const endTime = document.getElementById('time-end').value || '18:00';
    const [startH, startM] = startTime.split(':').map(Number);
    const [endH, endM] = endTime.split(':').map(Number);

    const payload = `enabled:${scheduleState.enabled ? 1 : 0},days:${daysMask},startH:${startH},startM:${startM},endH:${endH},endM:${endM}`;
    sendCommand('set_schedule', payload);
    logEvent('tx', `Schedule Saved: Days=${daysMask}, Window=${startTime}-${endTime}`);
}

function syncScheduleFromTelemetry(sched) {
    if (!sched) return;
    scheduleState.enabled = sched.enabled;
    scheduleState.autoBlink = sched.autoBlink;
    scheduleState.days = sched.days;
    scheduleState.startH = sched.startH;
    scheduleState.startM = sched.startM;
    scheduleState.endH = sched.endH;
    scheduleState.endM = sched.endM;

    updateScheduleUI();
}

function updateScheduleUI() {
    const btnEnable = document.getElementById('btn-sched-enable');
    const textEnable = document.getElementById('sched-enable-text');
    if (btnEnable && textEnable) {
        if (scheduleState.enabled) {
            btnEnable.classList.add('active');
            textEnable.innerText = 'ENABLED';
        } else {
            btnEnable.classList.remove('active');
            textEnable.innerText = 'DISABLED';
        }
    }

    const btnBlink = document.getElementById('btn-autoblink');
    const textBlink = document.getElementById('autoblink-text');
    if (btnBlink && textBlink) {
        if (scheduleState.autoBlink) {
            btnBlink.classList.add('active');
            textBlink.innerText = 'ON';
        } else {
            btnBlink.classList.remove('active');
            textBlink.innerText = 'OFF';
        }
    }

    document.querySelectorAll('.day-btn').forEach(btn => {
        const dayBit = parseInt(btn.getAttribute('data-day'));
        if ((scheduleState.days & (1 << dayBit)) !== 0) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    const formatTime = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const startInput = document.getElementById('time-start');
    const endInput = document.getElementById('time-end');
    if (startInput) startInput.value = formatTime(scheduleState.startH, scheduleState.startM);
    if (endInput) endInput.value = formatTime(scheduleState.endH, scheduleState.endM);
}

/* ========== WiFi Settings Functions ========== */

function syncWifiStatusUI(wifi) {
    if (!wifi) return;
    const modeEl = document.getElementById('wifi-mode');
    const ssidEl = document.getElementById('wifi-ssid');
    const ipEl = document.getElementById('wifi-ip');
    const rssiEl = document.getElementById('wifi-rssi');

    if (modeEl) modeEl.innerText = wifi.mode || '--';
    if (ssidEl) ssidEl.innerText = wifi.ssid || '--';
    if (ipEl) ipEl.innerText = wifi.ip || '--';
    if (rssiEl) rssiEl.innerText = wifi.rssi ? `${wifi.rssi} dBm` : '--';
}

function scanWifi() {
    const btn = document.getElementById('btn-wifi-scan');
    if (btn) btn.innerText = 'Scanning...';
    logEvent('tx', 'WiFi scan requested...');
    sendCommand('wifi_scan');
    setTimeout(() => { if (btn) btn.innerText = 'Scan'; }, 10000);
}

function renderWifiScanResults(networks) {
    const container = document.getElementById('wifi-scan-results');
    const btn = document.getElementById('btn-wifi-scan');
    if (btn) btn.innerText = 'Scan';
    if (!container) return;

    container.style.display = 'flex';
    container.innerHTML = '';

    if (!networks || networks.length === 0) {
        container.innerHTML = '<div class="wifi-net-item"><span class="wifi-net-name">No networks found</span></div>';
        return;
    }

    networks.forEach(net => {
        const item = document.createElement('div');
        item.className = 'wifi-net-item';
        const signal = net.rssi > -50 ? '▂▄▆█' : net.rssi > -70 ? '▂▄▆' : net.rssi > -80 ? '▂▄' : '▂';
        const lock = net.enc ? '🔒' : '🔓';
        item.innerHTML = `<span class="wifi-net-name">${net.ssid}</span><span class="wifi-net-meta">${signal} ${net.rssi}dBm ${lock}</span>`;
        item.onclick = () => {
            document.getElementById('wifi-ssid-input').value = net.ssid;
            document.getElementById('wifi-pass-input').value = '';
            document.getElementById('wifi-pass-input').focus();
        };
        container.appendChild(item);
    });

    logEvent('system', `WiFi scan complete: ${networks.length} networks found`);
}

function connectWifi() {
    const ssid = document.getElementById('wifi-ssid-input').value.trim();
    const pass = document.getElementById('wifi-pass-input').value;

    if (!ssid) {
        logEvent('error', 'Please enter a WiFi SSID to connect.');
        return;
    }

    logEvent('tx', `Connecting to WiFi: ${ssid}...`);
    sendCommand('wifi_connect', `ssid:${ssid},pass:${pass}`);
}
