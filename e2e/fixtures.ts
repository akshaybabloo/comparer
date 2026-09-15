import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const PROJECT = resolve(__dirname, '..');

/** A fresh temporary directory for one test's files. */
export function tempDir(prefix = 'comparer-e2e-'): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Starts the built app, with `paths` given on its command line as `comparer a b` would,
 * and its own settings folder so nothing is shared with a real install or other tests.
 */
export async function launch(
	paths: string[] = [],
	userDataDir = tempDir('comparer-e2e-profile-')
): Promise<{ app: ElectronApplication; page: Page }> {
	const app = await electron.launch({
		args: [
			'.',
			// Some Linux setups, including CI containers, cannot use Chromium's sandbox.
			...(process.env.CI || process.env.E2E_NO_SANDBOX ? ['--no-sandbox'] : []),
			`--user-data-dir=${userDataDir}`,
			...paths
		],
		cwd: PROJECT,
		env: { ...process.env, COMPARER_E2E: '1' }
	});
	const page = await app.firstWindow();
	await page.waitForLoadState('domcontentloaded');
	return { app, page };
}

/** Numbered lines, `line 1` to `line count`, each ending in a newline. */
export function numberedLines(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `line ${index + 1}`);
}

export function writeLines(path: string, lines: string[]) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, lines.join('\n') + '\n');
}

/**
 * Two 300-line files with five separate changes: an edited line, two edited lines, a
 * deleted line, an added line, and an edited last line.
 */
export function textPair(dir: string): { left: string; right: string; rightLines: string[] } {
	const leftLines = numberedLines(300);
	const rightLines = [...leftLines];
	rightLines[4] = 'line 5 changed';
	rightLines[49] = 'line 50 changed';
	rightLines[50] = 'line 51 changed';
	rightLines.splice(119, 1);
	rightLines.splice(200, 0, 'added near 200');
	rightLines[rightLines.length - 1] = 'last changed';
	const left = join(dir, 'left.txt');
	const right = join(dir, 'right.txt');
	writeLines(left, leftLines);
	writeLines(right, rightLines);
	return { left, right, rightLines };
}

/**
 * Two folders that differ by two modified files, a deleted file, and an added folder
 * and file. Every entry then gets the same timestamps, so only those count as changes.
 */
export function folderPair(dir: string): { left: string; right: string } {
	const left = join(dir, 'before');
	const right = join(dir, 'after');
	for (const root of [left, right]) {
		for (let folder = 0; folder < 4; folder++) {
			for (let file = 0; file < 5; file++)
				writeLines(join(root, `dir${folder}`, `file${file}.txt`), [`${folder} ${file}`]);
		}
	}
	writeLines(join(right, 'dir0', 'file3.txt'), ['changed']);
	writeLines(join(right, 'dir3', 'file4.txt'), ['changed too']);
	writeLines(join(right, 'dir2', 'new', 'inside.txt'), ['new']);
	writeLines(join(right, 'zz-added.txt'), ['new']);
	rmSync(join(right, 'dir1', 'file2.txt'));

	const time = new Date('2024-01-01T00:00:00Z');
	const stamp = (path: string) => {
		if (statSync(path).isDirectory()) for (const name of readdirSync(path)) stamp(join(path, name));
		utimesSync(path, time, time);
	};
	stamp(left);
	stamp(right);
	return { left, right };
}

/** A solid-colour PNG, with an optional rectangle painted over it. */
export function writePng(
	path: string,
	width: number,
	height: number,
	colour: [number, number, number],
	box?: { x: number; y: number; width: number; height: number; colour: [number, number, number] }
) {
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) {
		const row = y * (width * 3 + 1);
		raw[row] = 0;
		for (let x = 0; x < width; x++) {
			const inside = box && x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
			const [r, g, b] = inside ? box.colour : colour;
			raw.set([r, g, b], row + 1 + x * 3);
		}
	}
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	writeFileSync(
		path,
		Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk('IHDR', header),
			chunk('IDAT', deflateSync(raw)),
			chunk('IEND', Buffer.alloc(0))
		])
	);
}
