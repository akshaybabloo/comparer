import type { Extension } from '@codemirror/state';

/**
 * A syntax highlighting mode the user can pick, or that we infer from a
 * dropped file's extension.
 *
 * Grammars are loaded on demand: bundling every one of them eagerly would add
 * megabytes to a window that usually needs one or two of them.
 */
export type Language = {
	id: string;
	label: string;
	/** Extensions without the leading dot, lowercase. */
	extensions: string[];
	/** Exact filenames (lowercase) that imply this language, e.g. `Dockerfile`. */
	filenames?: string[];
	load: () => Promise<Extension>;
};

/** Wraps a CodeMirror 5 style stream parser as a modern language. */
async function stream(load: () => Promise<{ parser: unknown }>): Promise<Extension> {
	const [{ StreamLanguage }, mod] = await Promise.all([import('@codemirror/language'), load()]);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return StreamLanguage.define(mod.parser as any);
}

export const PLAIN_TEXT: Language = {
	id: 'plaintext',
	label: 'Plain text',
	extensions: ['txt', 'text', 'log'],
	load: async () => []
};

export const LANGUAGES: Language[] = [
	PLAIN_TEXT,
	{
		id: 'javascript',
		label: 'JavaScript',
		extensions: ['js', 'mjs', 'cjs', 'jsx'],
		load: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true })
	},
	{
		id: 'typescript',
		label: 'TypeScript',
		extensions: ['ts', 'mts', 'cts', 'tsx'],
		load: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true })
	},
	{
		id: 'json',
		label: 'JSON',
		extensions: ['json', 'jsonc', 'json5', 'webmanifest'],
		load: async () => (await import('@codemirror/lang-json')).json()
	},
	{
		id: 'html',
		label: 'HTML',
		extensions: ['html', 'htm', 'vue', 'svelte'],
		load: async () => (await import('@codemirror/lang-html')).html()
	},
	{
		id: 'css',
		label: 'CSS',
		extensions: ['css', 'scss', 'less', 'pcss'],
		load: async () => (await import('@codemirror/lang-css')).css()
	},
	{
		id: 'python',
		label: 'Python',
		extensions: ['py', 'pyi', 'pyw'],
		load: async () => (await import('@codemirror/lang-python')).python()
	},
	{
		id: 'rust',
		label: 'Rust',
		extensions: ['rs'],
		load: async () => (await import('@codemirror/lang-rust')).rust()
	},
	{
		id: 'go',
		label: 'Go',
		extensions: ['go'],
		load: async () => (await import('@codemirror/lang-go')).go()
	},
	{
		id: 'markdown',
		label: 'Markdown',
		extensions: ['md', 'markdown', 'mdx'],
		load: async () => (await import('@codemirror/lang-markdown')).markdown()
	},
	{
		id: 'xml',
		label: 'XML',
		extensions: ['xml', 'svg', 'xsd', 'xsl', 'plist', 'csproj'],
		load: async () => (await import('@codemirror/lang-xml')).xml()
	},
	{
		id: 'yaml',
		label: 'YAML',
		extensions: ['yaml', 'yml'],
		load: async () => (await import('@codemirror/lang-yaml')).yaml()
	},
	{
		id: 'sql',
		label: 'SQL',
		extensions: ['sql', 'ddl'],
		load: async () => (await import('@codemirror/lang-sql')).sql()
	},
	{
		id: 'java',
		label: 'Java',
		extensions: ['java'],
		load: async () => (await import('@codemirror/lang-java')).java()
	},
	{
		id: 'cpp',
		label: 'C / C++',
		extensions: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx'],
		load: async () => (await import('@codemirror/lang-cpp')).cpp()
	},
	{
		id: 'php',
		label: 'PHP',
		extensions: ['php', 'phtml'],
		load: async () => (await import('@codemirror/lang-php')).php()
	},
	{
		id: 'csharp',
		label: 'C#',
		extensions: ['cs'],
		load: () => stream(async () => ({ parser: (await import('@codemirror/legacy-modes/mode/clike')).csharp }))
	},
	{
		id: 'shell',
		label: 'Shell',
		extensions: ['sh', 'bash', 'zsh', 'fish', 'ksh'],
		filenames: ['.bashrc', '.zshrc', '.profile', '.bash_profile'],
		load: () => stream(async () => ({ parser: (await import('@codemirror/legacy-modes/mode/shell')).shell }))
	},
	{
		id: 'powershell',
		label: 'PowerShell',
		extensions: ['ps1', 'psm1', 'psd1'],
		load: () => stream(async () => ({ parser: (await import('@codemirror/legacy-modes/mode/powershell')).powerShell }))
	},
	{
		id: 'toml',
		label: 'TOML',
		extensions: ['toml'],
		filenames: ['cargo.lock'],
		load: () => stream(async () => ({ parser: (await import('@codemirror/legacy-modes/mode/toml')).toml }))
	},
	{
		id: 'ini',
		label: 'INI / Properties',
		extensions: ['ini', 'cfg', 'conf', 'properties', 'editorconfig'],
		load: () => stream(async () => ({ parser: (await import('@codemirror/legacy-modes/mode/properties')).properties }))
	},
	{
		id: 'dockerfile',
		label: 'Dockerfile',
		extensions: ['dockerfile'],
		filenames: ['dockerfile', 'containerfile'],
		load: () => stream(async () => ({ parser: (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile }))
	},
	{
		id: 'ruby',
		label: 'Ruby',
		extensions: ['rb', 'rake', 'gemspec'],
		filenames: ['gemfile', 'rakefile'],
		load: () => stream(async () => ({ parser: (await import('@codemirror/legacy-modes/mode/ruby')).ruby }))
	},
	{
		id: 'lua',
		label: 'Lua',
		extensions: ['lua'],
		load: () => stream(async () => ({ parser: (await import('@codemirror/legacy-modes/mode/lua')).lua }))
	},
	{
		id: 'perl',
		label: 'Perl',
		extensions: ['pl', 'pm'],
		load: () => stream(async () => ({ parser: (await import('@codemirror/legacy-modes/mode/perl')).perl }))
	},
	{
		id: 'r',
		label: 'R',
		extensions: ['r'],
		load: () => stream(async () => ({ parser: (await import('@codemirror/legacy-modes/mode/r')).r }))
	},
	{
		id: 'swift',
		label: 'Swift',
		extensions: ['swift'],
		load: () => stream(async () => ({ parser: (await import('@codemirror/legacy-modes/mode/swift')).swift }))
	},
	{
		id: 'haskell',
		label: 'Haskell',
		extensions: ['hs', 'lhs'],
		load: () => stream(async () => ({ parser: (await import('@codemirror/legacy-modes/mode/haskell')).haskell }))
	},
	{
		id: 'nginx',
		label: 'Nginx',
		extensions: ['nginx'],
		load: () => stream(async () => ({ parser: (await import('@codemirror/legacy-modes/mode/nginx')).nginx }))
	},
	{
		id: 'diff',
		label: 'Diff / Patch',
		extensions: ['diff', 'patch'],
		load: () => stream(async () => ({ parser: (await import('@codemirror/legacy-modes/mode/diff')).diff }))
	}
].sort((a, b) => (a.id === PLAIN_TEXT.id ? -1 : b.id === PLAIN_TEXT.id ? 1 : a.label.localeCompare(b.label)));

