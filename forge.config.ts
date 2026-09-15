import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const HOMEPAGE = 'https://github.com/akshaybabloo/comparer';

// Extensionless: packager appends `.ico` on Windows and `.icns` on macOS. Linux
// packages take the PNG through their makers instead.
const ICON = 'assets/icon';

const LINUX_OPTIONS = {
	icon: `${ICON}.png`,
	homepage: HOMEPAGE,
	categories: ['Development', 'Utility']
};

const config: ForgeConfig = {
	packagerConfig: {
		asar: true,
		icon: ICON,
		appBundleId: 'com.gollahalli.comparer',
		appCategoryType: 'public.app-category.developer-tools'
	},
	rebuildConfig: {},
	makers: [
		new MakerSquirrel({
			setupIcon: `${ICON}.ico`,
			// Shown in Add/Remove Programs, which only reads an icon over HTTP.
			iconUrl: `${HOMEPAGE}/raw/main/${ICON}.ico`
		}),
		new MakerZIP({}, ['darwin']),
		new MakerDMG({ icon: `${ICON}.icns` }, ['darwin']),
		new MakerRpm({ options: { ...LINUX_OPTIONS, license: 'MIT' } }),
		new MakerDeb({ options: LINUX_OPTIONS })
	],
	plugins: [
		new VitePlugin({
			// `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
			// If you are familiar with Vite configuration, it will look really familiar.
			build: [
				{
					// `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
					entry: 'src/main.ts',
					config: 'vite.main.config.mts',
					target: 'main'
				},
				{
					entry: 'src/preload.ts',
					config: 'vite.preload.config.mts',
					target: 'preload'
				},
				{
					// The diff service runs in a Node utilityProcess, so it builds the
					// same way the main process does.
					entry: 'src/services/diff-service.ts',
					config: 'vite.service.config.mts',
					target: 'main'
				}
			],
			renderer: [
				{
					name: 'main_window',
					config: 'vite.renderer.config.mts'
				}
			]
		}),
		// Fuses are used to enable/disable various Electron functionality
		// at package time, before code signing the application
		new FusesPlugin({
			version: FuseVersion.V1,
			[FuseV1Options.RunAsNode]: false,
			[FuseV1Options.EnableCookieEncryption]: true,
			[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
			[FuseV1Options.EnableNodeCliInspectArguments]: false,
			[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
			[FuseV1Options.OnlyLoadAppFromAsar]: true
		})
	]
};

export default config;
