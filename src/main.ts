import { app, BrowserWindow, dialog, ipcMain, session, type OpenDialogOptions, type WebContents } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { serviceHost } from './service-host';
import { addRecent, launchPaths, parseRecent, type RecentComparison } from './shared/launch';
import type {
	Chunk,
	DocumentId,
	DocumentInfo,
	FolderEntryDocuments,
	LaunchItem,
	OpenedInfo,
	PickKind
} from './shared/protocol';
import type { DiffResult, FolderDiffResult, ImageDiffResult } from './lib/diff-types';
import type { LineChunk } from './lib/line-alignment';
import type { ExportLabels } from './lib/export';
import type { LineRange } from './lib/text-edit';

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
	"form-action 'none'"
].join('; ');

/**
 * The renderer's entire reach into the system. Each channel takes ids and
 * ranges rather than paths, so renderer code cannot ask for an arbitrary file
 * — the only path that ever reaches disk is one the user dropped, resolved by
 * the preload from a real drop event.
 */
/**
 * Equal lines kept either side of a change. Unlimited, so a diff shows the whole file
 * with every unchanged line in place, rather than only the stretches around changes.
 */
const DIFF_CONTEXT_LINES = Number.POSITIVE_INFINITY;
/** Rows beyond this are cut off, and the diff is marked truncated, to keep a huge file renderable. */
const DIFF_MAX_ROWS = 200_000;

/**
 * The folder comparison each window has running, keyed by `webContents` id.
 * Folder comparisons can run for seconds, so a newer one, Cancel, or closing
 * the window stops the old one rather than leaving it hashing in the background.
 */
const folderDiffs = new Map<number, AbortController>();

/** The paths the app was started with, until the first window asks for them. */
let pendingLaunchPaths = launchPaths(process.argv, {
	packaged: app.isPackaged,
	appPath: app.getAppPath(),
	cwd: process.cwd()
});
/**
 * Started to compare something, as `git difftool` does: the app then quits with its
 * window, even on macOS, since the tool that started it waits for it to exit.
 */
const launchedWithPaths = pendingLaunchPaths.length > 0;

/** Opens each path in the service, reporting a path that cannot be opened rather than failing them all. */
function openPaths(paths: string[]): Promise<LaunchItem[]> {
	return Promise.all(
		paths.map(async (target): Promise<LaunchItem> => {
			try {
				return { path: target, opened: await serviceHost.send<OpenedInfo>({ type: 'open', path: target }) };
			} catch (error) {
				return { path: target, error: error instanceof Error ? error.message : String(error) };
			}
		})
	);
}

const recentFile = () => path.join(app.getPath('userData'), 'recent-comparisons.json');

async function readRecent(): Promise<RecentComparison[]> {
	try {
		return parseRecent(await readFile(recentFile(), 'utf8'));
	} catch {
		return [];
	}
}

/** Writes run one after another, so two comparisons finishing together cannot lose one. */
let recentWrites = Promise.resolve();

