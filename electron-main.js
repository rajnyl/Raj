const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const { createServer } = require('node:http');
const fs = require('fs');
const path = require('path');
const { ensureJavaExecutable } = require('./java-runtime');

let dashboardServer;
let readerProcess;
let readerRelay;
let isQuitting = false;
let bridgeWarningShown = false;
let bridgeErrorOutput = '';
let remoteDashboard = false;
let lastCloudHeartbeatErrorAt = 0;

function sendReaderEvent(event) {
    const message = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of readerRelay.clients) client.write(message);
}

function startReaderRelay(dashboardUrl) {
    const dashboardOrigin = new URL(dashboardUrl).origin;
    const clients = new Set();
    let readerName = '';
    let connected = false;
    let lastHeartbeatAt = 0;
    const statusTimer = setInterval(() => {
        if (connected && Date.now() - lastHeartbeatAt >= 15000) {
            connected = false;
            sendReaderEvent({ type: 'status', connected, reader: readerName });
        }
    }, 3000);
    statusTimer.unref();
    const server = createServer((request, response) => {
        const origin = request.headers.origin;
        if (origin === dashboardOrigin) {
            response.setHeader('Access-Control-Allow-Origin', dashboardOrigin);
            response.setHeader('Vary', 'Origin');
            response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            response.setHeader('Access-Control-Allow-Private-Network', 'true');
        } else if (origin) {
            response.writeHead(403).end();
            return;
        }

        if (request.method === 'OPTIONS') {
            response.writeHead(204).end();
            return;
        }
        if (request.method === 'GET' && request.url === '/events') {
            response.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive'
            });
            response.write(`data: ${JSON.stringify({ type: 'status', connected, reader: readerName })}\n\n`);
            clients.add(response);
            response.on('close', () => clients.delete(response));
            return;
        }
        if (request.method !== 'POST' || !['/heartbeat', '/scan'].includes(request.url)) {
            response.writeHead(404).end();
            return;
        }

        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
            body += chunk;
            if (body.length > 8192) {
                response.writeHead(413).end();
                request.destroy();
            }
        });
        request.on('end', () => {
            let payload;
            try {
                payload = JSON.parse(body);
            } catch {
                response.writeHead(400).end('Invalid JSON.');
                return;
            }

            if (request.url === '/heartbeat') {
                if (typeof payload.reader !== 'string' || !payload.reader.trim()) {
                    response.writeHead(400).end('Reader name is required.');
                    return;
                }
                readerName = payload.reader.trim();
                connected = true;
                lastHeartbeatAt = Date.now();
                sendReaderEvent({ type: 'status', connected, reader: readerName });
                const token = process.env.NFC_BRIDGE_TOKEN || '';
                if (token.length >= 32) {
                    fetch(`${dashboardUrl}/api/reader/heartbeat`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                        body: JSON.stringify({ reader: readerName })
                    }).then((cloudResponse) => {
                        if (!cloudResponse.ok) throw new Error(`Cloud heartbeat returned HTTP ${cloudResponse.status}.`);
                    }).catch((error) => {
                        if (Date.now() - lastCloudHeartbeatErrorAt > 60000) {
                            lastCloudHeartbeatErrorAt = Date.now();
                            console.error('Could not forward reader heartbeat to the cloud:', error.message);
                        }
                    });
                }
                response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"success":true}');
                return;
            }

            if (typeof payload.nfc_uid !== 'string' || !/^(?:0x)?[0-9a-f:\s-]{4,128}$/i.test(payload.nfc_uid)) {
                response.writeHead(400).end('A valid card UID is required.');
                return;
            }
            sendReaderEvent({ type: 'scan', uid: payload.nfc_uid, reader: readerName });
            response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"success":true}');
        });
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            readerRelay = { server, clients, statusTimer };
            const address = server.address();
            resolve(`http://127.0.0.1:${address.port}`);
        });
    });
}

function showBridgeWarning(window, message, detail) {
    if (isQuitting || bridgeWarningShown || window.isDestroyed()) return;
    bridgeWarningShown = true;
    dialog.showMessageBox(window, {
        type: 'warning',
        title: 'NFC reader bridge unavailable',
        message,
        detail
    });
}

