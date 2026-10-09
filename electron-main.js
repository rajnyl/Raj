const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ensureJavaExecutable } = require('./java-runtime');

let dashboardServer;
let readerProcess;
let isQuitting = false;
let bridgeWarningShown = false;
let bridgeErrorOutput = '';
let remoteDashboard = false;

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
    await window.loadURL(dashboardUrl);

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
            dashboardUrl
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
