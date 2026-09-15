<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Slider } from '$lib/components/ui/slider';
	import { Switch } from '$lib/components/ui/switch';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import DiffView from '$lib/components/DiffView.svelte';
	import Editor from '$lib/components/Editor.svelte';
	import FolderTree from '$lib/components/FolderTree.svelte';
	import ImageDiffView from '$lib/components/ImageDiffView.svelte';
	import type { DiffResult, FolderDiffResult, FolderProgress, ImageDiffResult } from '$lib/diff-types';
	import type { DiffFilter } from '$lib/diff-view-model';
	import { EditorSync } from '$lib/editor-sync.svelte';
	import { changeSummary } from '$lib/folder-tree-model';
	import { formatBytes, formatCount, formatPercent } from '$lib/format';
	import { PaneState } from '$lib/panes.svelte';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowLeftRightIcon from '@lucide/svelte/icons/arrow-left-right';
	import GitCompareIcon from '@lucide/svelte/icons/git-compare';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import type { TreeNode } from 'comparer-ts';
	import { tick } from 'svelte';

	const left = new PaneState();
	const right = new PaneState();
	// Each side only takes the kind of thing the other holds: text, an image or a folder.
	PaneState.pair(left, right);

	/** Keeps the two editors' matching lines level as either scrolls. */
	const editorSync = new EditorSync();
	/** How long typing has to pause before the editors are re-aligned, which re-diffs both texts. */
	const REALIGN_DELAY_MS = 400;

	// Aligns the editors whenever they hold two texts: straight away for newly opened
	// documents, and once typing pauses for edits. Streaming more of a file into view
	// changes neither the document nor its revision, so it never re-aligns.
	let alignedRevision = 0;
	$effect(() => {
		const texts = left.kind === 'file' && right.kind === 'file' && !left.isEmpty && !right.isEmpty;
		void [left.docId, right.docId];
		const revision = left.revision + right.revision;
		const edited = revision !== alignedRevision;
		alignedRevision = revision;
		if (!texts) {
			editorSync.clear();
			return;
		}
		const timer = setTimeout(() => void editorSync.refresh(left, right), edited ? REALIGN_DELAY_MS : 0);
		return () => clearTimeout(timer);
	});

	/**
	 * The two sides of a file opened from a folder comparison. Never shown in an
	 * editor, so the folder panes above stay exactly as the user left them.
	 */
	const entryLeft = new PaneState();
	const entryRight = new PaneState();

	let view = $state<'edit' | 'diff'>('edit');
	let diffMode = $state<'unified' | 'split'>('unified');
	/** Folders open side by side; kept apart from `diffMode` so each remembers its own choice. */
	let folderMode = $state<'unified' | 'split'>('split');
	/** Which lines a text diff shows; kept across comparisons. */
	let diffFilter = $state<DiffFilter>('all');
	let wrap = $state(true);
	let hideUnchanged = $state(false);
	/** Colour difference to tolerate between pixels, from 0 to 100. Set before or after comparing. */
	let tolerance = $state(0);
	let imageMode = $state<'diff' | 'split'>('diff');

	/**
	 * The last file diff. Alongside `folderResult` only while `entry` is open,
	 * when it is the diff of that entry.
	 */
	let result = $state<DiffResult | null>(null);
	/**
	 * The last folder comparison, with the folders it was made between. Their ids
	 * are kept because the panes may have moved on to other folders since.
	 */
	let folderResult = $state<{
		diff: FolderDiffResult;
		leftId: string;
		rightId: string;
		leftName: string;
		rightName: string;
	} | null>(null);
	/**
	 * The last image comparison. Replaced whole on every tolerance change rather than
	 * edited, so it is not made deeply reactive: its diff image alone is a sizeable PNG.
	 */
	let imageResult = $state.raw<{
		diff: ImageDiffResult;
		leftId: string;
		rightId: string;
		leftName: string;
		rightName: string;
	} | null>(null);
	/** A new image diff for a moved tolerance slider is on its way. */
	let imageBusy = $state(false);
	/** The image comparison, while both panes still hold the images it was made from. */
	const currentImage = $derived(
		imageResult && left.docId === imageResult.leftId && right.docId === imageResult.rightId ? imageResult : null
	);
	const hasImage = $derived(left.isImage || right.isImage);

	/** The file from the folder comparison whose diff is on screen, over the tree. */
	let entry = $state<{ node: TreeNode; binary: boolean } | null>(null);
	let tree: ReturnType<typeof FolderTree> | null = $state(null);
	let running = $state(false);
	/** Set only while a folder comparison runs, which is long enough to report on. */
	let progress = $state<FolderProgress | null>(null);
	let error = $state('');

	const canCompare = $derived(!left.isEmpty || !right.isEmpty);
	// Nothing to exchange when both sides are blank.
	const canSwap = $derived(!left.isEmpty || !right.isEmpty);

	/** Guards against an older comparison landing after a newer one. */
	let runToken = 0;

	/**
	 * Compares two panes: the editors by default, or the two sides of a file
	 * opened from a folder comparison, whose diff then sits over that comparison
	 * instead of replacing it.
	 */
	async function compare(a = left, b = right) {
		if (running) return;
		const fromTree = a === entryLeft;
		if (!fromTree) {
			if (!canCompare) return;
			// The panes already refuse a mismatched drop; this catches a side left empty.
			const mismatch = kindMismatch(a, b);
			if (mismatch) {
				error = mismatch;
				return;
			}
			closeEntry();
		}

		const token = ++runToken;
		running = true;
		error = '';
		try {
			if (a.isImage && b.isImage) {
				const [leftId, rightId] = [a.docId!, b.docId!];
				const next = await window.comparer.diffImages(leftId, rightId, tolerance);
				if (token !== runToken) return;
				imageResult = { diff: next, leftId, rightId, leftName: a.filename, rightName: b.filename };
				result = null;
				folderResult = null;
			} else if (a.isFolder && b.isFolder) {
				progress = { phase: 'list', entries: 0 };
				// Folder panes always hold a service id; only a never-used file pane lacks one.
				const [leftId, rightId] = [a.docId!, b.docId!];
				const next = await window.comparer.diffFolders(leftId, rightId, (update) => {
					if (token === runToken) progress = update;
				});
				if (token !== runToken) return;
				folderResult = { diff: next, leftId, rightId, leftName: a.filename, rightName: b.filename };
				result = null;
				imageResult = null;
			} else {
				// Panes that were only read keep their text in the service, so nothing
				// crosses the boundary here; only an edited pane pushes its text back.
				const [leftId, rightId] = await Promise.all([a.sync(), b.sync()]);
				const next = await window.comparer.diff(leftId, rightId);
				if (token !== runToken) return;
				result = next;
				if (!fromTree) {
					folderResult = null;
					imageResult = null;
				}
			}
			view = 'diff';
		} catch (cause) {
			if (token !== runToken) return;
			error = cause instanceof Error ? cause.message : 'Comparison failed';
			if (fromTree) {
				closeEntry();
			} else {
				result = null;
				folderResult = null;
				imageResult = null;
			}
		} finally {
			if (token === runToken) {
				running = false;
				progress = null;
			}
		}
	}

	/**
	 * Abandons the running folder comparison. Moving the token on means its
	 * rejection, when the service reports the cancellation, is ignored rather
	 * than shown as an error, and whatever was on screen before stays there.
	 */
	function cancel() {
		if (!progress) return;
		runToken++;
		running = false;
		progress = null;
		void window.comparer.cancelFolderDiff();
	}

	/** Why two panes cannot be compared, or null when they can. An empty pane counts as text. */
	function kindMismatch(a: PaneState, b: PaneState): string | null {
		if (a.kind === b.kind) return null;
		if (a.isImage || b.isImage) return 'Drop an image on both sides to compare images';
		return 'Drop a folder on both sides to compare folders';
	}

	function setTolerance(value: number) {
		tolerance = value;
		if (currentImage) void refreshImageDiff();
	}

	let imageRefreshing = false;

	/**
	 * Brings the image comparison up to date with the tolerance slider. Only one request
	 * is ever in flight: moves made while it runs fold into the next one, so dragging the
	 * slider never queues a comparison for every step it passes.
	 */
	async function refreshImageDiff() {
		if (imageRefreshing) return;
		imageRefreshing = true;
		imageBusy = true;
		try {
			while (currentImage?.diff.kind === 'compared' && currentImage.diff.tolerance !== tolerance) {
				const target = currentImage;
				const next = await window.comparer.diffImages(target.leftId, target.rightId, tolerance);
				// A new comparison, or a changed pane, replaced the one this was for.
				if (imageResult !== target) break;
				imageResult = { ...target, diff: next };
			}
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not update the image comparison';
		} finally {
			imageRefreshing = false;
			imageBusy = false;
		}
	}

	/** Opens a modified file from the folder tree and diffs its two versions. */
	async function openEntry(node: TreeNode) {
		if (!folderResult || running) return;
		error = '';
		try {
			const opened = await window.comparer.openFolderEntry(folderResult.leftId, folderResult.rightId, node.path);
			if (opened.kind === 'binary') {
				closeEntry();
				entry = { node, binary: true };
				return;
			}
			entryLeft.hold(opened.left);
			entryRight.hold(opened.right);
			entry = { node, binary: false };
			await compare(entryLeft, entryRight);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : `Could not open ${node.path}`;
			closeEntry();
		}
	}

	/** Drops the opened file and its documents, leaving the folder comparison. */
	function closeEntry() {
		if (!entry) return;
		entry = null;
		result = null;
		entryLeft.clear();
		entryRight.clear();
	}

	async function backToTree() {
		closeEntry();
		// The tree is hidden rather than unmounted while a file is open, so it
		// comes back as it was; it only needs focus once it is visible again.
		await tick();
		tree?.focus();
	}

	function swap() {
		PaneState.swap(left, right);
	}

	/*
	 * Get/set pairs for the header's toggle groups, bound as `bind:value={get, set}`.
	 * A single-select toggle group clears itself when you click the item that is
	 * already active, which would leave nothing selected — the app showing neither
	 * Editors nor Diff, say. Each setter drops that empty value, so the current
	 * choice always stays selected.
	 */

	function getView() {
		return view;
	}

	function setView(next: string) {
		if (next === 'edit' || next === 'diff') view = next;
	}

	/**
	 * Images of different sizes can only be shown side by side. That is shown without
	 * changing the chosen mode, so the next comparison opens the way it was left.
	 */
	function getImageMode() {
		return currentImage?.diff.kind === 'sizeMismatch' ? 'split' : imageMode;
	}

	function setImageMode(next: string) {
		if (next === 'diff' || next === 'split') imageMode = next;
	}

	/** A folder tree and a file diff each remember their own unified or split choice. */
	function getDiffMode() {
		return folderResult && !entry ? folderMode : diffMode;
	}

	function setDiffMode(next: string) {
		if (next !== 'unified' && next !== 'split') return;
		if (folderResult && !entry) folderMode = next;
		else diffMode = next;
	}

	function getDiffFilter() {
		return diffFilter;
	}

	/** Clicking the pressed item would leave nothing selected, so an empty value is ignored. */
	function setDiffFilter(next: string) {
		if (next === 'all' || next === 'similar' || next === 'different') diffFilter = next;
	}

	/**
	 * A file dropped anywhere outside a pane would otherwise make the window
	 * navigate to it, replacing the app with the raw file — which reads as the
	 * app simply breaking. The panes claim their own drops before this runs.
	 */
	function preventFileNavigation(event: DragEvent) {
		if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
	}
