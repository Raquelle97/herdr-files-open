// files-open — a Herdr mod, derived from the shipped `files` mod (Apache-2.0).
// Differences: colour type icons, a right-click menu (preview, open, open with…,
// download to…, copy path), markdown rendered in place, files dropped onto the
// panel uploaded into the folder shown, and double-click opening with the OS app.
//
// A lazy file browser for the focused pane's folder, with bounded read-only previews.
// Files the editor can't preview (html, pdf, images, office, archives) open with the
// system default app instead — locally at once, or after downloading from that machine.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, home, appHome, notify,
  props, openOverlay, closeOverlay, pickFolder, setShared, shared } from "herdr";

// Extensions that are far better in a real viewer than as syntax-highlighted text.
const EXTERNAL = new Set([
  "html", "htm", "xhtml", "pdf",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tif", "tiff", "avif", "heic",
  "mp4", "webm", "mov", "mkv", "mp3", "wav", "flac", "ogg",
  "docx", "doc", "xlsx", "xls", "pptx", "ppt", "odt", "ods", "odp", "rtf", "epub",
  "zip", "7z", "rar", "gz", "tgz", "bz2", "xz", "tar", "exe", "msi", "iso", "dmg",
]);
// Rendered by TextView instead of a code editor.
const MARKDOWN = new Set(["md", "markdown", "mdx", "rst"]);
const extOf = (p) => (p.includes(".") ? p.split(".").pop().toLowerCase() : "");
const isExternal = (p) => EXTERNAL.has(extOf(p));
const isMarkdown = (p) => MARKDOWN.has(extOf(p));
const base = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? "";
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

// The OS "Open with…" chooser. Only Windows has one on the command line; elsewhere
// the default app is the only reasonable answer.
async function launchWith(local) {
  if (platform() === "windows") await exec("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", winpath(local)]);
  else await launch(local);
}

// Where downloads land: `mods/files-open/config.json`
// {"downloadDir": "D:/Downloads"} — any absolute folder. Unset means the OS
// Downloads folder; `cacheDir` is the older name for the same setting and still
// works, so an existing config keeps pointing where it did.
// Read on every download, so editing the file applies without reloading the mod.
const CONFIG_FILE = `${appHome()}/mods/files-open/config.json`;
const trimDir = (p) => String(p).trim().replace(/[\\/]+$/, "");
async function readConfig() {
  try { return JSON.parse((await readTextFile(CONFIG_FILE)) ?? "{}") ?? {}; } catch { return {}; }
}
async function saveDir() {
  const cfg = await readConfig();
  for (const k of ["downloadDir", "cacheDir"]) {
    if (typeof cfg?.[k] === "string" && cfg[k].trim()) return trimDir(cfg[k]);
  }
  return `${home()}/Downloads`;
}
// Remember where a file was just saved, so the next save can say where it goes.
async function rememberSaveDir(dir) {
  try {
    const before = (await readTextFile(CONFIG_FILE)) ?? null;
    const cfg = before ? (JSON.parse(before) ?? {}) : {};
    cfg.downloadDir = trimDir(dir);
    await writeTextFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", before);
  } catch {}
}

