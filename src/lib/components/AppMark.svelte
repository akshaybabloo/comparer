<script lang="ts">
	type Props = {
		/** Sizing for the mark. It is square, so one size class is enough. */
		class?: string;
	};

	let { class: className = 'size-4' }: Props = $props();

	// Gradients and the clip need ids that survive the component being used twice.
	const uid = $props.id();
</script>

<!--
	The application icon as vector: the same squircle, split by the same jagged seam, in the
	same indigo and violet as `assets/icon.png`, so the title bar and the icon in the dock or
	task bar read as one mark rather than two unrelated logos.

	`scripts/make-icon.py` draws the icon itself, and this mirrors its constants by hand.
	Change one and the other has to follow, or the app ends up wearing two logos.

	The geometry is the icon's own, scaled from fractions of the canvas to this 16-unit box:
	the seam turns at the same five points, the corner radius is the same 22.5%, the stroke
	is the same 6.2% of the width, and the bars keep their own rhythm and 14% white. The
	seam overshoots top and bottom and is cut back by the clip, exactly as the generated
	icon is.
-->
<svg class={className} viewBox="0 0 16 16" aria-hidden="true">
	<defs>
		<!-- Both gradients run corner to corner across the whole box, in user space: the icon
		     paints each one over the full canvas and then cuts it with the seam, so a gradient
		     measured against its own shape's bounding box would squeeze the left half's
		     colours into the left half and come out too bright. -->
		<linearGradient id="{uid}-left" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="16" y2="16">
			<stop offset="0" stop-color="#3730a3" />
			<stop offset="1" stop-color="#4f46e5" />
		</linearGradient>
		<linearGradient id="{uid}-right" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="16" y2="16">
			<stop offset="0" stop-color="#7c3aed" />
			<stop offset="1" stop-color="#a78bfa" />
		</linearGradient>
		<clipPath id="{uid}-squircle">
			<rect width="16" height="16" rx="3.6" />
		</clipPath>
		<!-- The icon blurs the seam by half its own width and multiplies what is underneath to
		     70%, leaving a soft dark halo either side of the white. Black at 30% through the
		     same blur comes to the same thing. -->
		<filter id="{uid}-halo" x="-50%" y="-50%" width="200%" height="200%">
			<feGaussianBlur stdDeviation="0.5" />
		</filter>
	</defs>

	<g clip-path="url(#{uid}-squircle)">
		<rect width="16" height="16" fill="url(#{uid}-right)" />
		<path d="M-1-1H8.72L7.23 4.64 9.07 8.16 7.01 11.68 8.54 17H-1Z" fill="url(#{uid}-left)" />

		<!-- The icon's faint bars, standing in for lines of text, at different heights on each
		     side so they read as a diff. Same 14% white and same four-per-side rhythm as the
		     icon, which at this size comes out as the texture the icon itself shows. -->
		<g fill="#fff" fill-opacity="0.141">
			{#each [4.16, 6.08, 8, 9.92] as y (y)}
				<rect x="2.72" {y} width="3.68" height="0.56" rx="0.28" />
			{/each}
			{#each [5.12, 7.04, 8.96, 10.88] as y (y)}
				<rect x="9.6" {y} width="3.68" height="0.56" rx="0.28" />
			{/each}
		</g>
		<path
			d="M8.72-1 7.23 4.64 9.07 8.16 7.01 11.68 8.54 17"
			fill="none"
			stroke="#000"
			stroke-opacity="0.3"
			stroke-width="1"
			stroke-linejoin="round"
			filter="url(#{uid}-halo)"
		/>
		<path
			d="M8.72-1 7.23 4.64 9.07 8.16 7.01 11.68 8.54 17"
			fill="none"
			stroke="#fff"
			stroke-width="1"
			stroke-linejoin="round"
		/>
	</g>
</svg>