function updateRecent(change: (list: RecentComparison[]) => RecentComparison[]): Promise<RecentComparison[]> {
	const next = recentWrites.then(async () => {
		const list = change(await readRecent());
		await mkdir(path.dirname(recentFile()), { recursive: true });
		await writeFile(recentFile(), JSON.stringify(list, null, '\t'));
		return list;
	});
	recentWrites = next.then(
		() => undefined,
		() => undefined
	);
	return next;
}

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
						filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
					}
				: { title: 'Open file', properties: ['openFile'] }
		)
	);

	ipcMain.handle('comparer:pick-folder', (event) =>
		pick(event.sender, { title: 'Open folder', properties: ['openDirectory'] })
	);

	ipcMain.handle(
		'comparer:adopt',
		(_event, docId: DocumentId | null, text: string, name: string): Promise<DocumentInfo> =>
			serviceHost.send<DocumentInfo>({ type: 'adopt', docId: docId as DocumentId, text, name })
	);

	ipcMain.handle('comparer:chunk', (_event, docId: DocumentId, from: number, maxBytes: number): Promise<Chunk> =>
		serviceHost.send<Chunk>({ type: 'chunk', docId, from, maxBytes })
	);

	ipcMain.handle('comparer:diff', (_event, left: DocumentId | null, right: DocumentId | null): Promise<DiffResult> =>
		serviceHost.send<DiffResult>({
			type: 'diff',
			left,
			right,
			context: DIFF_CONTEXT_LINES,
			maxRows: DIFF_MAX_ROWS
		})
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
						}
					}
				);
			} finally {
				sender.removeListener('destroyed', abort);
				if (folderDiffs.get(sender.id) === controller) folderDiffs.delete(sender.id);
			}
		}
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
		}
	);

	ipcMain.handle('comparer:line-chunks', (_event, left: DocumentId, right: DocumentId): Promise<LineChunk[]> => {
		if (typeof left !== 'string' || typeof right !== 'string') throw new Error('Two documents are required');
		return serviceHost.send<LineChunk[]>({ type: 'lineChunks', left, right });
	});

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
		}
	);

	ipcMain.handle(
		'comparer:copy-lines',
		(_event, target: DocumentId, source: DocumentId, into: LineRange, from: LineRange): Promise<DocumentInfo> => {
			if (typeof target !== 'string' || typeof source !== 'string') throw new Error('Two documents are required');
			return serviceHost.send<DocumentInfo>({ type: 'replaceLines', target, source, into, from });
		}
	);

	// Writes only to the path the document was opened from, or to one the user picks here.
	ipcMain.handle('comparer:save', async (event, docId: DocumentId, saveAs?: boolean): Promise<DocumentInfo | null> => {
		if (typeof docId !== 'string') throw new Error('A document is required');
		const info = await serviceHost.send<DocumentInfo>({ type: 'describe', docId });
		let target = saveAs ? null : info.path;
		if (!target) {
			const owner = BrowserWindow.fromWebContents(event.sender);
			const options = { title: 'Save file', defaultPath: info.path ?? info.name };
			const { canceled, filePath } = owner
				? await dialog.showSaveDialog(owner, options)
				: await dialog.showSaveDialog(options);
			if (canceled || !filePath) return null;
			target = filePath;
		}
		return serviceHost.send<DocumentInfo>({ type: 'save', docId, path: target });
	});

	// The file to write is always one the user names in this dialog.
	ipcMain.handle(
		'comparer:export-diff',
		async (event, left: DocumentId | null, right: DocumentId | null, labels: ExportLabels): Promise<string | null> => {
			if (typeof labels?.left !== 'string' || typeof labels.right !== 'string') throw new Error('Labels are required');
			const owner = BrowserWindow.fromWebContents(event.sender);
			const stem = path.parse(path.basename(labels.right)).name || 'diff';
			const options = {
				title: 'Export diff',
				defaultPath: `${stem}.patch`,
				filters: [
					{ name: 'Patch', extensions: ['patch', 'diff'] },
					{ name: 'HTML report', extensions: ['html'] }
				]
			};
			const { canceled, filePath } = owner
				? await dialog.showSaveDialog(owner, options)
				: await dialog.showSaveDialog(options);
			if (canceled || !filePath) return null;
			const format = /\.html?$/i.test(filePath) ? 'html' : 'patch';
			await serviceHost.send<void>({ type: 'exportDiff', left, right, format, labels, path: filePath });
			return filePath;
		}
	);

	ipcMain.handle('comparer:launch-items', (): Promise<LaunchItem[]> => {
		const paths = pendingLaunchPaths;
		pendingLaunchPaths = [];
		return openPaths(paths);
	});

	ipcMain.handle('comparer:recent', (): Promise<RecentComparison[]> => readRecent());

	// Remembers paths the service already holds for these ids, never paths sent by the renderer.
	ipcMain.handle(
		'comparer:remember',
		async (_event, left: DocumentId, right: DocumentId): Promise<RecentComparison[]> => {
			if (typeof left !== 'string' || typeof right !== 'string') throw new Error('Two documents are required');
			type Located = { kind: RecentComparison['kind']; path: string | null };
			const [a, b] = await Promise.all([
				serviceHost.send<Located>({ type: 'pathOf', docId: left }),
				serviceHost.send<Located>({ type: 'pathOf', docId: right })
			]);
			if (!a.path || !b.path || a.kind !== b.kind) return readRecent();
			const entry = { kind: a.kind, left: a.path, right: b.path, at: Date.now() };
			return updateRecent((list) => addRecent(list, entry));
		}
	);

	ipcMain.handle('comparer:open-recent', async (_event, id: string): Promise<LaunchItem[]> => {
		const entry = (await readRecent()).find((item) => item.id === id);
		if (!entry) throw new Error('That comparison is no longer in the recent list');
		return openPaths([entry.left, entry.right]);
	});

	ipcMain.handle('comparer:forget-recent', (_event, id: string): Promise<RecentComparison[]> => {
		if (typeof id !== 'string') throw new Error('A recent comparison is required');
		return updateRecent((list) => list.filter((item) => item.id !== id));
	});

	ipcMain.handle('comparer:clear-recent', async (): Promise<void> => {
		await updateRecent(() => []);
	});

	// The window is frameless and the header draws its own controls, so minimising,
	// maximising and closing all come back through here.
	ipcMain.handle('comparer:minimize-window', (event): void => {
		BrowserWindow.fromWebContents(event.sender)?.minimize();
	});

	// Also what the header's double-click does. Full screen is left to the menu: it is
	// the system's own gesture, and leaving it maximised is the less surprising result.
	ipcMain.handle('comparer:toggle-maximize-window', (event): void => {
		const owner = BrowserWindow.fromWebContents(event.sender);
		if (!owner) return;
		if (owner.isMaximized()) owner.unmaximize();
		else owner.maximize();
	});

	ipcMain.handle('comparer:close-window', (event): void => {
		BrowserWindow.fromWebContents(event.sender)?.close();
	});

	ipcMain.handle('comparer:window-squared', (event): boolean => {
		const owner = BrowserWindow.fromWebContents(event.sender);
		return owner ? isSquared(owner) : false;
	});

	ipcMain.handle('comparer:close', (_event, docId: DocumentId): Promise<void> => {
		return serviceHost.send<void>({ type: 'close', docId });
	});
}

