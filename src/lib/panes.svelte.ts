import { detectLanguage, languageById, LANGUAGES, PLAIN_TEXT, type Language } from './languages';
import type { DocumentId, DocumentInfo } from '../shared/protocol';

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
 * One side of the comparison.
 *
 * The authoritative text lives in the diff service, not here: this holds an
 * id, plus however much of the document has been streamed in for display. That
 * is what keeps a 10 MB file off the renderer's heap until someone looks at it,
 * and keeps it off the wire entirely when comparing.
 */
export class PaneState {
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

  #reset(info: DocumentInfo) {
    this.docId = info.id;
    this.filename = info.name;
    this.path = info.path;
    this.totalSize = info.size;
    this.totalLines = info.lineCount;
    this.dirty = false;
    this.error = '';
  }

  loadFile(file: File) {
    return this.#open(
      () => window.comparer.openDroppedFile(file),
      `Reading ${file.name}…`,
      `Could not read ${file.name}`,
    );
  }

  /** Opens a file chosen in the native picker. Cancelling leaves the pane as it was. */
  pickFile() {
    return this.#open(() => window.comparer.pickFile(), 'Opening file…', 'Could not open the file');
  }

  async #open(request: () => Promise<DocumentInfo | null>, label: string, failure: string) {
    this.loading = true;
    this.loadingLabel = label;
    this.error = '';
    try {
      // Main reads the file; its contents never cross into the renderer except
      // as the slices requested below.
      const info = await request();
      if (!info) return;
      const previous = this.docId;
      this.#reset(info);
      if (previous && previous !== info.id) void window.comparer.close(previous);
      this.#languagePinned = false;
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

  /** Exchanges two panes wholesale, including their service documents. */
  static swap(a: PaneState, b: PaneState) {
    const snapshot = (pane: PaneState) => ({
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
      dirty: pane.dirty,
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
