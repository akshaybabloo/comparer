<script lang="ts">
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { Switch } from '$lib/components/ui/switch';
  import * as ToggleGroup from '$lib/components/ui/toggle-group';
  import DiffView from '$lib/components/DiffView.svelte';
  import Editor from '$lib/components/Editor.svelte';
  import FolderTree from '$lib/components/FolderTree.svelte';
  import type { DiffResult, FolderDiffResult, FolderProgress } from '$lib/diff-types';
  import { changeSummary } from '$lib/folder-tree-model';
  import { formatBytes, formatCount } from '$lib/format';
  import { PaneState } from '$lib/panes.svelte';
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
  import ArrowLeftRightIcon from '@lucide/svelte/icons/arrow-left-right';
  import GitCompareIcon from '@lucide/svelte/icons/git-compare';
  import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
  import type { TreeNode } from 'comparer-ts';
  import { tick } from 'svelte';

  const left = new PaneState();
  const right = new PaneState();
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
  let wrap = $state(true);
  let hideUnchanged = $state(false);

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
      // There is no meaningful diff of a file, or of nothing, against a folder.
      if (a.isFolder !== b.isFolder) {
        error = 'Drop a folder on both sides to compare folders';
        return;
      }
      closeEntry();
    }

    const token = ++runToken;
    running = true;
    error = '';
    try {
      if (a.isFolder && b.isFolder) {
        progress = { phase: 'list', entries: 0 };
        // Folder panes always hold a service id; only a never-used file pane lacks one.
        const [leftId, rightId] = [a.docId!, b.docId!];
        const next = await window.comparer.diffFolders(leftId, rightId, (update) => {
          if (token === runToken) progress = update;
        });
        if (token !== runToken) return;
        folderResult = { diff: next, leftId, rightId, leftName: a.filename, rightName: b.filename };
        result = null;
      } else {
        // Panes that were only read keep their text in the service, so nothing
        // crosses the boundary here; only an edited pane pushes its text back.
        const [leftId, rightId] = await Promise.all([a.sync(), b.sync()]);
        const next = await window.comparer.diff(leftId, rightId);
        if (token !== runToken) return;
        result = next;
        if (!fromTree) folderResult = null;
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
    class="bg-card flex h-11 shrink-0 items-center gap-3 border-b pr-[calc(100vw_-_env(titlebar-area-x,0px)_-_env(titlebar-area-width,100vw)_+_0.75rem)] pl-[calc(env(titlebar-area-x,0px)_+_0.75rem)] select-none [app-region:drag]"
  >
    <div class="flex items-center gap-2">
      <GitCompareIcon class="text-brand size-4" />
      <span class="text-sm font-semibold tracking-tight">Comparer</span>
    </div>

    <!-- A get/set binding rather than a plain `bind:`: a single-select toggle
         group clears itself when you click the item that is already active,
         which would leave the app showing neither Editors nor Diff. The setter
         drops that empty value, so the current view always stays selected. -->
    <ToggleGroup.Root
      type="single"
      bind:value={() => view, (next) => { if (next === 'edit' || next === 'diff') view = next; }}
      variant="outline"
      size="sm"
      class="[app-region:no-drag]"
    >
      <ToggleGroup.Item value="edit" aria-label="Show the editors">Editors</ToggleGroup.Item>
      <ToggleGroup.Item value="diff" aria-label="Show the diff" disabled={!result && !folderResult}>
        Diff
      </ToggleGroup.Item>
    </ToggleGroup.Root>

    {#if view === 'diff' && (result || folderResult)}
      <ToggleGroup.Root
        type="single"
        bind:value={
          () => (folderResult && !entry ? folderMode : diffMode),
          (next) => {
            if (next !== 'unified' && next !== 'split') return;
            if (folderResult && !entry) folderMode = next;
            else diffMode = next;
          }
        }
        variant="outline"
        size="sm"
        class="[app-region:no-drag]"
      >
        <ToggleGroup.Item value="unified" aria-label="Unified diff">Unified</ToggleGroup.Item>
        <ToggleGroup.Item value="split" aria-label="Side by side diff">Split</ToggleGroup.Item>
      </ToggleGroup.Root>
    {/if}

    {#if folderResult && !entry && !folderResult.diff.identical}
      {@const stats = folderResult.diff.stats}
      <div class="flex items-center gap-1.5">
        <Badge variant="secondary" class="bg-add-bg text-add-ink border-0 tabular-nums" title="Added">
          +{formatCount(stats.added)}
        </Badge>
        <Badge variant="secondary" class="bg-mod-ink/15 text-mod-ink border-0 tabular-nums" title="Modified">
          ~{formatCount(stats.modified)}
        </Badge>
        <Badge variant="secondary" class="bg-del-bg text-del-ink border-0 tabular-nums" title="Deleted">
          -{formatCount(stats.deleted)}
        </Badge>
        {#if stats.unknown > 0}
          <Badge
            variant="secondary"
            class="bg-unknown-ink/15 text-unknown-ink border-0 tabular-nums"
            title="Could not be compared"
          >
            ?{formatCount(stats.unknown)}
          </Badge>
        {/if}
        <span class="text-muted-foreground text-[11px] tabular-nums">
          {Math.round(folderResult.diff.elapsedMs)} ms
        </span>
      </div>
    {:else if result && !result.identical}
      <div class="flex items-center gap-1.5">
        <Badge variant="secondary" class="bg-add-bg text-add-ink border-0 tabular-nums">
          +{formatCount(result.stats.added)}
        </Badge>
        <Badge variant="secondary" class="bg-del-bg text-del-ink border-0 tabular-nums">
          -{formatCount(result.stats.removed)}
        </Badge>
        {#if result.truncated}
          <Badge variant="outline" class="text-muted-foreground">truncated</Badge>
        {/if}
        <span class="text-muted-foreground text-[11px] tabular-nums">
          {Math.round(result.elapsedMs)} ms
        </span>
      </div>
    {/if}

    <div class="ml-auto flex items-center gap-3 [app-region:no-drag]">
      <!-- A tree has no long lines to wrap, but it can hide what did not change. -->
      {#if view === 'diff' && folderResult && !entry}
        <label class="text-muted-foreground flex items-center gap-2 text-xs">
          <Switch bind:checked={hideUnchanged} aria-label="Hide unchanged entries" />
          Hide unchanged
        </label>
      {:else}
        <label class="text-muted-foreground flex items-center gap-2 text-xs">
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
    <div class="bg-del-bg text-del-ink shrink-0 px-3 py-2 text-xs">{error}</div>
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
        <div class="bg-background absolute inset-0 flex flex-col">
          <div class="bg-card flex h-8 shrink-0 items-center gap-2 border-b px-2 text-xs">
            <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" onclick={backToTree} title="Back to the tree (Esc)">
              <ArrowLeftIcon class="size-3.5" />
              Back to tree
            </Button>
            <span class="truncate font-mono" title={node.path}>{node.path}</span>
            <!-- Says why the tree marked it, which matters most when the contents
                 turn out identical and only metadata changed. -->
            <span class="text-mod-ink ml-auto shrink-0">{changeSummary(node)}</span>
          </div>

          <div class="min-h-0 flex-1">
            {#if entry.binary}
              {@const contentChanged = node.reasons.includes('content')}
              <div class="text-muted-foreground grid h-full place-items-center text-center">
                <div class="space-y-1">
                  <p class="text-foreground text-sm">
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
              <DiffView {result} mode={diffMode} {wrap} />
            {/if}
          </div>
        </div>
      {/if}
    {:else if view === 'diff' && result}
      <DiffView {result} mode={diffMode} {wrap} />
    {:else}
      <div class="flex h-full">
        <Editor pane={left} placeholder="Drop the original file or folder here" {wrap} />
        <div class="bg-border w-px shrink-0"></div>
        <Editor pane={right} placeholder="Drop the changed file or folder here" {wrap} />
      </div>
    {/if}

    {#if progress}
      <div class="bg-background/80 absolute inset-0 z-10 grid place-items-center backdrop-blur-sm">
        <div class="bg-card w-80 space-y-3 rounded-lg border p-4 shadow-lg" role="status" aria-live="polite">
          <div class="flex items-center gap-2 text-sm font-medium">
            <LoaderCircleIcon class="text-brand size-4 animate-spin" />
            {progress.phase === 'list' ? 'Listing both folders…' : 'Comparing file contents…'}
          </div>
          {#if progress.phase === 'hash'}
            <div class="bg-muted h-1.5 overflow-hidden rounded-full">
              <div
                class="bg-brand h-full transition-[width]"
                style:width="{progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%"
              ></div>
            </div>
          {/if}
          <p class="text-muted-foreground text-xs tabular-nums">
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