const applyContentSecurityPolicy = () => {
	session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
		callback({
			responseHeaders: {
				...details.responseHeaders,
				'Content-Security-Policy': [CONTENT_SECURITY_POLICY]
			}
		});
	});
};

/** A maximised or full-screen window fills its area edge to edge, so its corners are square. */
const isSquared = (window: BrowserWindow) => window.isMaximized() || window.isFullScreen();

const createWindow = () => {
	// Create the browser window.
	const mainWindow = new BrowserWindow({
		width: 1400,
		height: 900,
		minWidth: 720,
		minHeight: 480,
		backgroundColor: '#0a0a0a',
		// Frameless, with the app header acting as the title bar and drawing its own
		// window controls. The system's own are left off entirely — including the
		// macOS traffic lights — so the laser border can run unbroken along the top
		// edge instead of stopping at a strip the page cannot paint.
		frame: false,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js')
		}
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

	// Tells the page when the corners turn square or round again, so the laser border follows them.
	const sendSquared = () => {
		if (!mainWindow.isDestroyed()) mainWindow.webContents.send('comparer:window-squared', isSquared(mainWindow));
	};
	mainWindow.on('maximize', sendSquared);
	mainWindow.on('unmaximize', sendSquared);
	mainWindow.on('enter-full-screen', sendSquared);
	mainWindow.on('leave-full-screen', sendSquared);

	// and load the index.html of the app.
	if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
		mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
	} else {
		mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
	}

	// Not for end-to-end tests, where a DevTools window would be one more window to tell apart.
	if (!app.isPackaged && !process.env.COMPARER_E2E) {
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
	if (process.platform !== 'darwin' || launchedWithPaths) {
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
