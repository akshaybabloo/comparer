import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { folderPair, launch, tempDir, textPair, writePng } from './fixtures';

let app: ElectronApplication | undefined;

test.afterEach(async () => {
	await app?.close();
	app = undefined;
});

async function start(paths: string[], userDataDir?: string): Promise<Page> {
	const launched = await launch(paths, userDataDir);
	app = launched.app;
	return launched.page;
}

/** The row of controls for what is on screen, under the title bar. */
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'View controls' });

/** A toolbar toggle or button, by its visible text. */
const control = (page: Page, text: string) =>
	toolbar(page)
		.getByRole('button', { name: text, exact: true })
		.or(toolbar(page).getByText(text, { exact: true }))
		.first();

test.describe('text diff', () => {
	test('compares two files from the command line, and filters, jumps and searches the diff', async () => {
		const { left, right } = textPair(tempDir());
		const page = await start([left, right]);
		const bar = toolbar(page);

		await expect(bar.getByText('5 changes')).toBeVisible();

		await bar.getByRole('button', { name: 'Down' }).click();
		await expect(bar.getByText('1 of 5')).toBeVisible();
		// The change jumped to is marked, and flashes as the jump lands.
		await expect(page.locator('main .animate-jump-flash').first()).toBeAttached();
		await page.keyboard.press('Alt+ArrowDown');
		await expect(bar.getByText('2 of 5')).toBeVisible();

		await control(page, 'Different').click();
		await expect(
			page
				.locator('main')
				.getByText(/\d+\s+similar\s+lines?\s+hidden/)
				.first()
		).toBeVisible();
		await page.keyboard.press('Alt+1');
		await expect(page.locator('main').getByText(/similar\s+lines?\s+hidden/)).toHaveCount(0);

		await page.keyboard.press('Control+f');
		await page.getByLabel('Find in diff').fill('changed');
		await expect(page.getByRole('search')).toContainText('1 of 4');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('search')).toContainText('2 of 4');
		await expect(page.locator('main mark')).not.toHaveCount(0);
	});

	test('copies a change across and saves the file', async () => {
		const { left, right, rightLines } = textPair(tempDir());
		const page = await start([left, right]);
		const header = page.locator('header');
		await expect(toolbar(page).getByText('5 changes')).toBeVisible();

		// The buttons follow the pointer, so they appear on the second row of the change too.
		await page.locator('main').getByText('line 5 changed').hover();
		await page.getByRole('button', { name: 'Copy this change to the right' }).click();
		await expect(toolbar(page).getByText('4 changes')).toBeVisible();

		await header.getByRole('button', { name: 'Save right' }).click();
		await expect(header.getByRole('button', { name: 'Save right' })).toHaveCount(0);
		const expected = [...rightLines];
		expected[4] = 'line 5';
		expect(readFileSync(right, 'utf8')).toBe(expected.join('\n') + '\n');
	});

	test('exports the diff as a patch', async () => {
		const dir = tempDir();
		const { left, right } = textPair(dir);
		const page = await start([left, right]);
		await expect(toolbar(page).getByText('5 changes')).toBeVisible();

		const target = join(dir, 'changes.patch');
		await app!.evaluate(({ dialog }, filePath) => {
			dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog;
		}, target);
		await toolbar(page).getByRole('button', { name: 'Export patch' }).click();
		await expect(page.getByRole('status')).toContainText('Exported to');

		const patch = readFileSync(target, 'utf8');
		expect(patch.startsWith('--- a/left.txt\n+++ b/right.txt\n@@ -2,7 +2,7 @@\n')).toBe(true);
		expect(patch).toContain('-line 5\n+line 5 changed\n');
	});
});

