import { Command, CommanderError } from 'commander';
import { resolvePaths } from './launch';

/**
 * The command line, parsed. Main-process only: the renderer never sees argv, and
 * importing this from there would pull a CLI parser into the window's bundle.
 *
 * Nothing here writes to the console or exits. Parsing answers with what should
 * happen — open a window, print something, or fail — and `main.ts` carries it out,
 * so all of this stays testable without a process to kill.
 */

export type CliContext = {
	/** A development run is `electron .`, where `.` is the app rather than something to compare. */
	packaged: boolean;
	appPath: string;
	cwd: string;
	/** Reported by `--version`. */
	version: string;
};

export type CliRequest =
	/** Open these, or show the empty window when there are none. */
	| { kind: 'open'; paths: string[] }
	/** Write this to stdout and exit successfully, as `--version` and `--help` do. */
	| { kind: 'print'; text: string }
	/** Write this to stderr and exit with a failure. */
	| { kind: 'fail'; message: string };

export function parseCli(argv: string[], context: CliContext): CliRequest {
	let output = '';
	const program = new Command();

	program
		.name('comparer')
		.description('Compare text files, folders and images side by side.')
		.argument('[left]', 'file, folder or image to compare')
		.argument('[right]', 'the one to compare it with')
		.version(context.version)
		// Electron and Chromium put their own flags in argv — --no-sandbox,
		// --user-data-dir=…, --inspect and more — and those are not this app's to
		// complain about. Unknown options fall through to the operands, where
		// `resolvePaths` drops anything that starts with a dash.
		//
		// A switch written with its value as a separate argument
		// (`--user-data-dir /tmp/x`) leaves that value among the operands, where it is
		// taken for a path. That matches Chromium, which pairs a value only in the `=`
		// form: given the spaced form it sets the switch to nothing and treats the token
		// as a positional, and Chrome itself would try to open it. Checked against
		// Electron — `--user-data-dir=X` moves the profile, `--user-data-dir X` does not.
		// Swallowing the token here would mean keeping a list of every Chromium switch
		// that takes a value, going stale as they come and go, and silently dropping an
		// argument that was typed.
		.allowUnknownOption()
		.allowExcessArguments()
		// Printing and exiting is the caller's job, so help and version come back as
		// errors carrying the text instead of stopping the process here.
		.exitOverride()
		.configureOutput({
			writeOut: (text) => (output += text),
			writeErr: (text) => (output += text)
		})
		.addHelpText(
			'after',
			`
Examples:
  comparer old.txt new.txt
  comparer before/ after/
  comparer shot-a.png shot-b.png`
		);

	try {
		program.parse(argv.slice(1), { from: 'user' });
	} catch (error) {
		if (!(error instanceof CommanderError)) throw error;
		// `--version` and `--help` stop parsing with a zero exit code; anything else is
		// a genuine misuse, and commander has already explained it in the output.
		const text = (output || error.message).trim();
		return error.exitCode === 0 ? { kind: 'print', text } : { kind: 'fail', message: text };
	}

	return { kind: 'open', paths: resolvePaths(program.args, context) };
}
