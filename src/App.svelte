<script lang="ts">
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { Switch } from '$lib/components/ui/switch';
  import * as ToggleGroup from '$lib/components/ui/toggle-group';
  import DiffView from '$lib/components/DiffView.svelte';
  import Editor from '$lib/components/Editor.svelte';
  import type { DiffResult } from '$lib/diff-types';
  import { formatCount } from '$lib/format';
  import { PaneState } from '$lib/panes.svelte';
  import ArrowLeftRightIcon from '@lucide/svelte/icons/arrow-left-right';
  import GitCompareIcon from '@lucide/svelte/icons/git-compare';
  import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';

  const left = new PaneState();
  const right = new PaneState();

  let view = $state<'edit' | 'diff'>('edit');
  let diffMode = $state<'unified' | 'split'>('unified');
  let wrap = $state(true);

  let result = $state<DiffResult | null>(null);
  let running = $state(false);
  let error = $state('');

  const canCompare = $derived(!left.isEmpty || !right.isEmpty);
  // Nothing to exchange when both sides are blank.
  const canSwap = $derived(!left.isEmpty || !right.isEmpty);

  /** Guards against an older comparison landing after a newer one. */
  let runToken = 0;

  async function compare() {
    if (!canCompare || running) return;
    const token = ++runToken;
    running = true;
    error = '';
    try {
      // Panes that were only read keep their text in the service, so nothing
      // crosses the boundary here; only an edited pane pushes its text back.
      const [leftId, rightId] = await Promise.all([left.sync(), right.sync()]);
      const next = await window.comparer.diff(leftId, rightId);
      if (token !== runToken) return;
      result = next;
      view = 'diff';
    } catch (cause) {
      if (token !== runToken) return;
      error = cause instanceof Error ? cause.message : 'Comparison failed';
      result = null;
    } finally {
      if (token === runToken) running = false;
    }
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
      <ToggleGroup.Item value="diff" aria-label="Show the diff" disabled={!result}>
        Diff
      </ToggleGroup.Item>
    </ToggleGroup.Root>

    {#if view === 'diff' && result}
      <ToggleGroup.Root
        type="single"
        bind:value={
          () => diffMode, (next) => { if (next === 'unified' || next === 'split') diffMode = next; }
        }
        variant="outline"
        size="sm"
        class="[app-region:no-drag]"
      >
        <ToggleGroup.Item value="unified" aria-label="Unified diff">Unified</ToggleGroup.Item>
        <ToggleGroup.Item value="split" aria-label="Side by side diff">Split</ToggleGroup.Item>
      </ToggleGroup.Root>
    {/if}

    {#if result && !result.identical}
      <div class="flex items-center gap-1.5">
        <Badge variant="secondary" class="bg-add-bg text-add-ink border-0 tabular-nums">
          +{formatCount(result.stats.added)}
        </Badge>
        <Badge variant="secondary" class="bg-del-bg text-del-ink border-0 tabular-nums">
          −{formatCount(result.stats.removed)}
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
      <label class="text-muted-foreground flex items-center gap-2 text-xs">
        <Switch bind:checked={wrap} aria-label="Wrap long lines" />
        Wrap
      </label>

      {#if view === 'edit'}
        <Button variant="ghost" size="sm" onclick={swap} disabled={!canSwap} title="Swap sides">
          <ArrowLeftRightIcon class="size-3.5" />
          Swap
        </Button>
      {/if}

      <Button size="sm" onclick={compare} disabled={!canCompare || running}>
        {#if running}
          <LoaderCircleIcon class="size-3.5 animate-spin" />
          Comparing…
        {:else}
          <GitCompareIcon class="size-3.5" />
          Compare
        {/if}
      </Button>
    </div>
  </header>

  {#if error}
    <div class="bg-del-bg text-del-ink shrink-0 px-3 py-2 text-xs">{error}</div>
  {/if}

  <main class="min-h-0 flex-1">
    {#if view === 'diff' && result}
      <DiffView {result} mode={diffMode} {wrap} />
    {:else}
      <div class="flex h-full">
        <Editor pane={left} placeholder="Drop the original file here" {wrap} />
        <div class="bg-border w-px shrink-0"></div>
        <Editor pane={right} placeholder="Drop the changed file here" {wrap} />
      </div>
    {/if}
  </main>
</div>
