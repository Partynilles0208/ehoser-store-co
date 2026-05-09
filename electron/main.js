const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell } = require('electron');

const UPDATE_REPO = 'Partynilles0208/ehoser-store-co';
let mainWindow = null;

function getAuthStorePath() {
  return path.join(app.getPath('userData'), 'desktop-auth.json');
}

function readDesktopAuth() {
  try {
    const raw = fs.readFileSync(getAuthStorePath(), 'utf8');
    const data = JSON.parse(raw);
    return { token: typeof data.token === 'string' ? data.token : '' };
  } catch {
    return { token: '' };
  }
}

function writeDesktopAuth(token) {
  const filePath = getAuthStorePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ token, savedAt: new Date().toISOString() }), 'utf8');
}

function clearDesktopAuth() {
  try {
    fs.rmSync(getAuthStorePath(), { force: true });
  } catch {}
}

function parseVersion(version) {
  return String(version || '')
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(latest, current) {
  const next = parseVersion(latest);
  const now = parseVersion(current);
  for (let i = 0; i < Math.max(next.length, now.length); i += 1) {
    const a = next[i] || 0;
    const b = now[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

function findWindowsInstaller(assets = []) {
  return assets.find((asset) => /\.exe$/i.test(asset.name || ''))
    || assets.find((asset) => /setup|installer/i.test(asset.name || ''))
    || null;
}

async function checkForUpdate() {
  const currentVersion = app.getVersion();
  const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `ehoser-control-center/${currentVersion}`
    }
  });

  if (res.status === 404) {
    return { available: false, currentVersion, reason: 'no-release' };
  }
  if (!res.ok) {
    return { available: false, currentVersion, reason: 'github-error', status: res.status };
  }

  const release = await res.json();
  const latestVersion = String(release.tag_name || release.name || '').replace(/^v/i, '');
  const asset = findWindowsInstaller(release.assets || []);
  const available = Boolean(latestVersion && asset && isNewerVersion(latestVersion, currentVersion));

  return {
    available,
    currentVersion,
    latestVersion,
    releaseName: release.name || release.tag_name || latestVersion,
    releaseUrl: release.html_url || '',
    fileName: asset?.name || '',
    fileSize: asset?.size || 0,
    downloadUrl: asset?.browser_download_url || '',
    publishedAt: release.published_at || ''
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 640,
    title: 'Ehoser Control Center',
    backgroundColor: '#0b0c0f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const indexPath = path.join(__dirname, '..', 'public', 'index.html');
  win.loadFile(indexPath, { query: { desktop: '1' } });
  mainWindow = win;
}

ipcMain.handle('updates:check', async () => {
  try {
    return await checkForUpdate();
  } catch (error) {
    return {
      available: false,
      currentVersion: app.getVersion(),
      reason: 'check-failed',
      message: error?.message || 'Update-Pruefung fehlgeschlagen'
    };
  }
});

ipcMain.handle('updates:download', async (_event, payload) => {
  if (!payload?.url || !mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: 'Download nicht moeglich' };
  }
  mainWindow.webContents.downloadURL(payload.url);
  return { ok: true };
});

ipcMain.handle('auth:get', async () => readDesktopAuth());

ipcMain.handle('auth:set', async (_event, payload) => {
  const token = typeof payload?.token === 'string' ? payload.token : '';
  if (!token) return { ok: false };
  writeDesktopAuth(token);
  return { ok: true };
});

ipcMain.handle('auth:clear', async () => {
  clearDesktopAuth();
  return { ok: true };
});

app.on('browser-window-created', (_event, win) => {
  win.webContents.session.on('will-download', (_downloadEvent, item) => {
    const startTime = Date.now();
    const totalBytes = item.getTotalBytes();

    item.on('updated', (_event, state) => {
      const receivedBytes = item.getReceivedBytes();
      const elapsedSeconds = Math.max(0.001, (Date.now() - startTime) / 1000);
      win.webContents.send('updates:progress', {
        state,
        fileName: item.getFilename(),
        receivedBytes,
        totalBytes,
        bytesPerSecond: receivedBytes / elapsedSeconds,
        percent: totalBytes > 0 ? Math.min(100, (receivedBytes / totalBytes) * 100) : 0
      });
    });

    item.once('done', (_event, state) => {
      win.webContents.send('updates:progress', {
        state,
        fileName: item.getFilename(),
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        bytesPerSecond: 0,
        percent: state === 'completed' ? 100 : 0,
        savePath: item.getSavePath()
      });
    });
  });
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
