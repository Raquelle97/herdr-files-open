# Files Open

A Herdr panel: the file tree of the folder the focused pane is in, with a colour icon
per file type. Text files preview in place; anything the editor can't show (html, pdf,
images, office, archives) opens in your OS default app — at once for a local folder, or
after pulling it down when the pane is on a remote machine.

![Files Open](preview.png)

## Install

```sh
git clone https://github.com/Raquelle97/herdr-files-open /tmp/files-open
cp -r /tmp/files-open/mods/files-open ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/files-open    # -> check passed
```

Herdr docks it on the right the first time it sees the folder (`mod.json` says
`{ "place": "right", "size": 360 }`). If you already have a layout, put it there
yourself — a block whose content is `{ "mod": "files-open" }`.

## Use

- click a folder to expand it, again to close
- click a text file to preview it in the panel
- click a pdf, image, docx, zip… to open it in the OS default app
- right-click any row, or the header, to copy its absolute path as that machine spells it
- `↗` in the header opens the previewed file in the OS app, `←` goes back to the tree

## Config

`mods/files-open/config.json` is read on every download, so an edit applies at once:

```json
{ "cacheDir": "D:/herdr-open" }
```

Remote files land there and are then opened (default `~/herdr-open`). A local file opens
in place — nothing is copied.

## Limits

- read-only: it lists, previews and opens, it does not rename, delete or save
- 500 entries per folder, 5 000 across the tree, 400 KB per preview
- a remote preview reads the file over that machine's channel; long files are truncated
- binary files are reported as such instead of decoded

## Icons

`mods/files-open/ftypes/*.svg` — 21 file families plus closed and open folders. They are
full-colour SVGs loaded with `image()`; `svg()` would use them as a theme-tinted mask and
flatten every colour. To map more extensions, extend `EXT_ICON` (by extension) or
`NAME_ICON` (by file name) in `main.js`. `gen_file_icons.py` rewrites the whole set after
you change a colour.

| | | | |
|---|---|---|---|
| `</>` js / ts / py / code | browser html / css / vue | `{}` json / yaml / toml | `M↓` markdown |
| `>_` sh / bash / ps1 | cylinder sql / db | page pdf | page doc |
| grid xls / csv / tsv | screen ppt | mountain png / jpg | note mp3 / wav |
| play mp4 / mov | box zip / tar | blocks exe / so | lock .env / .pem |
| branch .gitignore | page txt / log | folder / folder open | |

## Licence

Apache-2.0, see [LICENSE](LICENSE). This is a derivative of the `files` mod that ships
with Herdr (Apache-2.0); the chevrons are Lucide icons (ISC).
