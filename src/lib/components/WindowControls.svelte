<script lang="ts">
	import type { Snippet } from 'svelte';

	type Props = {
		/** The window has square corners — maximised or full screen — so Maximise offers to restore it. */
		squared: boolean;
	};

	let { squared }: Props = $props();

	/**
	 * The window is frameless, so these are the only window buttons the user gets: each
	 * platform's set is drawn the way that system draws its own, down to its colours, so
	 * nothing here reads as an app's idea of a window button.
	 */
	const macOs = window.comparer.platform === 'darwin';
	const windows = window.comparer.platform === 'win32';

	// A refused call leaves the window exactly as it was; there is nothing to tell the
	// user that the title bar does not already show.

	function minimise() {
		void window.comparer.minimizeWindow().catch(() => {});
	}

	function toggleMaximise() {
		void window.comparer.toggleMaximizeWindow().catch(() => {});
	}

	function close() {
		void window.comparer.closeWindow().catch(() => {});
	}

	const maximiseLabel = $derived(squared ? 'Restore the window' : 'Maximise the window');
	const maximiseHint = $derived(squared ? 'Restore' : 'Maximise');
</script>

<!-- macOS: a filled traffic light, dark ring and all. The glyphs only appear while the
     pointer is over the group, which is what makes the set read as the system's own. -->
{#snippet trafficLight(label: string, hint: string, press: () => void, tone: string, glyph: Snippet)}
	<button
		type="button"
		aria-label={label}
		title={hint}
		onclick={press}
		class="grid size-3 place-items-center rounded-full border-[0.5px] text-transparent transition-colors [app-region:no-drag] group-hover:text-black/55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring {tone}"
	>
		{@render glyph()}
	</button>
{/snippet}

<!-- Windows 11: flat caption buttons, no rounding and no gaps, running the full height of
     the title bar and into its top-right corner. -->
{#snippet captionButton(label: string, hint: string, press: () => void, tone: string, glyph: Snippet)}
	<button
		type="button"
		aria-label={label}
		title={hint}
		onclick={press}
		class="grid h-full w-[46px] place-items-center text-white transition-colors [app-region:no-drag] focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring {tone}"
	>
		{@render glyph()}
	</button>
{/snippet}

<!-- GNOME: round buttons with a filled, faintly lighter background, sitting in from the edge. -->
{#snippet adwaitaButton(label: string, hint: string, press: () => void, tone: string, glyph: Snippet)}
	<button
		type="button"
		aria-label={label}
		title={hint}
		onclick={press}
		class="grid size-6 place-items-center rounded-full bg-[#ffffff1a] text-white transition-colors [app-region:no-drag] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring {tone}"
	>
		{@render glyph()}
	</button>
{/snippet}

<!-- macOS glyphs, on an 8px grid inside the 12px circle. The zoom mark is the pair of
     opposed triangles the system uses, rather than the Option-held plus. -->
{#snippet macMinimise()}
	<svg class="size-2" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
		<path d="M1.6 4h4.8" stroke-linecap="round" />
	</svg>
{/snippet}

{#snippet macMaximise()}
	<svg class="size-2" viewBox="0 0 8 8" fill="currentColor" stroke="none" aria-hidden="true">
		{#if squared}
			<!-- Restore: both arrowheads point in towards the middle. -->
			<path d="M1.2 3.7h2.5V1.2Z" />
			<path d="M6.8 4.3H4.3v2.5Z" />
		{:else}
			<!-- Zoom: both arrowheads point out at their own corner. -->
			<path d="M1.2 1.2h3.2L1.2 4.4Z" />
			<path d="M6.8 6.8H3.6l3.2-3.2Z" />
		{/if}
	</svg>
{/snippet}

{#snippet macClose()}
	<svg class="size-2" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
		<path d="m2.3 2.3 3.4 3.4M5.7 2.3 2.3 5.7" stroke-linecap="round" />
	</svg>
{/snippet}

<!-- Windows glyphs: 10px, a single hairline stroke, held on half pixels so the straight
     edges stay crisp the way the Segoe caption glyphs do. -->
{#snippet winMinimise()}
	<svg class="size-2.5" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">
		<path d="M0 5.5h10" />
	</svg>
{/snippet}

{#snippet winMaximise()}
	<svg class="size-2.5" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">
		{#if squared}
			<!-- Restore: the window steps back out of the screen, over a second one. -->
			<path d="M2.5 2.5v-2h7v7h-2" />
			<rect x="0.5" y="2.5" width="7" height="7" />
		{:else}
			<rect x="0.5" y="0.5" width="9" height="9" />
		{/if}
	</svg>
{/snippet}

{#snippet winClose()}
	<svg class="size-2.5" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">
		<path d="m0.6 0.6 8.8 8.8M9.4 0.6 0.6 9.4" />
	</svg>
{/snippet}

<!-- GNOME glyphs: the 16px symbolic set, drawn with the weight Adwaita gives them. -->
{#snippet gnomeMinimise()}
	<svg class="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
		<path d="M4 8h8" stroke-linecap="round" />
	</svg>
{/snippet}

{#snippet gnomeMaximise()}
	<svg class="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
		{#if squared}
			<path d="M5.75 5.75v-3h7.5v7.5h-3" stroke-linejoin="round" />
			<rect x="2.75" y="5.75" width="7.5" height="7.5" rx="1" />
		{:else}
			<rect x="3.25" y="3.25" width="9.5" height="9.5" rx="1" />
		{/if}
	</svg>
{/snippet}

{#snippet gnomeClose()}
	<svg class="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
		<path d="m4.5 4.5 7 7M11.5 4.5l-7 7" stroke-linecap="round" />
	</svg>
{/snippet}

{#if macOs}
	<div class="group flex items-center gap-2 [app-region:no-drag]">
		{@render trafficLight('Close the window', 'Close', close, 'border-[#e0443e] bg-[#ff5f57]', macClose)}
		{@render trafficLight('Minimise the window', 'Minimise', minimise, 'border-[#dea123] bg-[#febc2e]', macMinimise)}
		{@render trafficLight(maximiseLabel, maximiseHint, toggleMaximise, 'border-[#1aad2b] bg-[#28c840]', macMaximise)}
	</div>
{:else if windows}
	<!-- Breaks out of the title bar's padding so close reaches the window's corner, as it does on Windows. -->
	<div class="-mr-3 flex self-stretch [app-region:no-drag]">
		{@render captionButton(
			'Minimise the window',
			'Minimise',
			minimise,
			'hover:bg-[#ffffff14] active:bg-[#ffffff0f]',
			winMinimise
		)}
		{@render captionButton(
			maximiseLabel,
			maximiseHint,
			toggleMaximise,
			'hover:bg-[#ffffff14] active:bg-[#ffffff0f]',
			winMaximise
		)}
		{@render captionButton('Close the window', 'Close', close, 'hover:bg-[#c42b1c] active:bg-[#c84031]', winClose)}
	</div>
{:else}
	<div class="flex items-center gap-1.5 [app-region:no-drag]">
		{@render adwaitaButton(
			'Minimise the window',
			'Minimise',
			minimise,
			'hover:bg-[#ffffff26] active:bg-[#ffffff33]',
			gnomeMinimise
		)}
		{@render adwaitaButton(
			maximiseLabel,
			maximiseHint,
			toggleMaximise,
			'hover:bg-[#ffffff26] active:bg-[#ffffff33]',
			gnomeMaximise
		)}
		{@render adwaitaButton('Close the window', 'Close', close, 'hover:bg-[#c01c28] active:bg-[#a51d2d]', gnomeClose)}
	</div>
{/if}
