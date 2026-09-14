import type { ImageSize } from './diff-types';
import { detectLanguage, languageById, LANGUAGES, PLAIN_TEXT, type Language } from './languages';
import type { DocumentId, DocumentInfo, OpenedInfo, PickKind } from '../shared/protocol';

export type PaneKind = OpenedInfo['kind'];

/** Why a pane refused an item: the other side holds a different kind of thing. */
const MISMATCH: Record<PaneKind, string> = {
	file: 'The other side is a text file, so only a text file can go here',
	image: 'The other side is an image, so only an image can go here',
	folder: 'The other side is a folder, so only a folder can go here'
};

/**
 * Above this size the grammar is dropped and the pane renders as plain text.
 * Parsers walk the whole document, and on a multi-megabyte file that turns
 * every keystroke into a visible stall.
 */
export const HIGHLIGHT_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * Bytes fetched per request while streaming a document into the editor.
 * Byte-based rather than line-based because the documents that most need
 * streaming — logs, minified bundles — can be a single enormous line.
 */
export const CHUNK_BYTES = 512 * 1024;

/**
 * One side of the comparison: a text document, an image, or a folder.
 *
 * The authoritative text lives in the diff service, not here: this holds an
 * id, plus however much of the document has been streamed in for display. That
 * is what keeps a 10 MB file off the renderer's heap until someone looks at it,
 * and keeps it off the wire entirely when comparing. A folder is held the same
 * way, as an id the service can walk, with nothing of its contents loaded here.
 * An image is the exception: its bytes are read once, to show a preview.
 *
 * Two panes are paired, and each only accepts the kind of thing the other holds,
 * since a text file, an image and a folder cannot be compared with one another.
 */
export class PaneState {
	/** An image or folder pane shows no editor, and compares only against its own kind. */
	kind = $state<PaneKind>('file');
	/** The slice currently loaded in the editor — a prefix of the document. */
	text = $state('');
	filename = $state('');
	/** Where the document was opened from, or null for text typed into the app. */
	path = $state<string | null>(null);
	loading = $state(false);
	/** What the loading overlay says, e.g. "Reading notes.txt…". */
	loadingLabel = $state('');
	error = $state('');

	/** Service-side document, or null for a pane that has never held one. */
	docId = $state<DocumentId | null>(null);
	/** Lines the document has in total, which may exceed what is loaded. */
	totalLines = $state(0);
	/** Bytes of the document currently loaded into the editor. */
	loadedBytes = $state(0);
	/** Bytes of the whole document, not just the loaded part. */
	totalSize = $state(0);
	/** Every line is loaded, so the editor holds the complete document. */
	fullyLoaded = $state(true);
	/** Edited in the editor, so the service copy is stale. */
	dirty = $state(false);

	/** Object URL of the image's bytes, for its preview; null unless this is an image. */
	imageUrl = $state<string | null>(null);
	/** The image's pixel size, known once its preview has loaded. */
	imageSize = $state<ImageSize | null>(null);
	/** The preview's scale, or null to fit it to the pane. */
	previewZoom = $state<number | null>(null);

	/** The other side of the comparison, which decides what this pane accepts. */
	#partner = $state<PaneState | null>(null);

	/** Inferred from the dropped file's name, unless overridden in the picker. */
	languageId = $state(PLAIN_TEXT.id);
	/**
	 * Set by a manual pick, and scoped to the document on screen: a newly
	 * dropped file clears it, so picking a language once never stops later
	 * files from being detected.
	 */
	#languagePinned = $state(false);

	readonly language = $derived<Language>(languageById(this.languageId));
	readonly byteLength = $derived(this.totalSize);
	readonly highlightingAllowed = $derived(this.byteLength <= HIGHLIGHT_LIMIT_BYTES);
	readonly lineCount = $derived(this.totalLines);
	readonly isEmpty = $derived(this.docId === null && this.text.length === 0);
	readonly pendingBytes = $derived(Math.max(0, this.totalSize - this.loadedBytes));