async function makeDir(dir) {
  if (platform() === "windows") {
    const q = String(winpath(dir)).replace(/'/g, "''");
    await exec("powershell", ["-NoProfile", "-Command", `New-Item -ItemType Directory -Force -Path '${q}' | Out-Null`]);
  } else await exec("mkdir", ["-p", dir]);
}

// Pull a remote file into the local download folder so the OS can open it.
async function fetchHere(machine, remote, name) {
  const dir = await saveDir();
  await makeDir(dir);
  const local = `${dir}/${name}`;
  // A machine's saved name is also its ~/.ssh/config Host, so scp resolves it the same way.
  await exec("scp", ["-q", "-B", `${machine}:${remote}`, local]);
  return local;
}

// A name in `dir` that leaves whatever is already there alone: a.txt, a (1).txt, …
async function freeName(dir, name) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name, tail = dot > 0 ? name.slice(dot) : "";
  if (platform() === "windows") {
    const q = (s) => s.replace(/'/g, "''");
    const ps = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); & { param($d, $n, $s, $e) "
      + "if (-not (Test-Path -LiteralPath (Join-Path $d $n))) { Join-Path $d $n; return } "
      + "for ($i = 1; $i -lt 200; $i++) { $c = Join-Path $d ('{0} ({1}){2}' -f $s, $i, $e); "
      + "if (-not (Test-Path -LiteralPath $c)) { $c; return } } } '"
      + q(dir) + "' '" + q(name) + "' '" + q(stem) + "' '" + q(tail) + "'";
    const r = await exec("powershell", ["-NoProfile", "-Command", ps]);
    return (r.stdout || "").trim() || `${winpath(dir)}\\${name}`;
  }
  const script = 'p="$1/$2"; [ -e "$p" ] || { printf %s "$p"; exit; }; i=1; '
    + 'while [ $i -lt 200 ]; do p="$1/$3 ($i)$4"; [ -e "$p" ] || { printf %s "$p"; exit; }; i=$((i+1)); done; '
    + 'printf %s "$1/$2"';
  const r = await exec("sh", ["-c", script, "name", dir, name, stem, tail]);
  return (r.stdout || "").trim() || `${dir}/${name}`;
}

// Copy a local file or folder into `dir`, never overwriting; returns where it landed.
// Powershell rather than `cmd /c copy`: a destination with a space or a bracket in
// it makes cmd re-read its own quotes and copy nothing.
async function copyInto(src, dir) {
  if (platform() === "windows") {
    const q = (s) => String(s).replace(/'/g, "''");
    const ps = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); & { param($s, $d) "
      + "if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null } "
      + "$b = [IO.Path]::GetFileNameWithoutExtension($s); $e = [IO.Path]::GetExtension($s); "
      + "$t = Join-Path $d ([IO.Path]::GetFileName($s)); "
      + "for ($i = 1; Test-Path -LiteralPath $t; $i++) { $t = Join-Path $d ('{0} ({1}){2}' -f $b, $i, $e) } "
      + "Copy-Item -LiteralPath $s -Destination $t -Force -Recurse; $t } '"
      + q(winpath(src)) + "' '" + q(winpath(dir)) + "'";
    const r = await exec("powershell", ["-NoProfile", "-Command", ps]);
    return (r.stdout || "").trim() || `${winpath(dir)}\\${base(src)}`;
  }
  const script = 'mkdir -p "$2"; s="$1"; d="$2"; n=${s##*/}; t="$d/$n"; b=${n%.*}; e=${n##*.}; '
    + 'e=$([ "$e" = "$n" ] && echo "" || echo ".$e"); i=1; '
    + 'while [ -e "$t" ]; do t="$d/$b ($i)$e"; i=$((i+1)); done; cp -Rp "$s" "$t"; printf %s "$t"';
  const r = await exec("sh", ["-c", script, "cp", src, dir]);
  return (r.stdout || "").trim() || `${dir}/${base(src)}`;
}

// scp a remote file or folder down to `dir`, never overwriting; returns the local path.
async function pullInto(machine, remote, dir) {
  const dest = await freeName(dir, base(remote));
  await makeDir(dir);
  await exec("scp", ["-q", "-B", "-r", `${machine}:${remote}`, dest]);
  return dest;
}

// scp a local file or folder up into a folder on `machine`, also without overwriting.
async function pushUp(machine, local, remoteDir) {
  const dest = await freeNameRemote(machine, remoteDir, base(local));
  await exec("scp", ["-q", "-B", "-r", local, `${machine}:${dest}`]);
  return dest;
}

// The same free name, asked of the machine itself in one round trip.
async function freeNameRemote(machine, dir, name) {
  const folder = dir.replace(/\/+$/, "");
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name, tail = dot > 0 ? name.slice(dot) : "";
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const cmd = `d=${q(folder)}; n=${q(name)}; s=${q(stem)}; e=${q(tail)}; t="$d/$n"; `
    + `[ -e "$t" ] || { printf %s "$t"; exit 0; }; i=1; `
    + `while [ $i -lt 200 ]; do t="$d/$s ($i)$e"; [ -e "$t" ] || { printf %s "$t"; exit 0; }; i=$((i+1)); done; `
    + `printf %s "$d/$n"`;
  try {
    const r = await exec("ssh", [machine, cmd]);
    const made = (r.stdout || "").trim();
    if (made) return made;
  } catch {}
  return `${folder}/${name}`;
}

// The system's file picker: several files at once, empty when cancelled.
// `pickFolder` only answers with a folder, and a drop already covers the rest.
async function pickFiles(title) {
  try {
    if (platform() === "windows") {
      const ps = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); "
        + "Add-Type -AssemblyName System.Windows.Forms; "
        + "$o = New-Object System.Windows.Forms.Form; $o.TopMost = $true; "
        + "$d = New-Object System.Windows.Forms.OpenFileDialog; $d.Multiselect = $true; "
        + "$d.Title = '" + String(title).replace(/'/g, "''") + "'; "
        + "if ($d.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames }; $o.Dispose()";
      const r = await exec("powershell", ["-NoProfile", "-STA", "-Command", ps], { timeout: 300000 });
      return split(r.stdout);
    }
    if (platform() === "macos") {
      const r = await exec("osascript", ["-e",
        'set f to choose file with multiple selections allowed\nset o to ""\nrepeat with x in f\nset o to o & (POSIX path of x) & linefeed\nend repeat\nreturn o'], { timeout: 300000 });
      return split(r.stdout);
    }
    const r = await exec("sh", ["-c", "command -v zenity >/dev/null && zenity --file-selection --multiple --separator='\\n'"], { timeout: 300000 });
    return split(r.stdout);
  } catch { return []; }
}
const split = (s) => String(s ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

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
    // The same mod draws its context menu as a popup; that copy holds no file tree.
    if (props()?.fileMenu) return;
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    // A popup cannot outlive its own press, so the menu only records what was
    // asked for and this view does it: at most a beat later.
    cx.timer.every(300, cx => this.takeIntent(cx));
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
      this.selected = null; this.selectedDir = null; this.status = null; this.hint = null; this.failed = false;
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
  handOff(path, cx, withChooser = false) {
    const context = this.context, root = this.root, on = this.on;
    this.hint = on ? `Downloading from ${on}…` : (withChooser ? "Choosing an app…" : "Opening…");
    cx.notify();
    cx.spawn(async cx => {
      try {
        const full = `${root}/${path}`;
        const name = path.split("/").pop();
        const local = on ? await fetchHere(on, full, name) : full;
        if (withChooser) await launchWith(local);
        else await launch(local);
        if (this.current(context)) {
          this.status = on ? `Downloaded to ${local}` : (withChooser ? "Opened with the app you picked" : "Opened in the default app");
          this.hint = null;
        }
      } catch (e) {
        if (this.current(context)) { this.status = `Cannot open: ${String(e)}`; this.hint = null; }
      } finally { cx.notify(); this.fade(cx); }
    });
  }

  // Save a copy: straight into the download folder, or wherever the person picks.
  download(path, cx, choose = false) {
    const context = this.context;
    cx.spawn(async cx => {
      const dir = choose ? await pickFolder({ prompt: `Download ${base(path)} to…` }) : await saveDir();
      if (!dir) return;
      this.hint = `Copying to ${dir}…`; cx.notify();
      try {
        const full = `${this.root}/${path}`;
        const saved = this.on ? await pullInto(this.on, full, dir) : await copyInto(full, dir);
        if (choose) await rememberSaveDir(dir);
        if (this.current(context)) this.status = `Saved to ${saved}`;
        notify({ title: "Downloaded", body: saved, level: "success", timeout: 2400 });
      } catch (e) {
        if (this.current(context)) this.status = `Download failed: ${String(e)}`;
      } finally { this.hint = null; cx.notify(); this.fade(cx); }
    });
  }

  // Files from outside (a drop, or the system picker) land in the folder on screen.
  upload(paths, cx, into = "") {
    if (!paths?.length) return;
    const context = this.context, root = this.root, on = this.on;
    const remoteDir = `${(root ?? "").replace(/\/+$/, "")}${into ? "/" + into : ""}`;
    const localDir = into ? `${root}/${into}` : root;
    const where = into || base(root) || root;
    const total = paths.length;
    this.hint = `Uploading ${total} item${total > 1 ? "s" : ""} to ${where}…`;
    this.failed = false;
    cx.notify();
    cx.spawn(async cx => {
      const done = [];
      try {
        for (const p of paths) {
          if (on) await pushUp(on, p, remoteDir);
          else await copyInto(p, localDir);
          done.push(base(p));
          if (this.current(context)) { this.hint = `Uploading ${done.length}/${total}…`; cx.notify(); }
        }
        if (this.current(context)) {
          this.failed = false;
          this.status = `Uploaded ${done.length} → ${where}`;
          notify({ title: "Uploaded", body: `${done.slice(0, 3).join(", ")}${done.length > 3 ? "…" : ""} → ${where}`, level: "success", timeout: 2400 });
        }
      } catch (e) {
        if (this.current(context)) {
          this.failed = true;
          const why = String(e).split("\n")[0].slice(0, 160);
          this.status = `Upload failed after ${done.length}/${total}: ${why}`;
        }
      } finally {
        this.hint = null;
        if (this.current(context)) this.refresh(cx);
        cx.notify(); this.fade(cx);
      }
    });
  }

  startUpload(cx, into = "") {
    const context = this.context;
    cx.spawn(async cx => {
      const paths = await pickFiles(`Upload to ${into || base(this.root) || "this computer"}`);
      if (paths.length && this.current(context)) this.upload(paths, cx, into);
    });
  }

  // The context menu itself: a popup drawn by this same mod, one row per action.
  menuFor(path, dir, cx) {
    this.selected = path;
    this.selectedDir = dir;
    openOverlay({
      mod: "files-open", kind: "popup", at: "pointer", width: 236,
      props: { fileMenu: { path, name: base(path), dir, root: this.root, on: this.on } },
    });
    cx.notify();
  }

  renderMenu(t) {
    const m = props()?.fileMenu;
    if (!m) return div();
    const item = (id, label, what) => h_flex().id(`fm-${id}`).h(30).px(9).rounded(7).items_center().cursor_pointer()
      .hover(el => el.bg(t.hover))
      .on_click((_e, _cx) => { this.ask({ what, path: m.path, dir: m.dir, root: m.root, on: m.on }); closeOverlay(props().overlay); })
      .child(div().flex_1().min_w(0).truncate().child(label));
    return v_flex().id("files-menu").w_full().p(4).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .child(div().px(9).pt(3).pb(6).text_size(11).text_color(t.dim).truncate().child(m.name))
      .when(!m.dir && !isExternal(m.path), el => el.child(item("preview", "Preview", "preview")))
      .when(!m.dir, el => el.child(item("open", "Open with default app", "open")))
      .when(!m.dir, el => el.child(item("openwith", platform() === "windows" ? "Open with…" : "Open in another app", "openwith")))
      .when(!m.dir, el => el.child(item("download", "Download", "download")))
      .when(!m.dir, el => el.child(item("downloadto", "Download to…", "downloadto")))
      .when(m.dir, el => el.child(item("upload", "Upload files here…", "upload")))
      .child(item("copy", "Copy path", "copy"));
  }

  // A popup cannot finish an scp or a picker after it closes, and it draws in a
  // different view, so it leaves a note for this one instead.
  ask(intent) { setShared("files-open.intent", { ...intent, at: Date.now() }); }

  takeIntent(cx) {
    const it = shared("files-open.intent");
    if (!it?.at || it.at === this.intentAt || !this.root) return;
    this.intentAt = it.at;
    const path = it.path ?? "";
    if (it.what === "preview") this.show(path, cx);
    else if (it.what === "open") this.handOff(path, cx);
    else if (it.what === "openwith") this.handOff(path, cx, true);
    else if (it.what === "download") this.download(path, cx);
    else if (it.what === "downloadto") this.download(path, cx, true);
    else if (it.what === "upload") this.startUpload(cx, path);
    else if (it.what === "copy") this.copyPath(path, cx);
  }

  fade(cx) {
    const at = Date.now();
    this.statusAt = at;
    cx.timer.after(4200, (acx) => { if (this.statusAt === at) { this.status = null; acx.notify(); } });
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.md = null;
    this.file = path; this.fileError = null; this.hint = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    if (isExternal(path)) {
      // A pdf or an image is not opened by merely landing on it; a double-click
      // or the menu does that, and the tree stays where it is.
      this.file = null;
      return;
    }
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        if (isMarkdown(path)) { this.md = text.length > 400000 ? text.slice(0, 400000) + "\n\n… (file truncated)" : text; return; }
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
      const copied = this.copiedRow === path, chosen = this.selected === path;
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(chosen, el => el.bg(t.selected))
        .hover(s => s.bg(chosen ? t.selected : t.hover))
        .on_click((e, cx) => {
          this.selected = path; this.selectedDir = entry.dir;
          if (entry.dir) { this.toggle(path, cx); return; }
          if (e.click_count >= 2) this.handOff(path, cx);
          else if (!external) this.show(path, cx);
          else cx.notify();
        })
        .on_mouse_down("right", (_e, cx) => this.menuFor(path, entry.dir, cx))
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
    const t = theme();
    if (props()?.fileMenu) return this.renderMenu(t);
    if (key() !== this.context?.key) this.refresh(cx);
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_drop((event, cx) => this.upload(event.paths, cx, this.selectedDir ? this.selected ?? "" : ""))
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .when(Boolean(this.file), el => el.child(image(iconSvg(iconOf(this.file))).w(15).h(15).flex_none()))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12)
          .text_color(this.copied ? t.ansi2 : t.dim).cursor_pointer()
          .on_mouse_down("right", (_e, cx) => this.copyPath(this.file ?? "", cx))
          .child(this.copied ? `✓ ${this.copied.split(/[\\/]/).pop() || this.copied}` : this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(!this.file, el => el.child(div().id("files-upload").px(3).cursor_pointer().text_color(t.muted).hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => this.startUpload(cx)).child(svg("mods/files-open/upload-arrow.svg").size(15))))
        .when(Boolean(this.file), el => el.child(div().id("files-open-ext").px(6).cursor_pointer().text_color(t.muted).hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => this.handOff(this.file, cx)).child("↗"))))
      .when(Boolean(this.status || this.hint), el => el.child(div().px(12).py(5).flex_none().border_b(1).border_color(t.border).text_size(11)
        .text_color(this.failed ? t.ansi1 : t.dim).truncate().child(this.status || this.hint)))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(
        this.md != null
          ? div().id("files-md").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(10).text_size(13)
              .child(TextView.markdown(`files-md:${this.file}`, this.md).selectable(true).scrollable(true))
          : this.code ? Editor.new(this.code).flex_1().min_h(0)
          : div().p(12).text_color(t.dim).child(this.hint || this.fileError || "Loading file…")));
  }
}
