<script lang="ts">
  import ImageViewport from '$lib/components/ImageViewport.svelte';
  import ZoomControl from '$lib/components/ZoomControl.svelte';
  import type { ImageDiffResult, ImageSize } from '$lib/diff-types';
  import { formatCount } from '$lib/format';
  import { clampZoom, fitZoom, largest } from '$lib/image-zoom';
  import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

  type Props = {
    result: ImageDiffResult;
    leftUrl: string | null;
    rightUrl: string | null;
    leftName: string;
    rightName: string;
    /** The painted diff, or the two images side by side. */
    mode: 'diff' | 'split';
    /** A new diff is being computed for a changed tolerance; the current one stays up meanwhile. */
    busy: boolean;
  };

  let { result, leftUrl, rightUrl, leftName, rightName, mode, busy }: Props = $props();

  /** The chosen scale, or null to fit. Shared by every image shown, so they line up. */
  let zoom = $state<number | null>(null);
  let areaWidth = $state(0);
  let areaHeight = $state(0);
  // Both halves of a side by side view scroll together.
  let scrollLeft = $state(0);
  let scrollTop = $state(0);

  const sizes = $derived<{ left: ImageSize; right: ImageSize }>(
    result.kind === 'compared' ? { left: result.size, right: result.size } : { left: result.left, right: result.right },
  );
  // Images of different sizes cannot be diffed, so they are only ever shown side by side.
  const split = $derived(mode === 'split' || result.kind === 'sizeMismatch');
  const fitted = $derived(fitZoom(split ? areaWidth / 2 : areaWidth, areaHeight, largest(sizes.left, sizes.right)));
  const scale = $derived(zoom ?? fitted);

  /**
   * An object URL for the diff PNG. It is replaced in place when the tolerance
   * changes, so the viewport — and where it is scrolled to — stays put.
   */
  const diffUrl = $derived(
    result.kind === 'compared'
      ? URL.createObjectURL(new Blob([result.diffPng as BlobPart], { type: 'image/png' }))
      : null,
  );

  // Releases each URL once a newer result replaces it, or the view closes. The image
  // already drawn from it stays on screen until the next one has loaded.
  $effect(() => {
    const url = diffUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  });
</script>

{#snippet header(name: string, size: ImageSize)}
  <div class="bg-card flex h-7 shrink-0 items-center gap-2 border-b px-3 text-xs">
    <span class="truncate font-medium" title={name}>{name}</span>
    <span class="text-muted-foreground shrink-0 tabular-nums">{size.width}×{size.height}</span>
  </div>
{/snippet}

<div class="flex h-full flex-col">
  <div class="bg-card flex h-9 shrink-0 items-center gap-3 border-b px-3 text-xs">
    {#if result.kind === 'sizeMismatch'}
      <span class="text-unknown-ink flex min-w-0 items-center gap-1.5">
        <TriangleAlertIcon class="size-3.5 shrink-0" />
        <span class="truncate">
          These images are different sizes — {result.left.width}×{result.left.height} and
          {result.right.width}×{result.right.height} — so they can only be compared by eye.
        </span>
      </span>
    {:else}
      <span class="text-muted-foreground tabular-nums">
        {result.size.width}×{result.size.height} · {formatCount(result.totalPixels)} pixels ·
        tolerance {result.tolerance}
      </span>
    {/if}
    {#if busy}
      <LoaderCircleIcon class="text-brand size-3.5 shrink-0 animate-spin" aria-label="Updating" />
    {/if}
    <div class="ml-auto shrink-0">
      <ZoomControl
        {scale}
        fitted={zoom === null}
        onzoom={(next) => (zoom = clampZoom(next))}
        onfit={() => (zoom = null)}
      />
    </div>
  </div>

  <div class="min-h-0 flex-1" bind:clientWidth={areaWidth} bind:clientHeight={areaHeight}>
    {#if split}
      <div class="flex h-full">
        <div class="flex min-w-0 flex-1 flex-col">
          {@render header(leftName, sizes.left)}
          <div class="min-h-0 flex-1">
            <ImageViewport
              src={leftUrl}
              alt={leftName}
              size={sizes.left}
              {scale}
              onzoom={(next) => (zoom = next)}
              bind:scrollLeft
              bind:scrollTop
            />
          </div>
        </div>
        <div class="bg-border w-px shrink-0"></div>
        <div class="flex min-w-0 flex-1 flex-col">
          {@render header(rightName, sizes.right)}
          <div class="min-h-0 flex-1">
            <ImageViewport
              src={rightUrl}
              alt={rightName}
              size={sizes.right}
              {scale}
              onzoom={(next) => (zoom = next)}
              bind:scrollLeft
              bind:scrollTop
            />
          </div>
        </div>
      </div>
    {:else}
      <ImageViewport
        src={diffUrl}
        alt="Differences"
        size={sizes.left}
        {scale}
        onzoom={(next) => (zoom = next)}
        bind:scrollLeft
        bind:scrollTop
      />
    {/if}
  </div>
</div>