	readonly isFolder = $derived(this.kind === 'folder');
	readonly isImage = $derived(this.kind === 'image');
	/** What this pane holds, or null while it holds nothing. Typed text is a `file`. */
	readonly heldKind = $derived<PaneKind | null>(this.isEmpty ? null : this.kind);
	/** The only kind this pane may take, because the other side holds it; null for any. */
	readonly requiredKind = $derived<PaneKind | null>(this.#partner?.heldKind ?? null);
	/** Text can be typed here: nothing on the other side rules it out. */
	readonly acceptsText = $derived(this.requiredKind === null || this.requiredKind === 'file');

	/** Makes each pane accept only the kind of thing the other holds. */
	static pair(a: PaneState, b: PaneState) {
		a.#partner = b;
		b.#partner = a;
	}

	#reset(info: OpenedInfo) {
		this.#setImageUrl(null);
		this.kind = info.kind;
		this.docId = info.id;
		this.filename = info.name;
		this.path = info.path;
		// A folder's size and line count are not known without walking it.
		this.totalSize = info.kind === 'folder' ? 0 : info.size;
		this.totalLines = info.kind === 'file' ? info.lineCount : 0;
		this.dirty = false;
		this.error = '';
	}

	loadFile(file: File) {
		return this.#open(
			() => window.comparer.openDroppedFile(file),
			`Reading ${file.name}…`,
			`Could not read ${file.name}`
		);
	}

	/**
	 * Opens a file chosen in the native picker, which offers only images for `'image'`.
	 * Cancelling leaves the pane as it was.
	 */
	pickFile(kind: PickKind = 'file') {
		return this.#open(() => window.comparer.pickFile(kind), 'Opening file…', 'Could not open the file');
	}

	/**
	 * Takes on a document the service already opened, without streaming any of
	 * it in. For a pane that is diffed but never shown in an editor, such as one
	 * side of a file opened from a folder comparison.
	 */
	hold(info: DocumentInfo) {
		const previous = this.docId;
		this.#reset(info);
		if (previous && previous !== info.id) void window.comparer.close(previous);
		this.text = '';
		this.loadedBytes = 0;
		this.fullyLoaded = info.size === 0;
	}

	/** Opens a folder chosen in the native picker. Cancelling leaves the pane as it was. */
	pickFolder() {
		return this.#open(() => window.comparer.pickFolder(), 'Opening folder…', 'Could not open the folder');
	}

	async #open(request: () => Promise<OpenedInfo | null>, label: string, failure: string) {
		this.loading = true;
		this.loadingLabel = label;
		this.error = '';
		try {
			// Main reads the file; its contents never cross into the renderer except
			// as the slices requested below.
			const info = await request();
			if (!info) return;
			// Checked only once the service has looked at the item, since whether a
			// dropped file is an image depends on its contents rather than its name.
			const required = this.requiredKind;
			if (required && info.kind !== required) {
				void window.comparer.close(info.id);
				throw new Error(MISMATCH[required]);
			}
			const previous = this.docId;
			this.#reset(info);
			if (previous && previous !== info.id) void window.comparer.close(previous);
			this.#languagePinned = false;

			if (info.kind !== 'file') {
				this.languageId = PLAIN_TEXT.id;
				this.text = '';
				this.loadedBytes = 0;
				this.fullyLoaded = true;
				this.previewZoom = null;
				if (info.kind === 'image') {
					const bytes = await window.comparer.readImage(info.id);
					// A newer drop may have replaced this image while its bytes were on the way.
					if (this.docId === info.id) this.#setImageUrl(URL.createObjectURL(new Blob([bytes as BlobPart])));
				}
				return;
			}

			this.languageId = detectLanguage(info.name).id;

			const chunk = await window.comparer.readChunk(info.id, 0, CHUNK_BYTES);
			this.text = chunk.text;
			this.loadedBytes = chunk.to;
			this.fullyLoaded = chunk.atEnd;
		} catch (error) {
			this.error = error instanceof Error ? error.message : failure;
		} finally {
			this.loading = false;
		}
	}

	/** Appends the next slice, for when the editor scrolls near the end. */
	async loadMore() {
		if (this.fullyLoaded || this.loading || !this.docId || this.dirty) return;
		this.loading = true;
		this.loadingLabel = `Reading ${this.filename}…`;
		try {
			const chunk = await window.comparer.readChunk(this.docId, this.loadedBytes, CHUNK_BYTES);
			if (chunk.text) this.text += chunk.text;
			this.loadedBytes = chunk.to;
			this.fullyLoaded = chunk.atEnd;
		} catch (error) {
			this.error = error instanceof Error ? error.message : 'Could not read more of this file';
		} finally {
			this.loading = false;
		}
	}

	/** Pulls in the whole document, which editing requires. */
	async loadAll() {
		while (!this.fullyLoaded && !this.error) {
			await this.loadMore();
		}
	}

	/**
	 * Mirrors a CodeMirror edit. The service copy is now stale, so it is pushed
	 * back before the next comparison rather than on every keystroke.
	 */
	setTextFromEditor(next: string) {
		this.text = next;
		if (this.docId !== null || next.length > 0) this.dirty = true;
		this.totalSize = next.length;
		this.totalLines = countLines(next);
		this.loadedBytes = next.length;
		this.fullyLoaded = true;
	}

	/** Brings the service copy back in step, returning the id to diff against. */
	async sync(): Promise<DocumentId | null> {
		if (!this.dirty) return this.docId;
		if (this.text.length === 0 && this.docId === null) return null;

		const info = await window.comparer.adoptText(this.docId, this.text, this.filename || 'untitled');
		this.#reset(info);
		this.loadedBytes = info.size;
		this.fullyLoaded = true;
		return info.id;
	}

	pinLanguage(id: string) {
		// The picker can report values that are not languages, such as the empty
		// string a cleared selection produces; those would silently fall back to
		// plain text and pin it.
		if (!LANGUAGES.some((language) => language.id === id)) return;
		this.languageId = id;
		this.#languagePinned = true;
	}

	/** Replaces the preview URL, releasing the one it replaces. */
	#setImageUrl(url: string | null) {
		if (this.imageUrl && this.imageUrl !== url) URL.revokeObjectURL(this.imageUrl);
		this.imageUrl = url;
		this.imageSize = null;
	}

	/** Exchanges two panes wholesale, including their service documents. */
	static swap(a: PaneState, b: PaneState) {
		const snapshot = (pane: PaneState) => ({
			kind: pane.kind,
			imageUrl: pane.imageUrl,
			imageSize: pane.imageSize,
			previewZoom: pane.previewZoom,
			text: pane.text,
			filename: pane.filename,
			path: pane.path,
			languageId: pane.languageId,
			languagePinned: pane.#languagePinned,
			docId: pane.docId,
			totalLines: pane.totalLines,
			loadedBytes: pane.loadedBytes,
			totalSize: pane.totalSize,
			fullyLoaded: pane.fullyLoaded,
			dirty: pane.dirty
		});
		const restore = (pane: PaneState, { languagePinned, ...rest }: ReturnType<typeof snapshot>) => {
			Object.assign(pane, rest);
			pane.#languagePinned = languagePinned;
		};

		const left = snapshot(a);
		const right = snapshot(b);
		restore(a, right);
		restore(b, left);
	}

	clear() {
		const previous = this.docId;
		this.#setImageUrl(null);
		this.previewZoom = null;
		this.kind = 'file';
		this.text = '';
		this.filename = '';
		this.path = null;
		this.languageId = PLAIN_TEXT.id;
		this.#languagePinned = false;
		this.error = '';
		this.docId = null;
		this.totalLines = 0;
		this.loadedBytes = 0;
		this.totalSize = 0;
		this.fullyLoaded = true;
		this.dirty = false;
		if (previous) void window.comparer.close(previous);
	}
}

function countLines(text: string): number {
	if (text === '') return 0;
	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) lines++;
	}
	return lines;
}
