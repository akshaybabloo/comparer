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
	};

	let { src, alt, size, scale, onload, onzoom, scrollLeft = $bindable(0), scrollTop = $bindable(0) }: Props = $props();

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
			<img
				{src}
				{alt}
				draggable="false"
				class="max-w-none shadow-lg checkerboard {size ? '' : 'invisible'}"
				style:width={size ? `${size.width * scale}px` : undefined}
				style:height={size ? `${size.height * scale}px` : undefined}
				style:image-rendering={scale >= 2 ? 'pixelated' : undefined}
				onload={(event) => {
					const image = event.currentTarget as HTMLImageElement;
					onload?.({ width: image.naturalWidth, height: image.naturalHeight });
				}}
			/>
		{/if}
	</div>
</div>
