<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Slider } from '$lib/components/ui/slider';
	import { Switch } from '$lib/components/ui/switch';
	import { Toggle } from '$lib/components/ui/toggle';
	import RecentMenu from '$lib/components/RecentMenu.svelte';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import DiffView from '$lib/components/DiffView.svelte';
	import Editor from '$lib/components/Editor.svelte';
	import FolderTree from '$lib/components/FolderTree.svelte';
	import ImageDiffView from '$lib/components/ImageDiffView.svelte';
	import WindowControls from '$lib/components/WindowControls.svelte';
	import type { DiffResult, FolderDiffResult, FolderProgress, ImageDiffResult, ImageMode } from '$lib/diff-types';
	import type { DiffFilter } from '$lib/diff-view-model';
	import type { ChangeRange } from '$lib/text-edit';
	import { EditorSync } from '$lib/editor-sync.svelte';
	import { ALL_CHANGES, changeSummary, type ShownChange } from '$lib/folder-tree-model';
	import { formatBytes, formatCount, formatPercent } from '$lib/format';
	import { PaneState } from '$lib/panes.svelte';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowLeftRightIcon from '@lucide/svelte/icons/arrow-left-right';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
	import GitCompareIcon from '@lucide/svelte/icons/git-compare';
	import AppMark from '$lib/components/AppMark.svelte';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import SaveIcon from '@lucide/svelte/icons/save';
	import type { DocumentId } from './shared/protocol';
	import FileDownIcon from '@lucide/svelte/icons/file-down';
	import type { TreeNode } from 'comparer-ts';
	import { onMount, tick } from 'svelte';
	import type { RecentComparison } from './shared/launch';
	import type { LaunchItem } from './shared/protocol';

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
	/** Anything with changes to step through: the text diff or the folder tree. */
	type JumpTarget = {
		canJump(direction: 1 | -1): boolean;
		jump(direction: 1 | -1): unknown;
		changeCount(): { current: number; total: number };
	};

	/** The text diff on screen, for jumping between its changes. */
	let diffView = $state<ReturnType<typeof DiffView>>();
	let wrap = $state(true);
	let hideUnchanged = $state(false);
	/** Which changes the folder tree lists. */
	let shownChanges = $state<ShownChange[]>([...ALL_CHANGES]);
	const shownChangeSet = $derived<ReadonlySet<ShownChange>>(
		shownChanges.length === ALL_CHANGES.size ? ALL_CHANGES : new Set(shownChanges)
	);
	/** Colour difference to tolerate between pixels, from 0 to 100. Set before or after comparing. */
	let tolerance = $state(0);
	let imageMode = $state<ImageMode>('diff');

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
	/** The two documents `result` compares, so re-diffing the same pair keeps the diff's scroll position. */
	let resultKey = $state('');
	/** The documents `result` was made from, left and right. */
	let resultDocs: [DocumentId | null, DocumentId | null] = [null, null];
	/** A passing message, such as where an export was written. Clears itself. */
	let notice = $state('');
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	/** A change is being copied from one side to the other. */
	let copying = $state(false);
	/** The panes the text diff on screen was made from: a file opened from a folder, or the editors. */
	const diffPanes = $derived(entry ? ([entryLeft, entryRight] as const) : ([left, right] as const));
	/** Set only while a folder comparison runs, which is long enough to report on. */
	let progress = $state<FolderProgress | null>(null);
	let error = $state('');

	/** The folder tree is on screen, with changes to filter and jump between. */
	const treeShown = $derived(view === 'diff' && !!folderResult && !entry && !folderResult.diff.identical);

	/** There is a diff on screen, whose controls get the row under the title bar. */
	const toolbarShown = $derived(view === 'diff' && (!!result || !!folderResult || !!currentImage));

	/** A text diff with changes is on screen, so its filter, jumps and search apply. */
	const textDiffShown = $derived(
		view === 'diff' && !!result && !result.identical && !currentImage && (!folderResult || !!entry)
	);

	const canCompare = $derived(!left.isEmpty || !right.isEmpty);
	// Nothing to exchange when both sides are blank.
	const canSwap = $derived(!left.isEmpty || !right.isEmpty);

	/** Comparisons made before, newest first, for reopening from the header. */
	let recent = $state<RecentComparison[]>([]);

	onMount(() => {
		void startUp();
	});

	/** Loads the recent list, and opens and compares whatever the app was started with. */
	async function startUp() {
		try {
			const [items, list] = await Promise.all([window.comparer.launchItems(), window.comparer.recentComparisons()]);
			recent = list;
			if (items.length > 0) await openItems(items);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not open the files the app was started with';
		}
	}

	/** Puts one item in each pane, starting from empty ones, and compares them when both opened. */
	async function openItems(items: LaunchItem[]) {
		closeEntry();
		left.clear();
		right.clear();
		view = 'edit';
		error = '';
		await left.openItem(items[0]);
		if (items[1]) await right.openItem(items[1]);
		// Opening a patch says which of its files is on screen, and what else it changes.
		const note = items.map((item) => ('opened' in item ? item.note : undefined)).find(Boolean);
		if (note) showNotice(note);
		if (items.length === 2 && !left.error && !right.error && !left.isEmpty && !right.isEmpty) await compare();
	}

	async function openRecent(id: string) {
		try {
			await openItems(await window.comparer.openRecent(id));
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not open that comparison';
		}
	}

	async function forgetRecent(id: string) {
		try {
			recent = await window.comparer.forgetRecent(id);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not update the recent list';
		}
	}

	async function clearRecent() {
		try {
			await window.comparer.clearRecent();
			recent = [];
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not clear the recent list';
		}
	}

	const LASER_KEY = 'comparer:laser';

	/**
	 * How round the window's corners are, so the laser border curves with them instead of
	 * being cut off. Linux is measured from Electron's own window frame on GNOME, which rounds
	 * all four corners; Windows 11 and macOS use their system radius.
	 */
	const WINDOW_CORNER_RADIUS: Record<string, string> = { linux: '8px', win32: '8px', darwin: '10px' };

	/** macOS puts its window buttons at the left of the title bar; every other system at the right. */
	const macOs = window.comparer.platform === 'darwin';

	/** Maximised or full screen, when the window's corners are square. */
	let windowSquared = $state(false);
	const cornerRadius = $derived(windowSquared ? '0px' : (WINDOW_CORNER_RADIUS[window.comparer.platform] ?? '0px'));

	onMount(() => {
		window.comparer.windowSquared().then(
			(squared) => (windowSquared = squared),
			() => {}
		);
		return window.comparer.onWindowSquared((squared) => (windowSquared = squared));
	});

	/**
	 * A yellow border round the whole window, so it is easy to pick out among other dark
	 * windows, such as when sharing the screen. Remembered on this machine.
	 */
	let laser = $state(readLaser());

	function readLaser() {
		try {
			return localStorage.getItem(LASER_KEY) === 'on';
		} catch {
			return false;
		}
	}

	function setLaser(on: boolean) {
		laser = on;
		try {
			localStorage.setItem(LASER_KEY, on ? 'on' : 'off');
		} catch {
			// Only the remembering is lost; the border still follows the toggle.
		}
	}

	/** Adds a comparison of two things from disk to the recent list. */
	function remember(leftId: DocumentId | null, rightId: DocumentId | null) {
		if (!leftId || !rightId) return;
		window.comparer.rememberComparison(leftId, rightId).then(
			(list) => (recent = list),
			() => {}
		);
	}

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
				remember(leftId, rightId);
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
				remember(leftId, rightId);
				result = null;
				imageResult = null;
			} else {
				// Panes that were only read keep their text in the service, so nothing
				// crosses the boundary here; only an edited pane pushes its text back.
				const [leftId, rightId] = await Promise.all([a.sync(), b.sync()]);
				const next = await window.comparer.diff(leftId, rightId);
				if (token !== runToken) return;
				result = next;
				resultKey = `${leftId}|${rightId}`;
				resultDocs = [leftId, rightId];
				if (!fromTree) remember(leftId, rightId);
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
		if (next === 'diff' || next === 'split' || next === 'onion' || next === 'swipe') imageMode = next;
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

	function getShownChanges() {
		return shownChanges;
	}

	/** Turning off the last kind of change would list nothing, so at least one stays on. */
	function setShownChanges(next: string[]) {
		const valid = next.filter((value): value is ShownChange => ALL_CHANGES.has(value as ShownChange));
		if (valid.length > 0) shownChanges = valid;
	}

	const FILTER_KEYS: Record<string, DiffFilter> = { Digit1: 'all', Digit2: 'similar', Digit3: 'different' };

	/**
	 * Makes one side match the other for a single change, then re-diffs. Only the
	 * document in the service changes; the file on disk waits for Save.
	 */
	async function copyChange(range: ChangeRange, toward: 'left' | 'right') {
		const [a, b] = diffPanes;
		const [source, target] = toward === 'right' ? [a, b] : [b, a];
		if (copying || running || !source.docId || !target.docId) return;
		// The diff's line numbers describe the texts it was made from.
		if (a.dirty || b.dirty) {
			error = 'The files were edited after this diff was made. Compare again, then copy the change.';
			return;
		}
		copying = true;
		error = '';
		try {
			const into = toward === 'right' ? range.right : range.left;
			const from = toward === 'right' ? range.left : range.right;
			const info = await window.comparer.copyLines(target.docId, source.docId, into, from);
			await target.reload(info);
			await compare(a, b);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not copy the change';
		} finally {
			copying = false;
		}
	}

	function showNotice(message: string) {
		notice = message;
		clearTimeout(noticeTimer);
		noticeTimer = setTimeout(() => (notice = ''), 5000);
	}

	/** Writes the text diff on screen to a patch or HTML report the user names. */
	async function exportDiff() {
		const [a, b] = diffPanes;
		const labels = entry
			? { left: entry.node.path, right: entry.node.path }
			: { left: a.filename || 'left', right: b.filename || 'right' };
		error = '';
		try {
			const written = await window.comparer.exportDiff(resultDocs[0], resultDocs[1], labels);
			if (written) showNotice(`Exported to ${written}`);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not export the diff';
		}
	}

	/** Saves whichever sides of the text diff have unsaved changes. */
	async function saveDiffPanes() {
		try {
			for (const pane of diffPanes) {
				if (pane.unsaved) await pane.save();
			}
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not save the file';
		}
	}

	/**
	 * Keys for a text diff: Ctrl+F searches it, F3 steps through the matches,
	 * Alt+↑/↓ jump between changes, Alt+←/→ copy the current one across, Ctrl+S
	 * saves, and Alt+1/2/3 pick what it shows. Digits are
	 * read by physical key, since Alt changes the character they type on macOS.
	 */
	function textDiffShortcut(event: KeyboardEvent, target: NonNullable<typeof diffView>) {
		const mod = event.ctrlKey || event.metaKey;
		if (mod && !event.altKey && event.key.toLowerCase() === 'f') {
			void target.openSearch();
		} else if (event.key === 'F3') {
			target.stepMatch(event.shiftKey ? -1 : 1);
		} else if (event.altKey && !mod && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
			target.jump(event.key === 'ArrowUp' ? -1 : 1);
		} else if (event.altKey && !mod && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
			target.copyCurrent(event.key === 'ArrowLeft' ? 'left' : 'right');
		} else if (mod && !event.altKey && event.key.toLowerCase() === 's') {
			void saveDiffPanes();
		} else if (event.altKey && !mod && event.code in FILTER_KEYS) {
			diffFilter = FILTER_KEYS[event.code];
		} else {
			return;
		}
		event.preventDefault();
	}

	/**
	 * Double-clicking the title bar maximises or restores the window, which a frameless
	 * one no longer does by itself. Only the bar's own background counts: a double-click
	 * that lands on a control was meant for that control, not for the window.
	 */
	function toggleMaximizeFromTitleBar(event: MouseEvent) {
		if (event.target !== event.currentTarget) return;
		void window.comparer.toggleMaximizeWindow().catch(() => {});
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
		} else if (textDiffShown && diffView) {
			textDiffShortcut(event, diffView);
		} else if (treeShown && tree && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
			event.preventDefault();
			void tree.jump(event.key === 'ArrowUp' ? -1 : 1);
		}
	}}
	ondragover={preventFileNavigation}
	ondrop={preventFileNavigation}