const BY_EXTENSION = new Map<string, Language>();
const BY_FILENAME = new Map<string, Language>();
for (const language of LANGUAGES) {
	for (const extension of language.extensions) {
		// First registration wins, so `ts` stays TypeScript rather than any later
		// language that also claims it.
		if (!BY_EXTENSION.has(extension)) BY_EXTENSION.set(extension, language);
	}
	for (const filename of language.filenames ?? []) {
		if (!BY_FILENAME.has(filename)) BY_FILENAME.set(filename, language);
	}
}

export function languageById(id: string): Language {
	return LANGUAGES.find((language) => language.id === id) ?? PLAIN_TEXT;
}

/**
 * Infers a language from a filename. Falls back to plain text, which is also
 * the right answer for the extension-less files people drop on a diff tool.
 */
export function detectLanguage(filename: string): Language {
	const name = filename.toLowerCase().replace(/^.*[\\/]/, '');

	const byName = BY_FILENAME.get(name);
	if (byName) return byName;

	const dot = name.lastIndexOf('.');
	if (dot <= 0) {
		// No extension at all: `Dockerfile`, `Makefile`, `README`. The filename map
		// above already had its chance, so treat the whole name as the extension.
		return BY_EXTENSION.get(name) ?? PLAIN_TEXT;
	}
	return BY_EXTENSION.get(name.slice(dot + 1)) ?? PLAIN_TEXT;
}
