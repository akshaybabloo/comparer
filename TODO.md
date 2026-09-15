# TODO

Note: whitespace is significant when diffing files, so there is no "ignore whitespace" option. The whitespace-blind
matching used only to line up the editors' scrolling stays as it is.

## Diff navigation

- [x] **Change counter.** Show "Change 3 of 12" next to Jump, and update it as the view scrolls.
- [x] **Keyboard shortcuts.**
  - Alt+↑ / Alt+↓ for Jump Up / Down.
  - Alt+1 / 2 / 3 for Show All / Similar / Different.
  - Show each shortcut in its button's tooltip.
- [x] **Search inside the diff.**
  - The diff is virtualized, so the built-in Ctrl+F only finds the rows on screen.
  - Add a search box with next / previous and a match count, and highlight matches.
  - Works in Unified and Split, and together with the Show filter.

## Folders

- [x] **Folder tree navigation.**
  - Jump Up / Down between changed files.
  - Filter by Added / Modified / Deleted, alongside the existing "Hide unchanged".

## Editing and output

- [x] **Copy changes across.** Buttons beside a change copy it to the other side, then the file can be saved.
- [x] **Export.** Save the diff as a unified `.patch` file, or as a standalone HTML report.

## Images

- [x] **Onion skin mode.** Fade one image over the other with an opacity slider.
- [x] **Swipe mode.** A draggable divider shows the left image on one side and the right image on the other.

## Launching

- [x] **Command line.** `comparer <left> <right>` opens both files, folders or images and compares them.
- [x] **Git difftool.** Document the `git config` for using Comparer as `git difftool`.
- [x] **Recent comparisons.** Remember recent pairs and offer to reopen them.

## Tests

- [x] **Add a test runner** for the app (vitest).
- [x] **Unit tests:**
  - `filterRows` (hidden-line counts in Unified and Split);
  - DiffView jump stops;
  - `chunksFromLines` / `mapLine` scroll alignment;
  - `measureText`.

## End-to-end tests

- [x] **Playwright e2e tests.** Drive the packaged Electron app with Playwright's Electron support (`_electron.launch`):
  - open two files, compare, and check the diff, Show filter, Jump buttons, change counter and search;
  - compare two folders, filter the tree, jump between changes and open a modified file;
  - compare two images, move the tolerance slider, and switch Diff / Side by side;
  - the kind rule: an image next to text is refused;
  - run with `pnpm run test:e2e`.
