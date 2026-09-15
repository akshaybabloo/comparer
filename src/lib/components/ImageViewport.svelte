<script lang="ts">
	import type { ImageSize } from '$lib/diff-types';
	import { wheelZoom } from '$lib/image-zoom';

	type Props = {
		src: string | null;
		alt: string;
		/** The image's pixel size, or null until it is known, which hides the image meanwhile. */
		size: ImageSize | null;
		/** The scale to draw at; fitting is the caller's decision, since only it knows what to fit. */
		scale: number;
		/** Reports the image's pixel size once it has loaded. */
		onload?: (size: ImageSize) => void;
		/** Ctrl+scroll asked for a new scale. */
		onzoom?: (scale: number) => void;
		/** Scroll position, bindable so two viewports can stay in step. */
		scrollLeft?: number;
		scrollTop?: number;
		/** A second image of the same size drawn over the first, for onion skin and swipe. */
		overlaySrc?: string | null;
		overlayAlt?: string;
		/** How opaque the overlay is, from 0 to 1, when it is not swiped. */
		overlayOpacity?: number;
		/**
		 * Where the overlay starts, as a fraction of the width: the first image shows to the
		 * left of it and the overlay to the right, with a divider to drag. Null for no swipe.
		 */
		swipe?: number | null;
		onswipe?: (fraction: number) => void;
	};

	let {
		src,
		alt,
		size,
		scale,
		onload,
		onzoom,
		scrollLeft = $bindable(0),
		scrollTop = $bindable(0),
		overlaySrc = null,
		overlayAlt = '',
		overlayOpacity = 1,
		swipe = null,
		onswipe
	}: Props = $props();

	let stack: HTMLElement | null = $state(null);

	/** Moves the swipe divider to the pointer. */
	function swipeTo(event: PointerEvent) {
		if (!stack || !onswipe) return;
		const bounds = stack.getBoundingClientRect();
		onswipe(Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)));
	}

	function onSwipeKey(event: KeyboardEvent) {
		if (swipe === null || !onswipe) return;
		const step = event.shiftKey ? 0.1 : 0.01;
		if (event.key === 'ArrowLeft') onswipe(Math.max(0, swipe - step));
		else if (event.key === 'ArrowRight') onswipe(Math.min(1, swipe + step));
		else if (event.key === 'Home') onswipe(0);
		else if (event.key === 'End') onswipe(1);
		else return;
		event.preventDefault();
	}

	let viewport: HTMLElement | null = $state(null);

	/**
	 * The point under the cursor when Ctrl+scroll changed the scale, in image pixels.
	 * Once the new scale is drawn the viewport scrolls to keep that point under the
	 * cursor, which is what makes zooming feel anchored rather than drifting to a corner.
	 */
	let anchor: { imageX: number; imageY: number; viewX: number; viewY: number } | null = null;

	$effect(() => {
		const current = scale;
		if (!viewport || !anchor) return;
		viewport.scrollLeft = anchor.imageX * current - anchor.viewX;
		viewport.scrollTop = anchor.imageY * current - anchor.viewY;
		anchor = null;
	});

	// Follows a scroll position set from outside, such as the other half of a side by
	// side view. Setting the position it already has fires no event, so this cannot loop.
	$effect(() => {
		const left = scrollLeft;
		const top = scrollTop;
		if (!viewport) return;
		if (viewport.scrollLeft !== left) viewport.scrollLeft = left;
		if (viewport.scrollTop !== top) viewport.scrollTop = top;
	});

	/**
	 * Ctrl+scroll zooms. Attached by hand because the listener has to be non-passive to
	 * stop the page from scrolling as well.
	 */
	function wheel(node: HTMLElement) {
		const listener = (event: WheelEvent) => {
			if (!event.ctrlKey || !onzoom) return;
			event.preventDefault();
			const bounds = node.getBoundingClientRect();
			const viewX = event.clientX - bounds.left;
			const viewY = event.clientY - bounds.top;
			anchor = { imageX: (node.scrollLeft + viewX) / scale, imageY: (node.scrollTop + viewY) / scale, viewX, viewY };
			onzoom(wheelZoom(scale, event.deltaY));
		};
		node.addEventListener('wheel', listener, { passive: false });
		return () => node.removeEventListener('wheel', listener);
	}
</script>

<div
	bind:this={viewport}
	{@attach wheel}
	onscroll={(event) => {
		scrollLeft = event.currentTarget.scrollLeft;
		scrollTop = event.currentTarget.scrollTop;
	}}
	class="h-full overflow-auto"
>
	<!-- At least as large as the viewport, so a small image sits in the middle, and as
       large as the image, so a zoomed one scrolls. -->
	<div class="flex h-max min-h-full w-max min-w-full items-center justify-center p-4">
		{#if src}
			<div
				bind:this={stack}
				class="relative shrink-0 shadow-lg {size ? '' : 'invisible'}"
				style:width={size ? `${size.width * scale}px` : undefined}
				style:height={size ? `${size.height * scale}px` : undefined}
			>
				<img
					{src}
					{alt}
					draggable="false"
					class="block max-w-none checkerboard {size ? 'size-full' : ''}"
					style:image-rendering={scale >= 2 ? 'pixelated' : undefined}
					onload={(event) => {
						const image = event.currentTarget as HTMLImageElement;
						onload?.({ width: image.naturalWidth, height: image.naturalHeight });
					}}
				/>
				{#if overlaySrc}
					<!-- No checkerboard of its own: where the overlay is transparent, the image below shows. -->
					<img
						src={overlaySrc}
						alt={overlayAlt}
						draggable="false"
						class="pointer-events-none absolute inset-0 size-full max-w-none"
						style:opacity={swipe === null ? overlayOpacity : undefined}
						style:clip-path={swipe === null ? undefined : `inset(0 0 0 ${swipe * 100}%)`}
						style:image-rendering={scale >= 2 ? 'pixelated' : undefined}
					/>
					{#if swipe !== null}
						<div
							role="slider"
							tabindex="0"
							aria-label="Swipe between the images"
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={Math.round(swipe * 100)}
							class="group absolute inset-y-0 w-4 -translate-x-1/2 cursor-ew-resize touch-none outline-none"
							style:left="{swipe * 100}%"
							onpointerdown={(event) => {
								event.currentTarget.setPointerCapture(event.pointerId);
								swipeTo(event);
							}}
							onpointermove={(event) => {
								if (event.currentTarget.hasPointerCapture(event.pointerId)) swipeTo(event);
							}}
							onkeydown={onSwipeKey}
						>
							<div class="mx-auto h-full w-0.5 bg-brand shadow-[0_0_0_1px_rgb(0_0_0/0.4)]"></div>
							<div
								class="absolute top-1/2 left-1/2 grid size-6 -translate-1/2 place-items-center rounded-full border border-brand bg-card text-[11px] text-brand shadow-md group-focus-visible:ring-2 group-focus-visible:ring-brand/60"
								aria-hidden="true"
							>
								⇆
							</div>
						</div>
					{/if}
				{/if}
			</div>
		{/if}
	</div>
</div>
