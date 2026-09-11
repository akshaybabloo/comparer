<script lang="ts">
  import { darkEditorExtensions } from '$lib/editor-theme';
  import { HIGHLIGHT_LIMIT_BYTES, type PaneState } from '$lib/panes.svelte';
  import { Select, type SelectOption } from '$lib/components/ui/select';
  import { formatBytes, formatCount } from '$lib/utils';
  import { LANGUAGES } from '$lib/languages';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { bracketMatching, foldGutter, indentOnInput, indentUnit } from '@codemirror/language';
  import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
  import { Compartment, EditorState } from '@codemirror/state';
  import {
    EditorView,
    drawSelection,
    highlightActiveLine,
    highlightActiveLineGutter,
    keymap,
    lineNumbers,
    rectangularSelection,
  } from '@codemirror/view';
  import FileText from '@lucide/svelte/icons/file-text';
  import X from '@lucide/svelte/icons/x';

  type Props = {
    pane: PaneState;
    /** Shown in the empty state, e.g. "Drop the original file". */
    placeholder: string;
  };

  let { pane, placeholder }: Props = $props();

  const languageOptions: SelectOption[] = LANGUAGES.map((language) => ({
    value: language.id,
    label: language.label,
  }));

  const languageCompartment = new Compartment();
  const editableCompartment = new Compartment();

  let view: EditorView | null = $state(null);
  let dragDepth = $state(0);

  /**
   * Mounts CodeMirror. Using an attachment rather than `onMount` keeps setup
   * and teardown tied to the element's lifetime.
   */
  function codemirror(node: HTMLElement) {
    const instance = new EditorView({
      parent: node,
      state: EditorState.create({
        doc: pane.text,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          foldGutter(),
          history(),
          drawSelection(),
          rectangularSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightSelectionMatches(),
          search({ top: true }),
          indentUnit.of('  '),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.lineWrapping,
          languageCompartment.of([]),
          editableCompartment.of([]),
          ...darkEditorExtensions,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            // Mark the text as locally edited so the doc-sync effect below
            // does not treat this as an external change and reset the cursor.
            pane.setTextFromEditor(update.state.doc.toString());
          }),
        ],
      }),
    });

    view = instance;
    return () => {
      instance.destroy();
      view = null;
    };
  }

  // Replace the document only when the change came from outside the editor
  // (a dropped file, or Clear), never on every keystroke.
  $effect(() => {
    const text = pane.text;
    const instance = view;
    if (!instance || pane.editedInEditor) return;
    if (instance.state.doc.toString() === text) return;
    instance.dispatch({
      changes: { from: 0, to: instance.state.doc.length, insert: text },
      selection: { anchor: 0 },
      scrollIntoView: true,
    });
  });

  // Swap the grammar when the language or the highlight budget changes.
  $effect(() => {
    const instance = view;
    const language = pane.language;
    const allowed = pane.highlightingAllowed;
    if (!instance) return;

    let cancelled = false;
    void (allowed ? language.load() : Promise.resolve([])).then((extension) => {
      if (cancelled || !view) return;
      view.dispatch({ effects: languageCompartment.reconfigure(extension) });
    });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const instance = view;
    const readOnly = pane.loading;
    if (!instance) return;
    instance.dispatch({
      effects: editableCompartment.reconfigure(EditorView.editable.of(!readOnly)),
    });
  });

  function onDragEnter(event: DragEvent) {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    dragDepth++;
  }

  function onDragOver(event: DragEvent) {
    if (!event.dataTransfer?.types.includes('Files')) return;
    // Without this the browser navigates to the file instead of dropping it.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave() {
    dragDepth = Math.max(0, dragDepth - 1);
  }

  async function onDrop(event: DragEvent) {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    event.preventDefault();
    dragDepth = 0;
    await pane.loadFile(file);
  }

  const isDraggingOver = $derived(dragDepth > 0);
</script>

<section class="bg-surface-0 flex min-h-0 min-w-0 flex-1 flex-col">
  <header
    class="border-surface-2 bg-surface-1 flex h-9 shrink-0 items-center gap-2 border-b px-2.5"
  >
    <FileText class="text-ink-faint size-3.5 shrink-0" />
    <span class="text-ink truncate text-xs font-medium" title={pane.filename || placeholder}>
      {pane.filename || placeholder}
    </span>

    {#if pane.text}
      <span class="text-ink-faint shrink-0 text-[11px] tabular-nums">
        {formatCount(pane.lineCount)} lines · {formatBytes(pane.byteLength)}
      </span>
    {/if}

    <div class="ml-auto flex shrink-0 items-center gap-1.5">
      {#if !pane.highlightingAllowed && pane.text}
        <span
          class="text-ink-faint text-[11px]"
          title="Syntax highlighting is off above {formatBytes(
            HIGHLIGHT_LIMIT_BYTES,
          )} so editing stays responsive"
        >
          highlighting off
        </span>
      {/if}

      <Select
        bind:value={pane.languageId}
        options={languageOptions}
        label="Syntax highlighting"
        class="w-36"
      />

      {#if pane.text}
        <button
          type="button"
          onclick={() => pane.clear()}
          class="text-ink-faint hover:bg-surface-2 hover:text-ink grid size-6 place-items-center rounded transition-colors"
          aria-label="Clear this pane"
          title="Clear"
        >
          <X class="size-3.5" />
        </button>
      {/if}
    </div>
  </header>

  <!-- Drag events are on the wrapper so the drop zone covers the whole pane,
       including the gutter and the empty space below the last line. -->
  <div
    class="relative min-h-0 flex-1"
    ondragenter={onDragEnter}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
    role="presentation"
  >
    <div class="h-full" {@attach codemirror}></div>

    {#if !pane.text && !pane.loading}
      <div
        class="text-ink-faint pointer-events-none absolute inset-0 grid place-items-center text-center"
      >
        <div class="space-y-1">
          <p class="text-ink-dim text-sm">{placeholder}</p>
          <p class="text-[11px]">or start typing</p>
        </div>
      </div>
    {/if}

    {#if pane.loading}
      <div class="bg-surface-0/80 absolute inset-0 grid place-items-center backdrop-blur-sm">
        <p class="text-ink-dim text-xs">Reading {pane.filename}…</p>
      </div>
    {/if}

    {#if isDraggingOver}
      <div
        class="border-accent bg-accent/10 pointer-events-none absolute inset-2 grid place-items-center rounded-lg border-2 border-dashed"
      >
        <p class="text-accent text-sm font-medium">Drop to load</p>
      </div>
    {/if}

    {#if pane.error}
      <div class="bg-del-bg text-del-ink absolute inset-x-2 bottom-2 rounded-md px-3 py-2 text-xs">
        {pane.error}
      </div>
    {/if}
  </div>
</section>
