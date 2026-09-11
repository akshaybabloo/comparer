<script lang="ts">
  import * as Select from '$lib/components/ui/select';
  import { Button } from '$lib/components/ui/button';
  import { darkEditorExtensions } from '$lib/editor-theme';
  import { formatBytes, formatCount } from '$lib/format';
  import { LANGUAGES } from '$lib/languages';
  import { HIGHLIGHT_LIMIT_BYTES, type PaneState } from '$lib/panes.svelte';
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
  import FileTextIcon from '@lucide/svelte/icons/file-text';
  import { untrack } from 'svelte';
  import XIcon from '@lucide/svelte/icons/x';

  type Props = {
    pane: PaneState;
    /** Shown in the empty state, e.g. "Drop the original file". */
    placeholder: string;
    /** Turns line wrapping on, shared with the other pane. */
    wrap: boolean;
  };

  let { pane, placeholder, wrap }: Props = $props();

  const languageCompartment = new Compartment();
  const editableCompartment = new Compartment();
  const wrapCompartment = new Compartment();

  let view: EditorView | null = $state(null);
  let dragDepth = $state(0);

  const currentLanguageLabel = $derived(
    LANGUAGES.find((language) => language.id === pane.languageId)?.label ?? 'Plain text',
  );
  const isDraggingOver = $derived(dragDepth > 0);

  /**
   * Mounts CodeMirror. An attachment rather than `onMount` so setup and
   * teardown are tied to the element's lifetime.
   */
  function codemirror(node: HTMLElement) {
    const instance = new EditorView({
      parent: node,
      state: EditorState.create({
        // `untrack` is essential: an attachment runs inside an effect, so a
        // tracked read of `pane.text` here would tear down and rebuild the
        // whole editor on every keystroke — losing focus after each character.
        // The document is kept in sync by the effect below instead.
        doc: untrack(() => pane.text),
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
          languageCompartment.of([]),
          editableCompartment.of([]),
          wrapCompartment.of([]),
          ...darkEditorExtensions,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
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

  // Replace the document only for changes that came from outside the editor (a
  // dropped file, or Clear). Typing already left the document correct, and the
  // equality check is what stops this from fighting the cursor.
  $effect(() => {
    const text = pane.text;
    const instance = view;
    if (!instance) return;
    if (instance.state.doc.toString() === text) return;
    instance.dispatch({
      changes: { from: 0, to: instance.state.doc.length, insert: text },
      selection: { anchor: 0 },
      scrollIntoView: true,
    });
  });

  // Swap the grammar when the language changes, or drop it when the document
  // grows past the highlighting budget.
  $effect(() => {
    const language = pane.language;
    const allowed = pane.highlightingAllowed;
    if (!view) return;

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
    const readOnly = pane.loading;
    view?.dispatch({
      effects: editableCompartment.reconfigure(EditorView.editable.of(!readOnly)),
    });
  });

  $effect(() => {
    const enabled = wrap;
    view?.dispatch({
      effects: wrapCompartment.reconfigure(enabled ? EditorView.lineWrapping : []),
    });
  });

  /*
   * Drag handling, in the capture phase.
   *
   * Capture matters because CodeMirror has its own file-drop support that
   * pastes the file's text at the cursor: left to bubble, it would race this
   * handler and land the content twice while never recording the filename or
   * language. Claiming the event on the way down keeps it away from there.
   */

  /**
   * Deliberately permissive: platforms advertise a file drag differently, and
   * X11 file managers can offer only `text/uri-list` where Chrome would
   * synthesise `Files`. Guessing wrong means `dragover` goes un-prevented,
   * and the browser then rejects the drop silently — no event, no error,
   * nothing loaded.
   */
  function isFileDrag(event: DragEvent) {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    return types.includes('Files') || types.includes('text/uri-list') || types.length === 0;
  }

  function onDragEnter(event: DragEvent) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth++;
  }

  function onDragOver(event: DragEvent) {
    if (!isFileDrag(event)) return;
    // Must be prevented on *every* dragover or the drop is rejected and the
    // window navigates to the file instead.
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave() {
    dragDepth = Math.max(0, dragDepth - 1);
  }

  async function onDrop(event: DragEvent) {
    // Always claim the drop: letting it through navigates the window to the file.
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;

    const file = event.dataTransfer?.files?.[0];
    if (!file) {
      const uri = event.dataTransfer?.getData('text/uri-list')?.trim();
      pane.error = uri
        ? `Could not read the dropped item (${uri.split('\n')[0]})`
        : 'The drop carried no file';
      return;
    }
    await pane.loadFile(file);
  }
</script>

<section class="bg-background flex min-h-0 min-w-0 flex-1 flex-col">
  <header class="bg-card flex h-9 shrink-0 items-center gap-2 border-b px-2.5">
    <FileTextIcon class="text-muted-foreground size-3.5 shrink-0" />
    <span class="truncate text-xs font-medium" title={pane.filename || placeholder}>
      {pane.filename || placeholder}
    </span>

    {#if !pane.isEmpty}
      <span class="text-muted-foreground shrink-0 text-[11px] tabular-nums">
        {formatCount(pane.lineCount)} lines · {formatBytes(pane.byteLength)}
      </span>
    {/if}

    <div class="ml-auto flex shrink-0 items-center gap-1.5">
      {#if !pane.highlightingAllowed && !pane.isEmpty}
        <span
          class="text-muted-foreground text-[11px]"
          title="Highlighting is off above {formatBytes(
            HIGHLIGHT_LIMIT_BYTES,
          )} so editing stays responsive"
        >
          highlighting off
        </span>
      {/if}

      <Select.Root
        type="single"
        value={pane.languageId}
        onValueChange={(value) => pane.pinLanguage(value)}
        items={LANGUAGES.map((language) => ({ value: language.id, label: language.label }))}
      >
        <Select.Trigger size="sm" class="w-36 text-xs" aria-label="Syntax highlighting">
          {currentLanguageLabel}
        </Select.Trigger>
        <Select.Content class="max-h-72">
          {#each LANGUAGES as language (language.id)}
            <Select.Item value={language.id} label={language.label}>{language.label}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>

      {#if !pane.isEmpty}
        <Button
          variant="ghost"
          size="icon"
          class="size-7"
          onclick={() => pane.clear()}
          aria-label="Clear this pane"
          title="Clear"
        >
          <XIcon class="size-3.5" />
        </Button>
      {/if}
    </div>
  </header>

  <!-- Drag handlers sit on the wrapper so the drop target covers the whole
       pane, including the gutter and the space below the last line. -->
  <div
    class="relative min-h-0 flex-1"
    ondragentercapture={onDragEnter}
    ondragovercapture={onDragOver}
    ondragleavecapture={onDragLeave}
    ondropcapture={onDrop}
    role="presentation"
  >
    <div class="h-full" {@attach codemirror}></div>

    {#if pane.isEmpty && !pane.loading}
      <div
        class="text-muted-foreground pointer-events-none absolute inset-0 grid place-items-center text-center"
      >
        <div class="space-y-1">
          <p class="text-sm">{placeholder}</p>
          <p class="text-[11px] opacity-70">or start typing</p>
        </div>
      </div>
    {/if}

    {#if pane.loading}
      <div class="bg-background/80 absolute inset-0 grid place-items-center backdrop-blur-sm">
        <p class="text-muted-foreground text-xs">Reading {pane.filename}…</p>
      </div>
    {/if}

    {#if isDraggingOver}
      <div
        class="border-brand bg-brand/10 pointer-events-none absolute inset-2 grid place-items-center rounded-lg border-2 border-dashed"
      >
        <p class="text-brand text-sm font-medium">Drop to load</p>
      </div>
    {/if}

    {#if pane.error}
      <div class="bg-del-bg text-del-ink absolute inset-x-2 bottom-2 rounded-md px-3 py-2 text-xs">
        {pane.error}
      </div>
    {/if}
  </div>
</section>
