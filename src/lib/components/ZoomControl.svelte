<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Slider } from '$lib/components/ui/slider';
	import { MAX_ZOOM, MIN_ZOOM } from '$lib/image-zoom';

	type Props = {
		/** The scale currently drawn at, fitted or not. */
		scale: number;
		/** The image is fitted to its viewport rather than at a chosen scale. */
		fitted: boolean;
		onzoom: (scale: number) => void;
		onfit: () => void;
	};

	let { scale, fitted, onzoom, onfit }: Props = $props();
</script>

<div class="flex items-center gap-2">
	<!-- Logarithmic, so 10–100% gets as much of the track as 100–800%. -->
	<Slider
		type="single"
		min={Math.log2(MIN_ZOOM)}
		max={Math.log2(MAX_ZOOM)}
		step={0.01}
		value={Math.log2(scale)}
		onValueChange={(value) => onzoom(2 ** value)}
		class="w-24"
		aria-label="Zoom"
	/>
	<span class="w-10 text-right text-[11px] text-muted-foreground tabular-nums">{Math.round(scale * 100)}%</span>
	<Button
		variant={fitted ? 'secondary' : 'ghost'}
		size="sm"
		class="h-6 px-2 text-[11px]"
		onclick={onfit}
		aria-pressed={fitted}
		title="Fit the image to the view"
	>
		Fit
	</Button>
</div>