/>

<!-- Up / Down between changes, for the text diff or the folder tree, with where the view is among them. -->
{#snippet jumpControls(target: JumpTarget | null | undefined)}
	<div class="flex items-center gap-2 [app-region:no-drag]">
		<span class="text-xs text-muted-foreground">Jump</span>
		<div class="flex">
			<Button
				variant="outline"
				size="sm"
				class="rounded-r-none"
				disabled={!target?.canJump(-1)}
				onclick={() => void target?.jump(-1)}
				title="Previous difference (Alt+↑)"
			>
				<ChevronUpIcon class="size-3.5" />
				Up
			</Button>
			<Button
				variant="outline"
				size="sm"
				class="-ml-px rounded-l-none"
				disabled={!target?.canJump(1)}
				onclick={() => void target?.jump(1)}
				title="Next difference (Alt+↓)"
			>
				<ChevronDownIcon class="size-3.5" />
				Down
			</Button>
		</div>
		{#if target}
			{@const count = target.changeCount()}
			<span class="min-w-14 text-[11px] text-muted-foreground tabular-nums" title="Where the view is among the changes">
				{count.current > 0
					? `${formatCount(count.current)} of ${formatCount(count.total)}`
					: `${formatCount(count.total)} ${count.total === 1 ? 'change' : 'changes'}`}
			</span>
		{/if}
	</div>
{/snippet}

<!-- A laser pointer and its beam. -->
{#snippet laserIcon()}
	<svg
		class="size-4"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<path d="m3 21 7.5-7.5" stroke-width="3.5" />
		<path d="m11.5 12.5 2-2" />
		<circle cx="17" cy="7" r="1.6" fill="currentColor" />
		<path d="M17 2v1.5M22 7h-1.5M20.5 3.5l-1 1M20.5 10.5l-1-1M13.5 3.5l1 1" />
	</svg>
{/snippet}

<!-- The laser border takes its own room round the edge, rather than covering the edge of what is inside. -->
{#if laser}
	<!-- Drawn over the edge rather than taking room from it, so switching it on moves nothing. -->
	<div
		class="pointer-events-none fixed inset-0 z-[100] border-2 border-yellow-400"
		style:border-radius={cornerRadius}
		data-laser="on"
		aria-hidden="true"
	></div>
{/if}

<div class="flex h-full flex-col">
	<!-- The window is frameless, so this header is the title bar: dragging it moves
       the window, double-clicking it maximises the window, and every control in it
       opts out with `no-drag`. There are no system window buttons on any platform,
       so the header draws its own — at the left on macOS, at the right elsewhere. -->
	<!-- The double-click only repeats what the maximise button does, so the bar itself
	     needs no role of its own to reach it. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<header
		class="flex h-11 shrink-0 items-center gap-3 border-b bg-card px-3 select-none [app-region:drag]"
		ondblclick={toggleMaximizeFromTitleBar}
	>
		{#if macOs}
			<WindowControls squared={windowSquared} />
		{/if}

		<div class="flex items-center gap-2">
			<AppMark class="size-4" />
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

		<!-- Stretched to the bar's full height so the Windows caption buttons can run its
		     whole height and into the corner; everything else in here stays centred. -->
		<div class="ml-auto flex items-center gap-3 self-stretch [app-region:no-drag]">
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

			{#if textDiffShown}
				{#each diffPanes as pane, index (index)}
					{#if pane.unsaved}
						<Button
							variant="outline"
							size="sm"
							onclick={() =>
								void pane
									.save()
									.catch(
										(cause: unknown) => (error = cause instanceof Error ? cause.message : 'Could not save the file')
									)}
							title={pane.path ? `Save to ${pane.path} (Ctrl+S)` : 'Save as… (Ctrl+S)'}
						>
							<SaveIcon class="size-3.5" />
							Save {index === 0 ? 'left' : 'right'}
						</Button>
					{/if}
				{/each}
			{/if}

			{#if view === 'edit' && recent.length > 0}
				<RecentMenu items={recent} onopen={openRecent} onforget={forgetRecent} onclear={clearRecent} />
			{/if}

			{#if view === 'edit'}
				<Button variant="ghost" size="sm" onclick={swap} disabled={!canSwap} title="Swap sides">
					<ArrowLeftRightIcon class="size-3.5" />
					Swap
				</Button>
			{/if}

			<Toggle
				variant="outline"
				size="sm"
				pressed={laser}
				onPressedChange={setLaser}
				aria-label="Laser border"
				title="Laser: outline the whole window in yellow, so it stands out among other dark windows"
				class="aria-pressed:border-yellow-400 aria-pressed:bg-yellow-400/15 aria-pressed:text-yellow-300"
			>
				{@render laserIcon()}
			</Toggle>

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

			{#if !macOs}
				<WindowControls squared={windowSquared} />
			{/if}
		</div>
	</header>

	<!-- The diff's own controls, on a row of their own so the title bar stays uncluttered, and
       only while there is a diff to control. Wraps onto more lines on a narrow window. -->
	{#if toolbarShown}
		<div
			class="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-card/60 px-3 py-1.5"
			role="toolbar"
			aria-label="View controls"
		>
			{#if view === 'diff' && currentImage && !folderResult}
				<ToggleGroup.Root type="single" bind:value={getImageMode, setImageMode} variant="outline" size="sm">
					<ToggleGroup.Item
						value="diff"
						aria-label="Show the differences"
						disabled={currentImage.diff.kind === 'sizeMismatch'}
					>
						Diff
					</ToggleGroup.Item>
					<ToggleGroup.Item value="split" aria-label="Show both images side by side">Side by side</ToggleGroup.Item>
					<ToggleGroup.Item
						value="onion"
						aria-label="Fade the right image over the left"
						disabled={currentImage.diff.kind === 'sizeMismatch'}
					>
						Onion skin
					</ToggleGroup.Item>
					<ToggleGroup.Item
						value="swipe"
						aria-label="Drag a divider between the two images"
						disabled={currentImage.diff.kind === 'sizeMismatch'}
					>
						Swipe
					</ToggleGroup.Item>
				</ToggleGroup.Root>
			{:else if view === 'diff' && (result || folderResult)}
				<ToggleGroup.Root type="single" bind:value={getDiffMode, setDiffMode} variant="outline" size="sm">
					<ToggleGroup.Item value="unified" aria-label="Unified diff">Unified</ToggleGroup.Item>
					<ToggleGroup.Item value="split" aria-label="Side by side diff">Split</ToggleGroup.Item>
				</ToggleGroup.Root>
			{/if}

			{#if treeShown}
				<div class="flex items-center gap-2">
					<span class="text-xs text-muted-foreground">Show</span>
					<ToggleGroup.Root type="multiple" bind:value={getShownChanges, setShownChanges} variant="outline" size="sm">
						<ToggleGroup.Item value="added" aria-label="List added entries">Added</ToggleGroup.Item>
						<ToggleGroup.Item value="modified" aria-label="List modified entries">Modified</ToggleGroup.Item>
						<ToggleGroup.Item value="deleted" aria-label="List deleted entries">Deleted</ToggleGroup.Item>
					</ToggleGroup.Root>
				</div>
				{@render jumpControls(tree)}
			{/if}

			{#if textDiffShown}
				<div class="flex items-center gap-2">
					<span class="text-xs text-muted-foreground">Show</span>
					<ToggleGroup.Root type="single" bind:value={getDiffFilter, setDiffFilter} variant="outline" size="sm">
						<ToggleGroup.Item value="all" aria-label="Show every line" title="Show every line (Alt+1)"
							>All</ToggleGroup.Item
						>
						<ToggleGroup.Item
							value="similar"
							aria-label="Show only lines both sides share"
							title="Show only lines both sides share (Alt+2)">Similar</ToggleGroup.Item
						>
						<ToggleGroup.Item
							value="different"
							aria-label="Show only lines that differ"
							title="Show only lines that differ (Alt+3)">Different</ToggleGroup.Item
						>
					</ToggleGroup.Root>
				</div>

				{@render jumpControls(diffView)}
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

			{#if textDiffShown}
				<Button
					variant="outline"
					size="sm"
					class="ml-auto"
					onclick={exportDiff}
					title="Save the diff as a .patch file, or as an HTML report"
				>
					<FileDownIcon class="size-3.5" />
					Export patch
				</Button>
			{/if}
		</div>
	{/if}

	{#if error}
		<div class="shrink-0 bg-del-bg px-3 py-2 text-xs text-del-ink">{error}</div>
	{:else if notice}
		<div class="shrink-0 truncate bg-muted px-3 py-2 text-xs text-muted-foreground" role="status">{notice}</div>
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
					shown={shownChangeSet}
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
							<DiffView
								bind:this={diffView}
								{result}
								mode={diffMode}
								{wrap}
								show={diffFilter}
								documentKey={resultKey}
								oncopy={copyChange}
							/>
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
			<DiffView
				bind:this={diffView}
				{result}
				mode={diffMode}
				{wrap}
				show={diffFilter}
				documentKey={resultKey}
				oncopy={copyChange}
			/>
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
