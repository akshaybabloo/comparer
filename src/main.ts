import { app, BrowserWindow, dialog, ipcMain, session, type OpenDialogOptions, type WebContents } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { serviceHost } from './service-host';
import type { Chunk, DocumentId, DocumentInfo, FolderEntryDocuments, OpenedInfo, PickKind } from './shared/protocol';
import type { DiffResult, FolderDiffResult, ImageDiffResult } from './lib/diff-types';

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
  // Image previews and diff images are shown from object URLs made in the renderer.
  "img-src 'self' data: blob:",
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

/**
 * The folder comparison each window has running, keyed by `webContents` id.
 * Folder comparisons can run for seconds, so a newer one, Cancel, or closing
 * the window stops the old one rather than leaving it hashing in the background.
 */
const folderDiffs = new Map<number, AbortController>();

// The dialog runs here rather than behind a renderer-supplied path, so the
// only paths this can open are ones the user chose in it.
async function pick(sender: WebContents, options: OpenDialogOptions): Promise<OpenedInfo | null> {
  const owner = BrowserWindow.fromWebContents(sender);
  const { canceled, filePaths } = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if (canceled || filePaths.length === 0) return null;
  return serviceHost.send<OpenedInfo>({ type: 'open', path: filePaths[0] });
}

function registerIpc() {
  ipcMain.handle('comparer:open', (_event, path: string): Promise<OpenedInfo> => {
    if (typeof path !== 'string' || path.length === 0) throw new Error('A file path is required');
    return serviceHost.send<OpenedInfo>({ type: 'open', path });
  });

  // An image pane's partner may only take an image, so its picker only offers them.
  ipcMain.handle('comparer:pick', (event, kind?: PickKind) =>
    pick(
      event.sender,
      kind === 'image'
        ? {
            title: 'Open image',
            properties: ['openFile'],
            filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
          }
        : { title: 'Open file', properties: ['openFile'] },
    ),
  );

  ipcMain.handle('comparer:pick-folder', (event) =>
    pick(event.sender, { title: 'Open folder', properties: ['openDirectory'] }),
  );

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

  ipcMain.handle(
    'comparer:diff-folders',
    async (event, left: DocumentId, right: DocumentId, token: number): Promise<FolderDiffResult> => {
      if (typeof left !== 'string' || typeof right !== 'string') throw new Error('Two folders are required');

      const { sender } = event;
      folderDiffs.get(sender.id)?.abort();
      const controller = new AbortController();
      folderDiffs.set(sender.id, controller);
      const abort = () => controller.abort();
      sender.once('destroyed', abort);

      try {
        return await serviceHost.send<FolderDiffResult>(
          { type: 'diffFolders', left, right },
          {
            signal: controller.signal,
            // The token lets the preload drop progress still in flight from a
            // comparison this one replaced.
            onProgress: (progress) => {
              if (!sender.isDestroyed()) sender.send('comparer:folder-progress', token, progress);
            },
          },
        );
      } finally {
        sender.removeListener('destroyed', abort);
        if (folderDiffs.get(sender.id) === controller) folderDiffs.delete(sender.id);
      }
    },
  );

  ipcMain.handle('comparer:cancel-folder-diff', (event): void => {
    folderDiffs.get(event.sender.id)?.abort();
  });

  // The path comes from renderer code, so it only ever names something inside
  // two folders the user already chose; the service enforces that.
  ipcMain.handle(
    'comparer:open-folder-entry',
    (_event, left: DocumentId, right: DocumentId, path: string): Promise<FolderEntryDocuments> => {
      if (typeof left !== 'string' || typeof right !== 'string' || typeof path !== 'string') {
        throw new Error('Two folders and a path are required');
      }
      return serviceHost.send<FolderEntryDocuments>({ type: 'openFolderEntry', left, right, path });
    },
  );

  ipcMain.handle('comparer:read-image', (_event, docId: DocumentId): Promise<Uint8Array> => {
    if (typeof docId !== 'string') throw new Error('An image is required');
    return serviceHost.send<Uint8Array>({ type: 'readImage', docId });
  });

  ipcMain.handle(
    'comparer:diff-images',
    (_event, left: DocumentId, right: DocumentId, tolerance: number): Promise<ImageDiffResult> => {
      if (typeof left !== 'string' || typeof right !== 'string' || typeof tolerance !== 'number') {
        throw new Error('Two images and a tolerance are required');
      }
      return serviceHost.send<ImageDiffResult>({ type: 'diffImages', left, right, tolerance });
    },
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

/**
 * The app header is `h-11` (44px) including its 1px bottom border. The controls
 * stop just above that border, so it runs unbroken beneath them.
 */
const TITLE_BAR_HEIGHT = 43;
/** The dark `--card` and `--foreground` tokens, which the header is painted with. */
const TITLE_BAR_COLOR = '#171717';
const TITLE_BAR_SYMBOL_COLOR = '#fafafa';

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0a0a0a',
    // Frameless, with the app header acting as the title bar. The window
    // controls are still the operating system's own rather than drawn by the
    // app: traffic lights on macOS, caption buttons on Windows (keeping Snap
    // Layouts), and theme-drawn buttons on Linux that follow the desktop's
    // button layout.
    titleBarStyle: 'hidden',
    // Also what enables the `titlebar-area-*` CSS environment variables the
    // header uses to keep clear of the controls, on whichever side they are.
    titleBarOverlay: {
      color: TITLE_BAR_COLOR,
      symbolColor: TITLE_BAR_SYMBOL_COLOR,
      height: TITLE_BAR_HEIGHT,
    },
    // Centres the traffic lights vertically in the taller header.
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 15 } } : {}),
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
