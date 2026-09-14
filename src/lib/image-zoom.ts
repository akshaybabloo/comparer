import type { ImageSize } from './diff-types';

/**
 * Zoom arithmetic shared by the pane previews and the image diff view, kept out of
 * the components so the scale they draw at is a plain derived value.
 */

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
/** Room left around a fitted image, so it does not touch the edges of its viewport. */
const FIT_PADDING_PX = 32;

export function clampZoom(zoom: number): number {
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * The scale that shows all of `image` in a viewport of the given size. Small images
 * are left at their own size rather than blown up, since fitting a 16px icon to a
 * whole pane would only show blocks.
 */
export function fitZoom(viewportWidth: number, viewportHeight: number, image: ImageSize | null): number {
	if (!image || image.width === 0 || image.height === 0 || viewportWidth === 0 || viewportHeight === 0) return 1;
	const fit = Math.min(
		(viewportWidth - FIT_PADDING_PX) / image.width,
		(viewportHeight - FIT_PADDING_PX) / image.height
	);
	return clampZoom(Math.min(1, fit));
}

/** One step of Ctrl+scroll: about 10% per notch, in either direction. */
export function wheelZoom(zoom: number, deltaY: number): number {
	return clampZoom(zoom * Math.pow(1.1, -deltaY / 100));
}

/** The larger of two sizes in each dimension, so both fit at the same scale. */
export function largest(a: ImageSize, b: ImageSize): ImageSize {
	return { width: Math.max(a.width, b.width), height: Math.max(a.height, b.height) };
}
