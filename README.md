# Comparer

Comparer is an application for comparing text files and highlighting the differences between them.

## Opening from the command line

Pass two paths to open them side by side and compare them straight away:

```sh
comparer old.txt new.txt
comparer before/ after/          # two folders
comparer screenshot-a.png screenshot-b.png
```

Relative paths are resolved against the current directory. When started this way, the app quits when its window closes,
so tools that wait for it — such as `git difftool` — carry on once you are done.

`comparer --help` lists everything it takes, and `comparer --version` prints the version. Both answer on the command
line without opening a window:

```sh
comparer --version               # 1.2.3
comparer --help
```

On Windows the packaged app is a GUI binary with no console attached, so these print nothing when run bare from `cmd`
or PowerShell. Redirect the output to see it — `comparer --version | more`, or `comparer --version > version.txt`.

Where the `comparer` executable lives depends on how it was installed:

| Platform          | Executable                                           |
| ----------------- | ---------------------------------------------------- |
| Linux (deb / rpm) | `comparer` (on your `PATH`)                          |
| macOS             | `/Applications/comparer.app/Contents/MacOS/comparer` |
| Windows           | `%LOCALAPPDATA%\comparer\comparer.exe`               |

## Using Comparer as `git difftool`

```sh
git config --global difftool.comparer.cmd 'comparer "$LOCAL" "$REMOTE"'
git config --global diff.tool comparer
git config --global difftool.prompt false
```

Then:

```sh
git difftool                 # each changed file, one window at a time
git difftool main -- src/    # against another branch, for some paths
git difftool --dir-diff      # every change at once, as a folder comparison
```

On macOS or Windows, use the full executable path from the table above in `difftool.comparer.cmd`.

## Recent comparisons

Comparisons of files, images or folders opened from disk are remembered. Reopen one from **Recent** in the header, in the
editors view.

## Development

```sh
pnpm install
pnpm start        # run the app
pnpm run test     # unit tests
pnpm run lint     # prettier and eslint
```
