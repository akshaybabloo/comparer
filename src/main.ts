import { app, BrowserWindow, ipcMain, session } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { serviceHost } from './service-host';
import type { Chunk, DocumentId, DocumentInfo } from './shared/protocol';
import type { DiffResult } from './lib/diff-types';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

/**
 * Locks the renderer down to its own bundle. Only applied to packaged builds:
 * the Vite dev server injects inline scripts for HMR, which a policy this
 * strict would block.
 *
 * `script-src` needs no `wasm-unsafe-eval`: the WebAssembly diff engine runs in
 * the utility process, which is Node and has no CSP, so nothing compiles wasm
 * in the renderer at all.
 *
 * The one remaining relaxation is `style-src 'unsafe-inline'`, because
 * CodeMirror generates its theme stylesheet at runtime rather than shipping a
 * static file.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * The renderer's entire reach into the system. Each channel takes ids and
 * ranges rather than paths, so renderer code cannot ask for an arbitrary file
 * — the only path that ever reaches disk is one the user dropped, resolved by
 * the preload from a real drop event.
 */
const DIFF_CONTEXT_LINES = 3;
const DIFF_MAX_ROWS = 200_000;

function registerIpc() {
  ipcMain.handle('comparer:open', (_event, path: string): Promise<DocumentInfo> => {
    if (typeof path !== 'string' || path.length === 0) throw new Error('A file path is required');
    return serviceHost.send<DocumentInfo>({ type: 'open', path });
  });

  ipcMain.handle(
    'comparer:adopt',
    (_event, docId: DocumentId | null, text: string, name: string): Promise<DocumentInfo> =>
      serviceHost.send<DocumentInfo>({ type: 'adopt', docId: docId as DocumentId, text, name }),
  );

  ipcMain.handle(
    'comparer:chunk',
    (_event, docId: DocumentId, from: number, maxBytes: number): Promise<Chunk> =>
      serviceHost.send<Chunk>({ type: 'chunk', docId, from, maxBytes }),
  );

  ipcMain.handle(
    'comparer:diff',
    (_event, left: DocumentId | null, right: DocumentId | null): Promise<DiffResult> =>
      serviceHost.send<DiffResult>({
        type: 'diff',
        left,
        right,
        context: DIFF_CONTEXT_LINES,
        maxRows: DIFF_MAX_ROWS,
      }),
  );

  ipcMain.handle('comparer:close', (_event, docId: DocumentId): Promise<void> => {
    return serviceHost.send<void>({ type: 'close', docId });
  });
}

const applyContentSecurityPolicy = () => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
      },
    });
  });
};

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#252525',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Renderer console and uncaught errors are otherwise only visible in
  // DevTools; forwarding them makes `pnpm start` output self-contained.
  if (!app.isPackaged) {
    mainWindow.webContents.on('console-message', (event) => {
      console.log(`[renderer:${event.level}] ${event.message}`);
    });
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error('[renderer] process gone:', details.reason);
    });
  }

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  if (app.isPackaged) applyContentSecurityPolicy();
  registerIpc();
  createWindow();
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
