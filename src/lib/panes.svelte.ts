import { detectLanguage, languageById, PLAIN_TEXT, type Language } from './languages';

/**
 * Above this size the grammar is dropped and the pane renders as plain text.
 * Tree-sitter style parsers walk the whole document, and on a multi-megabyte
 * file that turns every keystroke into a visible stall.
 */
export const HIGHLIGHT_LIMIT_BYTES = 2 * 1024 * 1024;

/** Refuse outright rather than hang the renderer on something absurd. */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;

/**
 * One side of the comparison: its text, where the text came from, and which
 * grammar to colour it with.
 */
export class PaneState {
  text = $state('');
  filename = $state('');
  loading = $state(false);
  error = $state('');

  /** Chosen in the picker, or inferred when a file is dropped. */
  languageId = $state(PLAIN_TEXT.id);
  /** True once the user picks a language, so a later drop stops overriding it. */
  #languagePinned = $state(false);

  readonly language = $derived<Language>(languageById(this.languageId));
  readonly byteLength = $derived(this.text.length);
  readonly highlightingAllowed = $derived(this.byteLength <= HIGHLIGHT_LIMIT_BYTES);

  readonly lineCount = $derived.by(() => {
    if (this.text === '') return 0;
    let lines = 1;
    for (let i = 0; i < this.text.length; i++) {
      if (this.text.charCodeAt(i) === 10) lines++;
    }
    return lines;
  });

  readonly isEmpty = $derived(this.text.length === 0);

  /**
   * Mirrors a CodeMirror edit into pane state. The editor's document is already
   * correct, so the component's sync effect sees matching text and leaves the
   * cursor alone.
   */
  setTextFromEditor(next: string) {
    this.text = next;
  }

  /** Picking a language by hand pins it against later auto-detection. */
  pinLanguage(id: string) {
    this.languageId = id;
    this.#languagePinned = true;
  }

  async loadFile(file: File) {
    this.loading = true;
    this.error = '';
    try {
      if (file.size > MAX_FILE_BYTES) {
        throw new Error(`${file.name} is too large to open (limit is 256 MB)`);
      }
      const text = await file.text();
      this.text = text;
      this.filename = file.name;
      if (!this.#languagePinned) this.languageId = detectLanguage(file.name).id;
    } catch (error) {
      this.error = error instanceof Error ? error.message : `Could not read ${file.name}`;
    } finally {
      this.loading = false;
    }
  }

  clear() {
    this.text = '';
    this.filename = '';
    this.error = '';
  }
}
