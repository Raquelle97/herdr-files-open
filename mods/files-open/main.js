// files-open — a Herdr mod, derived from the shipped `files` mod (Apache-2.0).
// Differences: colour type icons, opening what the editor can't preview with the
// OS default app (downloading it first for a remote machine), right-click copies
// the absolute path.
//
// A lazy file browser for the focused pane's folder, with bounded read-only previews.
// Files the editor can't preview (html, pdf, images, office, archives) open with the
// system default app instead — locally at once, or after downloading from that machine.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, home, appHome, notify } from "herdr";

// Extensions that are far better in a real viewer than as syntax-highlighted text.
const EXTERNAL = new Set([
  "html", "htm", "xhtml", "pdf",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tif", "tiff", "avif", "heic",
  "mp4", "webm", "mov", "mkv", "mp3", "wav", "flac", "ogg",
  "docx", "doc", "xlsx", "xls", "pptx", "ppt", "odt", "ods", "odp", "rtf", "epub",
  "zip", "7z", "rar", "gz", "tgz", "bz2", "xz", "tar", "exe", "msi", "iso", "dmg",
]);
const extOf = (p) => (p.includes(".") ? p.split(".").pop().toLowerCase() : "");
const isExternal = (p) => EXTERNAL.has(extOf(p));
const platform = () => window()?.platform;
const winpath = (p) => (platform() === "windows" ? p.replace(/\//g, "\\") : p);

// One coloured icon per file family. `image()` keeps an icon's own colours, unlike
// `svg()` which is a theme-tinted mask — so a glance is enough to tell a .py from a
// .pdf. Regenerate the set with gen_file_icons.py if you want a different palette.
const ICON_DIR = "mods/files-open/ftypes";
const EXT_ICON = new Map();
for (const [kind, exts] of Object.entries({
  js: "js jsx mjs cjs",
  ts: "ts tsx mts cts",
  py: "py pyi ipynb",
  code: "go rs c h cc cpp cxx hpp hxx cs java kt kts swift m mm rb php lua pl pm scala sc clj cljs ex exs erl hrl hs elm dart zig nim v sol graphql gql proto r jl",
  web: "html htm xhtml css scss sass less vue svelte astro",
  data: "json jsonc json5 yaml yml toml ini cfg conf properties plist xml example",
  md: "md markdown mdx rst",
  shell: "sh bash zsh fish ps1 psm1 bat cmd",
  db: "sql sqlite sqlite3 db mysql pgsql",
  pdf: "pdf",
  doc: "doc docx odt rtf pages",
  sheet: "xls xlsx xlsm csv tsv ods numbers",
  slides: "ppt pptx odp pps key",
  image: "png jpg jpeg gif webp svg ico bmp tif tiff avif heic psd ai",
  audio: "mp3 wav flac ogg m4a aac opus",
  video: "mp4 webm mov mkv avi m4v",
  archive: "zip 7z rar gz tgz bz2 xz tar zst jar war",
  bin: "exe msi dll so dylib iso dmg bin img deb rpm apk class wasm o a lib",
  lock: "pem key crt cer pfx p12 pub gpg asc keystore env",
  git: "gitignore gitattributes gitmodules",
  text: "txt log text",
})) for (const ext of exts.split(" ")) EXT_ICON.set(ext, kind);
// Names that say more than their (missing) extension.
const NAME_ICON = {
  makefile: "shell", dockerfile: "code", "cmakelists.txt": "code", "go.mod": "code", "go.sum": "code",
  license: "text", readme: "text", procfile: "shell", gemfile: "code", vagrantfile: "code",
};
// A path or a bare name both work: only the last segment carries the extension.
const iconOf = (path) => {
  const name = path.split(/[\\/]/).pop().toLowerCase();
  return NAME_ICON[name]
    ?? EXT_ICON.get(name.includes(".") ? name.split(".").pop() : "")
    ?? "text";
};
const iconSvg = (kind) =>
  kind.startsWith("folder") ? `${ICON_DIR}/${kind}.svg` : `${ICON_DIR}/file-${kind}.svg`;


async function launch(local) {
  if (platform() === "windows") await exec("explorer.exe", [winpath(local)]);
  else if (platform() === "macos") await exec("open", [local]);
  else await exec("xdg-open", [local]);
}

// Where a remote file lands before the OS opens it: `mods/files-open/config.json`
// {"cacheDir": "D:/herdr-open"} — any absolute folder; unset keeps `~/herdr-open`.
// Read on every download, so editing the file applies without reloading the mod.
const CONFIG_FILE = `${appHome()}/mods/files-open/config.json`;
async function cacheDir() {
  try {
    const cfg = JSON.parse((await readTextFile(CONFIG_FILE)) ?? "{}");
    if (typeof cfg?.cacheDir === "string" && cfg.cacheDir.trim()) return cfg.cacheDir.trim().replace(/[\\/]+$/, "");
  } catch {}
  return `${home()}/herdr-open`;
}

// Pull a remote file into a local scratch folder so the OS can open it.
async function fetchHere(machine, remote, name) {
  const dir = await cacheDir();
  if (platform() === "windows") await exec("cmd", ["/c", `if not exist "${winpath(dir)}" mkdir "${winpath(dir)}"`]);
  else await exec("mkdir", ["-p", dir]);
  const local = `${dir}/${name}`;
  // A machine's saved name is also its ~/.ssh/config Host, so scp resolves it the same way.
  await exec("scp", ["-q", "-B", `${machine}:${remote}`, local]);
  return local;
}

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html", md: "markdown" };
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.copied = null; this.copiedRow = null; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
    this.watch(cwd, cx);
  }

  toggle(path, cx) {
    const had = this.folders.has(path);
    if (had) this.folders.delete(path);
    else {
      this.folders.add(path);
      const context = this.context;
      this.pending.add(path);
      cx.spawn(async cx => {
        try { await this.loadFolder(path, context); }
        catch (e) { if (this.current(context)) this.error = String(e); }
        finally { this.pending.delete(path); cx.notify(); }
      });
    }
    cx.notify();
  }

  // Hand the file to the OS: local paths straight away, remote ones after an scp.
  handOff(path, cx) {
    const context = this.context, root = this.root, on = this.on;
    this.fileHint = on ? `Downloading from ${on}…` : "Opening…";
    cx.notify();
    cx.spawn(async cx => {
      try {
        const full = `${root}/${path}`;
        const name = path.split("/").pop();
        const local = on ? await fetchHere(on, full, name) : full;
        await launch(local);
        if (this.file === path && this.current(context)) {
          this.fileError = on ? `Downloaded to ${local}, opened in the default app` : "Opened in the default app";
          this.fileHint = null;
        }
      } catch (e) {
        if (this.file === path && this.current(context)) { this.fileError = `Cannot open: ${String(e)}`; this.fileHint = null; }
      } finally { cx.notify(); }
    });
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null; this.fileHint = null;
    if (!path || !cx) return;
    if (isExternal(path)) { this.handOff(path, cx); return; }
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // The path as that machine spells it: what you would paste into a terminal there.
  absolute(path) {
    const root = (this.root ?? "").replace(/[\\/]+$/, ""), full = path ? `${root}/${path}` : root;
    return /\\/.test(root) ? full.replace(/\//g, "\\") : full || "/";
  }

  copyPath(path, cx) {
    const full = this.absolute(path);
    cx.write_to_clipboard(full);
    notify({ title: "Copied path", body: full, level: "success", timeout: 1400 });
    // Nobody sees a toast in every layout, and the header clips on a narrow panel,
    // so the row itself says it: a ✓ on the name for a moment.
    this.copied = full;
    this.copiedRow = path;
    cx.notify();
    cx.timer.after(1400, (acx) => {
      if (this.copiedRow === path) { this.copied = null; this.copiedRow = null; acx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      const external = !entry.dir && isExternal(entry.name);
      const copied = this.copiedRow === path;
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .on_mouse_down("right", (_e, cx) => this.copyPath(path, cx))
        .child(entry.dir ? svg(`mods/files-open/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(image(iconSvg(entry.dir ? (open ? "folder-open" : "folder") : iconOf(entry.name))).w(15).h(15).flex_none())
        .child(div().flex_1().min_w(0).truncate().when(copied, el => el.text_color(t.ansi2).child("✓ ")).child(entry.name))
        .when(external, el => el.child(div().text_size(10).text_color(t.dim).child("↗")))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .when(Boolean(this.file), el => el.child(image(iconSvg(iconOf(this.file))).w(15).h(15).flex_none()))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12)
          .text_color(this.copied ? t.ansi2 : t.dim).cursor_pointer()
          .on_mouse_down("right", (_e, cx) => this.copyPath(this.file ?? "", cx))
          .child(this.copied ? `✓ ${this.copied.split(/[\\/]/).pop() || this.copied}` : this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(Boolean(this.file), el => el.child(div().id("files-open-ext").px(6).cursor_pointer().text_color(t.muted).hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => this.handOff(this.file, cx)).child("↗"))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileHint || this.fileError || "Loading file…")));
  }
}
