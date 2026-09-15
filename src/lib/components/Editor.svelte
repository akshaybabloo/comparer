<script lang="ts">
	import * as InputGroup from '$lib/components/ui/input-group';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import ChangeStrip from '$lib/components/ChangeStrip.svelte';
	import ImageViewport from '$lib/components/ImageViewport.svelte';
	import ZoomControl from '$lib/components/ZoomControl.svelte';
	import { lineAtScroll, type EditorSync } from '$lib/editor-sync.svelte';
	import { darkEditorExtensions } from '$lib/editor-theme';
	import { formatBytes, formatCount } from '$lib/format';
	import { clampZoom, fitZoom } from '$lib/image-zoom';
	import { LANGUAGES } from '$lib/languages';
	import type { Side } from '$lib/line-alignment';
	import { measureText, STRIP_COLUMNS, type StripLine } from '$lib/minimap';
	import { HIGHLIGHT_LIMIT_BYTES, type PaneState } from '$lib/panes.svelte';
	import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
	import { bracketMatching, foldGutter, indentOnInput, indentUnit } from '@codemirror/language';
	import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
	import { Annotation, Compartment, EditorState } from '@codemirror/state';
	import {
		EditorView,
		drawSelection,
		highlightActiveLine,
		highlightActiveLineGutter,
		keymap,
		lineNumbers,
		rectangularSelection
	} from '@codemirror/view';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import ImageIcon from '@lucide/svelte/icons/image';
	import SaveIcon from '@lucide/svelte/icons/save';
	import { tick, untrack } from 'svelte';
	import XIcon from '@lucide/svelte/icons/x';

	type Props = {
		pane: PaneState;
		/** Shown in the empty state, e.g. "Drop the original file or folder here". */
		placeholder: string;
		/** Turns line wrapping on, shared with the other pane. */
		wrap: boolean;
		/** Which side of the comparison this is. */
		side: Side;
		/** Keeps this editor level with the other one, and supplies its minimap's change marks. */
		sync: EditorSync;
	};

	let { pane, placeholder, wrap, side, sync }: Props = $props();

	/**
	 * Marks transactions this component dispatched itself — streaming a chunk in,
	 * or replacing the document after a drop. Without it the update listener
	 * treats our own writes as user edits, which marks the pane dirty and
	 * "fully loaded", silently ending the streaming of the rest of the file.
	 */
	const Programmatic = Annotation.define<boolean>();

	/** Writes the pane to its file, or asks where when it has none or `saveAs` is set. */
	async function save(saveAs = false) {
		try {
			await pane.save(saveAs);
		} catch (error) {
			pane.error = error instanceof Error ? error.message : 'Could not save the file';
		}
	}

	const languageCompartment = new Compartment();
	const editableCompartment = new Compartment();
	const wrapCompartment = new Compartment();

	let view: EditorView | null = $state(null);
	let dragDepth = $state(0);
	let pathInput: HTMLInputElement | null = $state(null);
	let bodyWidth = $state(0);
	let bodyHeight = $state(0);

	/*
	 * The editor's layout lives in CodeMirror rather than in Svelte state, so the minimap
	 * reads it again whenever these counters move: `layout` when the document or its line
	 * heights change, `scrolled` when the view scrolls. Each is bumped at most once a frame.
	 */
	let layout = $state(0);
	let scrolled = $state(0);
	/** Moves on every change to the document, which is all that changes the minimap's lines. */
	let docRevision = $state(0);
	let layoutFrame = 0;
	let scrollFrame = 0;

	function layoutChanged() {
		layoutFrame ||= requestAnimationFrame(() => {
			layoutFrame = 0;
			layout++;
		});
	}

	function viewScrolled() {
		scrollFrame ||= requestAnimationFrame(() => {
			scrollFrame = 0;
			scrolled++;
		});
	}

	/*
	 * The editor's minimap measures in lines rather than pixels. The editor only estimates
	 * the height of a wrapped line until it draws it, and corrects the estimate as lines
	 * scroll into view; measured in pixels, each correction re-scaled the whole minimap and
	 * shifted which line every row of it showed, so it shimmered while scrolling. In lines,
	 * a line always sits on the same row, and the scale follows the file's full line count,
	 * known before a large file has finished streaming in.
	 */

	/** Minimap pixels a line may take at most, so a short file is drawn as lines rather than blocks. */
	const STRIP_LINE_PX = 3;

	/**
	 * The zero-based line at a position for the minimap, which shows only the text here:
	 * differences are coloured once the files are compared, in the diff view. Only the first
	 * columns of the line are read, since taking a whole megabyte-long line out of the
	 * document for every row of the minimap would stall it. Lines still streaming in have
	 * no text yet.
	 */
	function stripLineAt(position: number): StripLine | null {
		const doc = view?.state.doc;
		const index = Math.floor(position);
		if (!doc || index < 0 || index >= doc.lines) return null;
		const line = doc.line(index + 1);
		const text = doc.sliceString(line.from, Math.min(line.to, line.from + STRIP_COLUMNS));
		return { top: index, bottom: index + 1, cells: [{ ...measureText(text), kind: null }] };
	}

	/**
	 * What the minimap shows is on screen, against the height of the whole file. While a file
	 * is still streaming in, lines not yet loaded count at the average height of those that
	 * are — otherwise every chunk arriving would squeeze the minimap's lines closer together.
	 */
	const stripView = $derived.by(() => {
		void layout;
		void scrolled;
		if (!view) return { total: 0, start: 0, end: 0 };
		const scroller = view.scrollDOM;
		return {
			total: Math.max(pane.totalLines, view.state.doc.lines),
			start: lineAtScroll(view, scroller.scrollTop),
			end: lineAtScroll(view, scroller.scrollTop + scroller.clientHeight)
		};
	});

	let jumpToken = 0;

	/**
	 * Scrolls the minimap's chosen line to the middle of the editor. A line past what has
	 * streamed in so far loads more of the file first, until it is there.
	 */
	async function jump(line: number) {
		const token = ++jumpToken;
		const instance = view;
		if (!instance) return;
		while (!pane.fullyLoaded && !pane.error && instance.state.doc.lines <= line) {
			// A newer jump, such as the next step of a drag, takes over.
			if (token !== jumpToken) return;
			if (pane.loading) await new Promise(requestAnimationFrame);
			else {
				await pane.loadMore();
				await tick();
			}
		}
		if (token !== jumpToken) return;
		const doc = instance.state.doc;
		const index = Math.min(doc.lines - 1, Math.max(0, Math.floor(line)));
		const block = instance.lineBlockAt(doc.line(index + 1).from);
		const scroller = instance.scrollDOM;
		const y = instance.documentPadding.top + block.top + (line - index) * block.height;
		scroller.scrollTop = y - scroller.clientHeight / 2;
	}

	/** The scale an image preview is drawn at: the pane's chosen zoom, or whatever fits. */
	const previewScale = $derived(pane.previewZoom ?? fitZoom(bodyWidth, bodyHeight, pane.imageSize));

	/** What the empty pane asks for, which narrows once the other side holds something. */
	const emptyPrompt = $derived(
		pane.requiredKind === 'image'
			? 'Drop an image here'
			: pane.requiredKind === 'folder'
				? 'Drop a folder here'
				: placeholder
	);

	// A long path overflows the field; scroll it to the end so the filename and
	// its nearest folders stay visible rather than the drive or home directory.
	$effect(() => {
		const path = pane.path;
		if (!pathInput || !path) return;
		pathInput.scrollLeft = pathInput.scrollWidth;
	});

	const currentLanguageLabel = $derived(
		LANGUAGES.find((language) => language.id === pane.languageId)?.label ?? 'Plain text'
	);
	const isDraggingOver = $derived(dragDepth > 0);

	/**
	 * Requests the next slice when the reader is within a screenful of the bottom.
	 *
	 * Deliberately measured from the scroll position rather than the editor's
	 * viewport range: a document of one enormous line has a viewport covering the
	 * whole document at all times, so a range-based check would report "at the
	 * end" immediately and pull in the entire file — exactly the case streaming
	 * exists for.
	 */
	function maybeLoadMore(instance: EditorView) {
		if (pane.fullyLoaded || pane.loading) return;
		const el = instance.scrollDOM;
		// Requiring a real scroll away from the top is what stops this cascading:
		// appending a chunk changes the layout, which fires `scroll` again, and a
		// document of one long line is a single unscrollable visual line until
		// wrapping applies — so a pure "near the bottom" test is true immediately
		// and would pull the entire file in at once.
		if (el.scrollTop <= 0) return;
		const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		if (fromBottom < el.clientHeight) void pane.loadMore();
	}

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
					keymap.of([
						{
							key: 'Mod-s',
							shift: () => (void save(true), true),
							run: () => (void save(), true),
							preventDefault: true
						},
						...defaultKeymap,
						...historyKeymap,
						...searchKeymap
					]),
					languageCompartment.of([]),
					editableCompartment.of([]),
					wrapCompartment.of([]),
					...darkEditorExtensions,
					EditorView.updateListener.of((update) => {
						const ours = update.transactions.some((tr) => tr.annotation(Programmatic));
						if (update.docChanged && !ours) pane.setTextFromEditor(update.state.doc.toString());
						// Untracked: this listener runs inside whichever effect dispatched the change, and
						// reading the counter there would have that effect re-run itself.
						if (update.docChanged) untrack(() => docRevision++);
						if (update.docChanged || update.heightChanged || update.geometryChanged) layoutChanged();
					}),
					EditorView.domEventHandlers({
						scroll: (_event, instance) => {
							maybeLoadMore(instance);
							sync.follow(side);
							viewScrolled();
						}
					})
				]
			})
		});

		view = instance;
		const detach = untrack(() => sync.attach(side, instance));
		return () => {
			detach();
			cancelAnimationFrame(layoutFrame);
			cancelAnimationFrame(scrollFrame);
			layoutFrame = scrollFrame = 0;
			instance.destroy();
			view = null;
		};
	}

	// Replace the document only for changes that came from outside the editor (a
	// dropped file, or Clear). Typing already left the document correct, and the
	// equality check is what stops this from fighting the cursor.
	$effect(() => {
		const instance = view;
		if (!instance) return;
		// CodeMirror keeps every line break as `\n`, so text with Windows or old Mac line
		// endings is compared as it will be stored. Compared raw, a `\r\n` file never
		// matched, and every chunk streamed in replaced the whole document instead of
		// being appended to it.
		const text = pane.text.includes('\r') ? pane.text.replace(/\r\n?/g, '\n') : pane.text;

		const current = instance.state.doc.toString();
		if (current === text) return;

		// Streaming appends to the end; replacing the whole document instead would
		// throw away the cursor and the scroll position on every chunk.
		const appended = text.length > current.length && text.startsWith(current);
		instance.dispatch({
			changes: appended
				? { from: current.length, insert: text.slice(current.length) }
				: { from: 0, to: instance.state.doc.length, insert: text },
			selection: appended ? undefined : { anchor: 0 },
			annotations: Programmatic.of(true)
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

	// Typing into a partially streamed document would leave the unseen tail
	// behind, so the rest is pulled in on the first attempt to edit. Nor can text
	// be typed opposite an image or folder, which only compare with their own kind.
	$effect(() => {
		const streaming = !pane.fullyLoaded;
		const readOnly = pane.loading || streaming || !pane.acceptsText;
		view?.dispatch({
			effects: editableCompartment.reconfigure(EditorView.editable.of(!readOnly))
		});
	});

	$effect(() => {
		const enabled = wrap;
		view?.dispatch({
			effects: wrapCompartment.reconfigure(enabled ? EditorView.lineWrapping : [])
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
			pane.error = uri ? `Could not read the dropped item (${uri.split('\n')[0]})` : 'The drop carried no file';
			return;
		}
		await pane.loadFile(file);
	}
</script>

<!-- Drag handlers sit on the whole pane so a file can be dropped on the path
     field and header as well as the editor. -->
<section
	class="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
	ondragentercapture={onDragEnter}
	ondragovercapture={onDragOver}
	ondragleavecapture={onDragLeave}
	ondropcapture={onDrop}
>
	<header class="flex h-9 shrink-0 items-center gap-2 border-b bg-card px-2.5">
		<span class="truncate text-xs font-medium" title={pane.filename || emptyPrompt}>
			{pane.filename || emptyPrompt}
		</span>
		{#if pane.kind === 'file' && pane.unsaved}
			<span class="size-1.5 shrink-0 rounded-full bg-brand" title="Unsaved changes" aria-label="Unsaved changes"></span>
		{/if}

		{#if pane.isFolder}
			<span class="shrink-0 text-[11px] text-muted-foreground">Folder</span>
		{:else if pane.isImage}
			<span class="shrink-0 text-[11px] text-muted-foreground tabular-nums">
				Image{pane.imageSize ? ` · ${pane.imageSize.width}×${pane.imageSize.height}` : ''} · {formatBytes(
					pane.byteLength
				)}
			</span>
		{:else if !pane.isEmpty}
			<span class="shrink-0 text-[11px] text-muted-foreground tabular-nums">
				{formatCount(pane.lineCount)} lines · {formatBytes(pane.byteLength)}
			</span>
		{/if}

		{#if !pane.fullyLoaded}
			<!-- The document is streaming in; editing needs all of it. -->
			<button
				type="button"
				onclick={() => pane.loadAll()}
				class="shrink-0 rounded border border-brand/40 px-1.5 py-0.5 text-[11px] text-brand tabular-nums transition-colors hover:bg-brand/10"
				title="The rest of this file has not been loaded yet. Editing needs the whole document."
			>
				{formatBytes(pane.pendingBytes)} more — load all to edit
			</button>
		{/if}

		<div class="ml-auto flex shrink-0 items-center gap-1.5">
			{#if pane.isImage && pane.imageSize}
				<ZoomControl
					scale={previewScale}
					fitted={pane.previewZoom === null}
					onzoom={(next) => (pane.previewZoom = clampZoom(next))}
					onfit={() => (pane.previewZoom = null)}
				/>
			{/if}

			{#if pane.kind === 'file' && !pane.highlightingAllowed && !pane.isEmpty}
				<span
					class="text-[11px] text-muted-foreground"
					title="Highlighting is off above {formatBytes(HIGHLIGHT_LIMIT_BYTES)} so editing stays responsive"
				>
					highlighting off
				</span>
			{/if}

			<!-- Only text has a language to highlight, and only a pane that can hold text needs one. -->
			{#if pane.kind === 'file' && pane.acceptsText}
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
			{/if}

			{#if pane.kind === 'file' && pane.unsaved}
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					onclick={() => save()}
					aria-label="Save this file"
					title={pane.path ? `Save to ${pane.path} (Ctrl+S)` : 'Save as… (Ctrl+S)'}
				>
					<SaveIcon class="size-3.5" />
				</Button>
			{/if}

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

	<div class="shrink-0 border-b bg-card px-2.5 py-1.5">
		<InputGroup.Root class="h-7">
			<InputGroup.Addon>
				<FolderIcon class="size-3.5" />
			</InputGroup.Addon>
			<!-- Read-only: files and folders are opened by dropping or picking, never by
           typing a path, so the renderer has no way to name an arbitrary one. -->
			<InputGroup.Input
				bind:ref={pathInput}
				readonly
				value={pane.path ?? ''}
				placeholder={pane.isEmpty ? 'Nothing open' : 'Not saved to a file'}
				title={pane.path ?? undefined}
				aria-label={pane.isFolder ? 'Folder location' : pane.isImage ? 'Image location' : 'File location'}
				class="font-mono text-xs"
				onfocus={(event) => event.currentTarget.select()}
			/>
			<!-- Only the pickers for what the other side allows are offered. -->
			<InputGroup.Addon align="inline-end">
				{#if pane.requiredKind === 'image'}
					<InputGroup.Button
						size="icon-xs"
						onclick={() => pane.pickFile('image')}
						disabled={pane.loading}
						aria-label="Open an image"
						title="Open an image"
					>
						<ImageIcon />
					</InputGroup.Button>
				{:else if pane.requiredKind !== 'folder'}
					<InputGroup.Button
						size="icon-xs"
						onclick={() => pane.pickFile()}
						disabled={pane.loading}
						aria-label="Open a file"
						title="Open a file or image"
					>
						<FileTextIcon />
					</InputGroup.Button>
				{/if}
				{#if pane.requiredKind === null || pane.requiredKind === 'folder'}
					<InputGroup.Button
						size="icon-xs"
						onclick={() => pane.pickFolder()}
						disabled={pane.loading}
						aria-label="Open a folder"
						title="Open a folder"
					>
						<FolderOpenIcon />
					</InputGroup.Button>
				{/if}
			</InputGroup.Addon>
		</InputGroup.Root>
	</div>

	<div class="relative min-h-0 flex-1" bind:clientWidth={bodyWidth} bind:clientHeight={bodyHeight}>
		{#if pane.isFolder}
			<!-- Nothing inside the folder is read until it is compared, so there is
           only the folder itself to show. CodeMirror is unmounted meanwhile and
           remounts, from the pane's text, when a file replaces the folder. -->
			<div class="grid h-full place-items-center overflow-auto p-6 text-center">
				<div class="flex max-w-full flex-col items-center gap-2">
					<FolderIcon class="size-10 text-brand" strokeWidth={1.5} />
					<p class="text-sm font-medium break-all">{pane.filename}</p>
					<p class="max-w-md font-mono text-[11px] break-all text-muted-foreground">{pane.path}</p>
					<p class="text-[11px] text-muted-foreground opacity-70">Compare it with another folder</p>
				</div>
			</div>
		{:else if pane.isImage}
			<ImageViewport
				src={pane.imageUrl}
				alt={pane.filename}
				size={pane.imageSize}
				scale={previewScale}
				onload={(size) => (pane.imageSize = size)}
				onzoom={(next) => (pane.previewZoom = next)}
			/>
		{:else if pane.acceptsText}
			<div class="flex h-full">
				<div class="h-full min-w-0 flex-1" {@attach codemirror}></div>
				{#if !pane.isEmpty}
					<ChangeStrip
						total={stripView.total}
						lineAt={stripLineAt}
						maxScale={STRIP_LINE_PX}
						revision={docRevision}
						viewStart={stripView.start}
						viewEnd={stripView.end}
						onjump={(position) => void jump(position)}
						onscrollby={(delta) => view?.scrollDOM.scrollBy({ top: delta })}
					/>
				{/if}
			</div>
		{/if}

		{#if pane.isEmpty && !pane.loading}
			<div class="pointer-events-none absolute inset-0 grid place-items-center text-center text-muted-foreground">
				<div class="space-y-1">
					<p class="text-sm">{emptyPrompt}</p>
					{#if pane.acceptsText}
						<p class="text-[11px] opacity-70">or start typing</p>
					{/if}
				</div>
			</div>
		{/if}

		{#if pane.loading}
			<div class="absolute inset-0 grid place-items-center bg-background/80 backdrop-blur-sm">
				<p class="text-xs text-muted-foreground">{pane.loadingLabel}</p>
			</div>
		{/if}

		{#if isDraggingOver}
			<div
				class="pointer-events-none absolute inset-2 grid place-items-center rounded-lg border-2 border-dashed border-brand bg-brand/10"
			>
				<p class="text-sm font-medium text-brand">Drop to load</p>
			</div>
		{/if}

		{#if pane.error}
			<div class="absolute inset-x-2 bottom-2 rounded-md bg-del-bg px-3 py-2 text-xs text-del-ink">
				{pane.error}
			</div>
		{/if}
	</div>
</section>
