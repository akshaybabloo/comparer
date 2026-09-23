import { describe, expect, it } from 'vitest';
import { parseCli, type CliContext } from './cli';

describe('parseCli', () => {
	const dev: CliContext = {
		packaged: false,
		appPath: '/src/comparer',
		cwd: '/src/comparer',
		version: '0.0.0'
	};
	const packaged: CliContext = {
		packaged: true,
		appPath: '/opt/comparer/resources/app.asar',
		cwd: '/home/me/project',
		version: '1.2.3'
	};

	it('opens the two paths it was given', () => {
		expect(parseCli(['comparer', 'a.txt', '/tmp/b.txt'], packaged)).toEqual({
			kind: 'open',
			paths: ['/home/me/project/a.txt', '/tmp/b.txt']
		});
	});

	it('opens an empty window when given nothing', () => {
		expect(parseCli(['comparer'], packaged)).toEqual({ kind: 'open', paths: [] });
	});

	// Electron's own argv, as `pnpm start` and the packaged launchers produce it.
	it('ignores the flags Electron and Chromium add, and the app path in a development run', () => {
		expect(
			parseCli(['electron', '--no-sandbox', '--user-data-dir=/tmp/x', '--inspect', 'a.txt', 'b.txt', '.'], dev)
		).toEqual({ kind: 'open', paths: ['/src/comparer/a.txt', '/src/comparer/b.txt'] });
		expect(parseCli(['electron', '--no-sandbox', '.'], dev)).toEqual({ kind: 'open', paths: [] });
	});

	// Chromium pairs a switch with its value only in the `=` form. Given the spaced form
	// it sets the switch to nothing and leaves the token as a positional — checked against
	// Electron, where `--user-data-dir=X` moves the profile and `--user-data-dir X` does
	// not — so taking it for a path is what the browser does with the same command line.
	it('treats a switch value written as a separate argument as a path, as Chromium does', () => {
		expect(parseCli(['comparer', '--user-data-dir', '/tmp/profile'], packaged)).toEqual({
			kind: 'open',
			paths: ['/tmp/profile']
		});
	});

	it('leaves a comparison alone when a switch is written the way that sets it', () => {
		expect(parseCli(['comparer', '--user-data-dir=/tmp/profile', 'a.txt', 'b.txt'], packaged)).toEqual({
			kind: 'open',
			paths: ['/home/me/project/a.txt', '/home/me/project/b.txt']
		});
	});

	it('prints the version, on either spelling', () => {
		expect(parseCli(['comparer', '--version'], packaged)).toEqual({ kind: 'print', text: '1.2.3' });
		expect(parseCli(['comparer', '-V'], packaged)).toEqual({ kind: 'print', text: '1.2.3' });
	});

	it('reports the version it was handed, so a build reports what it is', () => {
		expect(parseCli(['comparer', '--version'], dev)).toEqual({ kind: 'print', text: '0.0.0' });
	});

	it('prints help describing the arguments and an example', () => {
		const help = parseCli(['comparer', '--help'], packaged);

		expect(help.kind).toBe('print');
		if (help.kind !== 'print') return;
		expect(help.text).toContain('Usage: comparer [options] [left] [right]');
		expect(help.text).toContain('Compare text files, folders and images side by side.');
		expect(help.text).toContain('comparer before/ after/');
	});
});