</script>

<svelte:window
	onkeydown={(event) => {
		// Enter runs the comparison from anywhere except inside the editors.
		if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
			event.preventDefault();
			void compare();
		} else if (event.key === 'Escape' && progress) {
			event.preventDefault();
			cancel();
		} else if (event.key === 'Escape' && entry && view === 'diff') {
			event.preventDefault();
			void backToTree();
		}
	}}
	ondragover={preventFileNavigation}
	ondrop={preventFileNavigation}
/>

<div class="flex h-full flex-col">
	<!-- The window is frameless, so this header is the title bar: dragging it
       moves the window, and every control in it opts out with `no-drag`. The
       `titlebar-area-*` variables are the space the OS window controls leave
       free — on the left on macOS, on the right elsewhere — and fall back to
       plain padding when there are none. -->
	<header
		class="flex h-11 shrink-0 items-center gap-3 border-b bg-card pr-[calc(100vw_-_env(titlebar-area-x,0px)_-_env(titlebar-area-width,100vw)_+_0.75rem)] pl-[calc(env(titlebar-area-x,0px)_+_0.75rem)] select-none [app-region:drag]"
	>
		<div class="flex items-center gap-2">
			<GitCompareIcon class="size-4 text-brand" />
			<span class="text-sm font-semibold tracking-tight">Comparer</span>
		</div>

		<ToggleGroup.Root
			type="single"
			bind:value={getView, setView}
			variant="outline"
			size="sm"
			class="[app-region:no-drag]"
		>
			<ToggleGroup.Item value="edit" aria-label="Show the editors">Editors</ToggleGroup.Item>
			<ToggleGroup.Item value="diff" aria-label="Show the diff" disabled={!result && !folderResult && !currentImage}>
				Diff
			</ToggleGroup.Item>
		</ToggleGroup.Root>

		{#if view === 'diff' && currentImage && !folderResult}
			<ToggleGroup.Root
				type="single"
				bind:value={getImageMode, setImageMode}
				variant="outline"
				size="sm"
				class="[app-region:no-drag]"
			>
				<ToggleGroup.Item
					value="diff"
					aria-label="Show the differences"
					disabled={currentImage.diff.kind === 'sizeMismatch'}
				>
					Diff
				</ToggleGroup.Item>
				<ToggleGroup.Item value="split" aria-label="Show both images side by side">Side by side</ToggleGroup.Item>
			</ToggleGroup.Root>
		{:else if view === 'diff' && (result || folderResult)}
			<ToggleGroup.Root
				type="single"
				bind:value={getDiffMode, setDiffMode}
				variant="outline"
				size="sm"
				class="[app-region:no-drag]"
			>
				<ToggleGroup.Item value="unified" aria-label="Unified diff">Unified</ToggleGroup.Item>
				<ToggleGroup.Item value="split" aria-label="Side by side diff">Split</ToggleGroup.Item>
			</ToggleGroup.Root>
		{/if}

		{#if view === 'diff' && result && !result.identical && !currentImage && (!folderResult || entry)}
			<div class="flex items-center gap-2 [app-region:no-drag]">
				<span class="text-xs text-muted-foreground">Show</span>
				<ToggleGroup.Root type="single" bind:value={getDiffFilter, setDiffFilter} variant="outline" size="sm">
					<ToggleGroup.Item value="all" aria-label="Show every line">All</ToggleGroup.Item>
					<ToggleGroup.Item value="similar" aria-label="Show only lines both sides share">Similar</ToggleGroup.Item>
					<ToggleGroup.Item value="different" aria-label="Show only lines that differ">Different</ToggleGroup.Item>
				</ToggleGroup.Root>
			</div>
		{/if}

		{#if folderResult && !entry && !folderResult.diff.identical}
			{@const stats = folderResult.diff.stats}
			<div class="flex items-center gap-1.5">
				<Badge variant="secondary" class="border-0 bg-add-bg text-add-ink tabular-nums" title="Added">
					+{formatCount(stats.added)}
				</Badge>
				<Badge variant="secondary" class="border-0 bg-mod-ink/15 text-mod-ink tabular-nums" title="Modified">
					~{formatCount(stats.modified)}
				</Badge>
				<Badge variant="secondary" class="border-0 bg-del-bg text-del-ink tabular-nums" title="Deleted">
					-{formatCount(stats.deleted)}
				</Badge>
				{#if stats.unknown > 0}
					<Badge
						variant="secondary"
						class="border-0 bg-unknown-ink/15 text-unknown-ink tabular-nums"
						title="Could not be compared"
					>
						?{formatCount(stats.unknown)}
					</Badge>
				{/if}
				<span class="text-[11px] text-muted-foreground tabular-nums">
					{Math.round(folderResult.diff.elapsedMs)} ms
				</span>
			</div>
		{:else if currentImage}
			{@const diff = currentImage.diff}
			<div class="flex items-center gap-1.5">
				{#if diff.kind === 'sizeMismatch'}
					<Badge variant="secondary" class="border-0 bg-unknown-ink/15 text-unknown-ink">Different sizes</Badge>
				{:else if diff.identical}
					<Badge variant="secondary" class="border-0 bg-add-bg text-add-ink">Identical</Badge>
				{:else}
					<Badge
						variant="secondary"
						class="border-0 bg-del-bg text-del-ink tabular-nums"
						title="{formatCount(diff.differentPixels)} of {formatCount(diff.totalPixels)} pixels differ"
					>
						{formatPercent(diff.percent)} different
					</Badge>
					<span class="text-[11px] text-muted-foreground tabular-nums">{formatCount(diff.differentPixels)} px</span>
				{/if}
				<span class="text-[11px] text-muted-foreground tabular-nums">{Math.round(diff.elapsedMs)} ms</span>
			</div>
		{:else if result && !result.identical}
			<div class="flex items-center gap-1.5">
				<Badge variant="secondary" class="border-0 bg-add-bg text-add-ink tabular-nums">
					+{formatCount(result.stats.added)}
				</Badge>
				<Badge variant="secondary" class="border-0 bg-del-bg text-del-ink tabular-nums">
					-{formatCount(result.stats.removed)}
				</Badge>
				{#if result.truncated}
					<Badge variant="outline" class="text-muted-foreground">truncated</Badge>
				{/if}
				<span class="text-[11px] text-muted-foreground tabular-nums">
					{Math.round(result.elapsedMs)} ms
				</span>
			</div>
		{/if}

		<div class="ml-auto flex items-center gap-3 [app-region:no-drag]">
			<!-- Images have no lines to wrap, but a tolerance to set — before comparing, or
           after, when the diff follows the slider. A tree can hide what did not change. -->
			{#if (view === 'edit' && hasImage) || (view === 'diff' && currentImage && !folderResult)}
				<div class="flex items-center gap-2 text-xs text-muted-foreground">
					<span>Tolerance</span>
					<Slider
						type="single"
						min={0}
						max={100}
						step={0.5}
						value={tolerance}
						onValueChange={setTolerance}
						class="w-28"
						aria-label="Pixel tolerance"
					/>
					<span class="w-7 text-right tabular-nums">{tolerance}</span>
				</div>
			{:else if view === 'diff' && folderResult && !entry}
				<label class="flex items-center gap-2 text-xs text-muted-foreground">
					<Switch bind:checked={hideUnchanged} aria-label="Hide unchanged entries" />
					Hide unchanged
				</label>
			{:else}
				<label class="flex items-center gap-2 text-xs text-muted-foreground">
					<Switch bind:checked={wrap} aria-label="Wrap long lines" />
					Wrap
				</label>
			{/if}

			{#if view === 'edit'}
				<Button variant="ghost" size="sm" onclick={swap} disabled={!canSwap} title="Swap sides">
					<ArrowLeftRightIcon class="size-3.5" />
					Swap
				</Button>
			{/if}

			{#if progress}
				<Button size="sm" variant="outline" onclick={cancel} title="Stop comparing (Esc)">Cancel</Button>
			{:else}
				<Button size="sm" onclick={() => compare()} disabled={!canCompare || running}>
					{#if running}
						<LoaderCircleIcon class="size-3.5 animate-spin" />
						Comparing…
					{:else}
						<GitCompareIcon class="size-3.5" />
						Compare
					{/if}
				</Button>
			{/if}
		</div>
	</header>

	{#if error}
		<div class="shrink-0 bg-del-bg px-3 py-2 text-xs text-del-ink">{error}</div>
	{/if}

	<main class="relative min-h-0 flex-1">
		{#if view === 'diff' && folderResult}
			<!-- Hidden, not unmounted, while a file is open: Back then returns to the
           same open folders, selection and scroll position. -->
			<div class="h-full {entry ? 'invisible' : ''}">
				<FolderTree
					bind:this={tree}
					result={folderResult.diff}
					leftName={folderResult.leftName}
					rightName={folderResult.rightName}
					mode={folderMode}
					{hideUnchanged}
					onopen={openEntry}
				/>
			</div>

			{#if entry}
				{@const node = entry.node}
				<div class="absolute inset-0 flex flex-col bg-background">
					<div class="flex h-8 shrink-0 items-center gap-2 border-b bg-card px-2 text-xs">
						<Button
							variant="ghost"
							size="sm"
							class="h-6 px-2 text-xs"
							onclick={backToTree}
							title="Back to the tree (Esc)"
						>
							<ArrowLeftIcon class="size-3.5" />
							Back to tree
						</Button>
						<span class="truncate font-mono" title={node.path}>{node.path}</span>
						<!-- Says why the tree marked it, which matters most when the contents
                 turn out identical and only metadata changed. -->
						<span class="ml-auto shrink-0 text-mod-ink">{changeSummary(node)}</span>
					</div>

					<div class="min-h-0 flex-1">
						{#if entry.binary}
							{@const contentChanged = node.reasons.includes('content')}
							<div class="grid h-full place-items-center text-center text-muted-foreground">
								<div class="space-y-1">
									<p class="text-sm text-foreground">
										{contentChanged ? 'Binary files differ' : 'Binary files with identical contents'}
									</p>
									<p class="text-xs">
										{contentChanged
											? 'Their contents changed, but there is no text diff to show for binary files.'
											: 'Only their metadata changed.'}
									</p>
								</div>
							</div>
						{:else if result}
							<DiffView {result} mode={diffMode} {wrap} show={diffFilter} />
						{/if}
					</div>
				</div>
			{/if}
		{:else if view === 'diff' && currentImage}
			<ImageDiffView
				result={currentImage.diff}
				leftUrl={left.imageUrl}
				rightUrl={right.imageUrl}
				leftName={currentImage.leftName}
				rightName={currentImage.rightName}
				mode={imageMode}
				busy={imageBusy}
			/>
		{:else if view === 'diff' && result}
			<DiffView {result} mode={diffMode} {wrap} show={diffFilter} />
		{:else}
			<div class="flex h-full">
				<Editor pane={left} side="left" sync={editorSync} placeholder="Drop the original file or folder here" {wrap} />
				<div class="w-px shrink-0 bg-border"></div>
				<Editor pane={right} side="right" sync={editorSync} placeholder="Drop the changed file or folder here" {wrap} />
			</div>
		{/if}

		{#if progress}
			<div class="absolute inset-0 z-10 grid place-items-center bg-background/80 backdrop-blur-sm">
				<div class="w-80 space-y-3 rounded-lg border bg-card p-4 shadow-lg" role="status" aria-live="polite">
					<div class="flex items-center gap-2 text-sm font-medium">
						<LoaderCircleIcon class="size-4 animate-spin text-brand" />
						{progress.phase === 'list' ? 'Listing both folders…' : 'Comparing file contents…'}
					</div>
					{#if progress.phase === 'hash'}
						<div class="h-1.5 overflow-hidden rounded-full bg-muted">
							<div
								class="h-full bg-brand transition-[width]"
								style:width="{progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%"
							></div>
						</div>
					{/if}
					<p class="text-xs text-muted-foreground tabular-nums">
						{#if progress.phase === 'list'}
							{formatCount(progress.entries)} entries found
						{:else}
							{formatCount(progress.done)} of {formatCount(progress.total)} files · {formatBytes(progress.bytes)}
						{/if}
					</p>
					<div class="flex justify-end">
						<Button size="sm" variant="outline" onclick={cancel}>Cancel</Button>
					</div>
				</div>
			</div>
		{/if}
	</main>
</div>