test.describe('folder diff', () => {
	test('filters the tree, jumps between changes and opens a modified file', async () => {
		const { left, right } = folderPair(tempDir());
		const page = await start([left, right]);
		const bar = toolbar(page);
		const tree = page.getByRole('tree');

		await expect(tree).toBeVisible();
		await expect(bar.getByText('5 changes')).toBeVisible();

		await control(page, 'Added').click();
		await expect(bar.getByText('3 changes')).toBeVisible();
		await expect(tree.getByText('zz-added.txt')).toHaveCount(0);

		await bar.getByRole('button', { name: 'Down' }).click();
		await expect(tree.getByRole('treeitem', { selected: true })).toContainText('file3.txt');

		await page.keyboard.press('Enter');
		await expect(page.getByRole('button', { name: 'Back to tree' })).toBeVisible();
		// The file's one change starts on its first line, so the view opens at it.
		await expect(bar.getByText('1 of 1')).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(tree).toBeVisible();
	});
});

test.describe('image diff', () => {
	test('compares two images and switches between the ways of showing them', async () => {
		const dir = tempDir();
		const left = join(dir, 'left.png');
		const right = join(dir, 'right.png');
		writePng(left, 80, 60, [40, 90, 160]);
		writePng(right, 80, 60, [40, 90, 160], { x: 10, y: 10, width: 20, height: 20, colour: [220, 60, 60] });
		const page = await start([left, right]);

		await expect(toolbar(page).getByText(/% different/)).toBeVisible();
		await expect(page.getByRole('img', { name: 'Differences' })).toBeVisible();

		await control(page, 'Onion skin').click();
		await expect(page.getByLabel('Opacity of right.png')).toBeVisible();

		await control(page, 'Swipe').click();
		const divider = page.getByRole('slider', { name: 'Swipe between the images' });
		await expect(divider).toHaveAttribute('aria-valuenow', '50');
		await divider.focus();
		await page.keyboard.press('Shift+ArrowRight');
		await expect(divider).toHaveAttribute('aria-valuenow', '60');

		await control(page, 'Side by side').click();
		await expect(page.getByRole('img', { name: 'left.png' })).toBeVisible();
		await expect(page.getByRole('img', { name: 'right.png' })).toBeVisible();
	});

	test('refuses text next to an image', async () => {
		const dir = tempDir();
		const image = join(dir, 'picture.png');
		const text = join(dir, 'notes.txt');
		writePng(image, 8, 8, [0, 0, 0]);
		writeFileSync(text, 'hello\n');
		const page = await start([image, text]);

		await expect(page.getByText('The other side is an image, so only an image can go here')).toBeVisible();
	});
});

test.describe('recent comparisons', () => {
	test('reopens a comparison from an earlier run', async () => {
		const profile = tempDir('comparer-e2e-profile-');
		const { left, right } = textPair(tempDir());

		let page = await start([left, right], profile);
		await expect(toolbar(page).getByText('5 changes')).toBeVisible();
		await app!.close();

		page = await start([], profile);
		const recent = page.locator('header').getByRole('button', { name: 'Recent comparisons' });
		await recent.click();
		await page.getByRole('menuitem', { name: /left\.txt ↔ right\.txt/ }).click();
		await expect(toolbar(page).getByText('5 changes')).toBeVisible();

		// Back in the editors, the entry can be taken off the list on its own.
		await page.locator('header').getByText('Editors', { exact: true }).click();
		await recent.click();
		await page.getByRole('button', { name: 'Remove left.txt ↔ right.txt from recent' }).click();
		await expect(recent).toHaveCount(0);
	});
});

test.describe('laser', () => {
	test('outlines the window in yellow while on, and remembers it', async () => {
		const profile = tempDir('comparer-e2e-profile-');
		let page = await start([], profile);
		const laser = page.locator('header').getByRole('button', { name: 'Laser border' });
		const border = page.locator('[data-laser=on]');

		await expect(border).toHaveCount(0);
		await laser.click();
		await expect(border).toBeVisible();
		await app!.close();

		page = await start([], profile);
		await expect(page.locator('[data-laser=on]')).toBeVisible();
	});
});