async function createWindow() {
    const userDataPath = app.getPath('userData');
    const configuredDashboardUrl = process.env.DASHBOARD_URL?.trim();
    let dashboardUrl;
    if (configuredDashboardUrl) {
        const parsedUrl = new URL(configuredDashboardUrl);
        if ((parsedUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsedUrl.hostname))
            || parsedUrl.username || parsedUrl.password) {
            throw new Error('DASHBOARD_URL must use HTTPS without embedded credentials, unless it points to localhost.');
        }
        dashboardUrl = parsedUrl.toString().replace(/\/+$/, '');
        remoteDashboard = true;
    } else {
        fs.mkdirSync(userDataPath, { recursive: true });
        process.env.DB_PATH = path.join(userDataPath, 'guild_data.sqlite');
        if (!fs.existsSync(process.env.DB_PATH)) {
            const seedPath = app.isPackaged
                ? path.join(process.resourcesPath, 'seed-guild-data.sqlite')
                : path.join(__dirname, 'guild_data.sqlite');
            if (fs.existsSync(seedPath)) fs.copyFileSync(seedPath, process.env.DB_PATH);
        }
        const { startServer } = require('./server');
        dashboardServer = await startServer(0);
        dashboardUrl = `http://127.0.0.1:${dashboardServer.address().port}`;
    }

    const window = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 900,
        minHeight: 650,
        title: 'NCGG Attendance Dashboard',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    let readerRelayUrl;
    if (remoteDashboard) {
        readerRelayUrl = await startReaderRelay(dashboardUrl);
        const appUrl = new URL(dashboardUrl);
        appUrl.searchParams.set('localReaderPort', new URL(readerRelayUrl).port);
        await window.loadURL(appUrl.toString());
    } else {
        await window.loadURL(dashboardUrl);
    }

    try {
        if (remoteDashboard && (!process.env.NFC_BRIDGE_TOKEN || process.env.NFC_BRIDGE_TOKEN.length < 32)) {
            throw new Error('The cloud dashboard is connected, but PC/SC reader support needs NFC_BRIDGE_TOKEN configured on this device and READER_BRIDGE_TOKEN configured on the cloud server. Keyboard-wedge scanning remains available.');
        }
        window.setTitle('NCGG Attendance Dashboard - Preparing NFC reader');
        const javaExecutable = await ensureJavaExecutable(userDataPath);
        readerProcess = spawn(javaExecutable, [
            '-cp',
            app.isPackaged ? process.resourcesPath : __dirname,
            'NfcReaderBridge',
            readerRelayUrl || dashboardUrl
        ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        readerProcess.stderr.setEncoding('utf8');
        readerProcess.stderr.on('data', (chunk) => {
            bridgeErrorOutput = (bridgeErrorOutput + chunk).slice(-4000);
        });
        readerProcess.on('error', (error) => {
            console.error('Could not start the NFC reader bridge:', error.message);
            showBridgeWarning(
                window,
                'The dashboard is open, but the NFC reader bridge could not start.',
                `Java could not be launched: ${error.message}`
            );
        });
        readerProcess.on('exit', (code, signal) => {
            if (code === 0 || isQuitting) return;
            const reason = bridgeErrorOutput.trim() || `The bridge exited with code ${code}${signal ? ` (${signal})` : ''}.`;
            console.error('The NFC reader bridge stopped:', reason);
            showBridgeWarning(
                window,
                'The dashboard is open, but the NFC reader bridge stopped.',
                `${reason}\n\nCheck that the NFC reader is connected and its Windows smart-card driver/service is running.`
            );
        });
        window.setTitle('NCGG Attendance Dashboard');
    } catch (error) {
        console.error('Could not prepare the NFC reader bridge:', error.message);
        window.setTitle('NCGG Attendance Dashboard');
        showBridgeWarning(
            window,
            'The dashboard is open, but the NFC reader bridge could not start.',
            error.message
        );
    }
}

app.whenReady().then(createWindow).catch((error) => {
    console.error('Could not start the desktop dashboard:', error);
    dialog.showErrorBox('NCGG Dashboard failed to start', error.message);
    app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
    isQuitting = true;
    if (readerProcess && !readerProcess.killed) readerProcess.kill();
    if (readerRelay) {
        clearInterval(readerRelay.statusTimer);
        if (readerRelay.server.listening) readerRelay.server.close();
    }
    if (dashboardServer) {
        dashboardServer.close(() => {
            require('./server').closeDatabase().catch((error) => {
                console.error('Could not close the desktop database:', error.message);
            });
        });
    } else if (!remoteDashboard) {
        require('./server').closeDatabase();
    }
});

