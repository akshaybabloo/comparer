<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import type { RecentComparison } from '../../shared/launch';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import FileIcon from '@lucide/svelte/icons/file';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import ImageIcon from '@lucide/svelte/icons/image';
	import XIcon from '@lucide/svelte/icons/x';
	import { tick } from 'svelte';

	type Props = {
		items: RecentComparison[];
		/** Reopen a comparison. */
		onopen: (id: string) => void;
		/** Take one comparison off the list. */
		onforget: (id: string) => void;
		/** Empty the list. */
		onclear: () => void;
	};

	let { items, onopen, onforget, onclear }: Props = $props();

	let open = $state(false);
	let root: HTMLElement | null = $state(null);
	let trigger: HTMLButtonElement | null = $state(null);

	/** The last part of a path, whichever separator it uses. */
	function baseName(path: string) {
		return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
	}

	async function close(refocus = false) {
		open = false;
		if (refocus) {
			await tick();
			trigger?.focus();
		}
	}

	function choose(id: string) {
		void close();
		onopen(id);
	}

	// While open, a press anywhere outside the menu closes it, as Escape does.
	$effect(() => {
		if (!open) return;
		const outside = (event: PointerEvent) => {
			if (root && !root.contains(event.target as Node)) void close();
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.stopPropagation();
			void close(true);
		};
		window.addEventListener('pointerdown', outside, true);
		window.addEventListener('keydown', escape, true);
		return () => {
			window.removeEventListener('pointerdown', outside, true);
			window.removeEventListener('keydown', escape, true);
		};
	});
</script>

<div class="relative" bind:this={root}>
	<Button
		bind:ref={trigger}
		variant="outline"
		size="sm"
		class="text-xs"
		aria-label="Recent comparisons"
		aria-haspopup="true"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		<ClockIcon class="size-3.5" />
		Recent
		<ChevronDownIcon class="size-3.5 opacity-60" />
	</Button>

	{#if open}
		<div
			class="absolute top-full right-0 z-50 mt-1 w-[30rem] max-w-[calc(100vw-2rem)] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
			role="menu"
			aria-label="Recent comparisons"
		>
			<div class="flex items-center justify-between px-2 py-1">
				<span class="text-[11px] font-medium text-muted-foreground">Recent comparisons</span>
				<Button
					variant="ghost"
					size="sm"
					class="h-6 px-2 text-[11px]"
					onclick={() => {
						onclear();
						void close(true);
					}}
				>
					Clear all
				</Button>
			</div>
			<ul class="max-h-80 overflow-y-auto">
				{#each items as item (item.id)}
					{@const names = `${baseName(item.left)} ↔ ${baseName(item.right)}`}
					<li class="group flex items-center gap-1 rounded-sm hover:bg-accent">
						<button
							type="button"
							role="menuitem"
							class="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
							title={`${item.left}\n${item.right}`}
							onclick={() => choose(item.id)}
						>
							{#if item.kind === 'folder'}
								<FolderIcon class="size-3.5 shrink-0 text-muted-foreground" />
							{:else if item.kind === 'image'}
								<ImageIcon class="size-3.5 shrink-0 text-muted-foreground" />
							{:else}
								<FileIcon class="size-3.5 shrink-0 text-muted-foreground" />
							{/if}
							<span class="flex min-w-0 flex-col">
								<span class="truncate text-xs">{names}</span>
								<!-- Cut from the start, so the end of the path — the part that tells entries apart — stays. -->
								<span class="truncate text-left text-[11px] text-muted-foreground [direction:rtl]">
									<bdi>{item.right}</bdi>
								</span>
							</span>
						</button>
						<Button
							variant="ghost"
							size="icon-sm"
							class="size-7 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
							aria-label="Remove {names} from recent"
							title="Remove from recent"
							onclick={() => onforget(item.id)}
						>
							<XIcon class="size-3.5" />
						</Button>
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
