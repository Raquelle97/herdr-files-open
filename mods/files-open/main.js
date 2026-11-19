// files-open — a Herdr mod, derived from the shipped `files` mod (Apache-2.0).
// Differences: colour type icons, a right-click menu (preview, open, open with…,
// download to…, copy path), markdown rendered in place, files dropped onto the
// panel uploaded into the folder shown, and double-click opening with the OS app.
//
// A lazy file browser for the focused pane's folder, with bounded read-only previews.
// Files the editor can't preview (html, pdf, images, office, archives) open with the
// system default app instead — locally at once, or after downloading from that machine.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Input, InputState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, home, appHome, notify,
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

// Show a download where it landed. On Windows that is the containing folder only:
// `/select,<path>` needs the switch and the path on one command line, and handed over
// as a single argv token Explorer rejects it and falls back to its default folder —
// Documents or Desktop, which is what people saw instead of the download. A plain
// folder path is the one form that always lands. macOS can still select the file.
async function showInFileManager(local) {
  try {
    if (platform() === "windows") {
      const p = winpath(local);
      await exec("explorer.exe", [p.replace(/[\\/][^\\/]*$/, "") || p]);
    } else if (platform() === "macos") await exec("open", ["-R", local]);
    else await exec("xdg-open", [String(local).replace(/[\\/][^\\/]*$/, "") || "/"]);
  } catch {}
}

// A path as typed in the header box: `~`, a relative name, or an absolute path with
// either separator. `..` is folded here so the tree never shows a `../..` root.
function resolvePath(text, root) {
  const raw = String(text ?? "").trim().replace(/^["'](.*)["']$/, "$1");
  if (!raw) return null;
  let p = raw.replace(/\\/g, "/");
  if (p === "~") p = home();
  else if (p.startsWith("~/")) p = `${home()}/${p.slice(2)}`;
  else if (!/^([A-Za-z]:)?\//.test(p)) p = `${String(root ?? "").replace(/[\\/]+$/, "")}/${p}`;
  const drive = /^[A-Za-z]:/.exec(p)?.[0] ?? "";
  const parts = [];
  for (const seg of p.replace(drive, "").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `${drive}/${parts.join("/")}` || "/";
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
// `{"reveal": false}` in the same file keeps the file manager closed after a download.
async function revealWanted() {
  const cfg = await readConfig();
  return cfg?.reveal !== false && cfg?.revealAfterDownload !== false;
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

// ── Updates ─────────────────────────────────────────────────────────────────
// One GitHub request, only when a repo is configured: no `updates.repo` (or
// `updates.feed`) means no request at all.
//
//   "updates":  { "repo": "me/files-open", "check": true, "intervalHours": 6 }
//
// A private repo reads its token from `updates.token`, or `tokenEnv` /
// `tokenFile` so the token itself never sits in the config.
const STATE_FILE = `${appHome()}/mods/files-open/state.json`;

async function readState() {
  try { return JSON.parse((await readTextFile(STATE_FILE)) ?? "{}") ?? {}; } catch { return {}; }
}
async function writeState(patch) {
  try {
    const before = (await readTextFile(STATE_FILE)) ?? null;
    const state = before ? (JSON.parse(before) ?? {}) : {};
    await writeTextFile(STATE_FILE, JSON.stringify({ ...state, ...patch }, null, 2) + "\n", before);
  } catch {}
}

async function tokenOf(cfg) {
  if (typeof cfg?.token === "string" && cfg.token.trim()) return cfg.token.trim();
  if (typeof cfg?.tokenEnv === "string" && cfg.tokenEnv.trim()) return String((await env(cfg.tokenEnv.trim())) ?? "").trim() || null;
  if (typeof cfg?.tokenFile === "string" && cfg.tokenFile.trim()) {
    try { return ((await readTextFile(cfg.tokenFile.trim())) ?? "").split(/\r?\n/)[0].trim() || null; } catch { return null; }
  }
  return null;
}
async function env(name) {
  try {
    if (window()?.platform === "windows") {
      const r = await exec("powershell", ["-NoProfile", "-Command", `[Environment]::GetEnvironmentVariable('${name}')`]);
      return (r.stdout || "").trim();
    }
    const r = await exec("sh", ["-c", `printf %s "$${name}"`]);
    return (r.stdout || "").trim();
  } catch { return ""; }
}

// One request, through curl: it is on Windows 10+ and on every unix, and a body
// written to a file never meets a shell that could mangle its quotes or newlines.
// The status line comes back through --write-out so an HTTP 422 is not a silent 0.
async function httpJson(method, url, { token, body } = {}) {
  const args = ["-sS", "--max-time", "25", "-X", method, url,
    "-H", "Accept: application/vnd.github+json", "-H", "User-Agent: herdr-files-open",
    "-w", "\n%{http_code}"];
  if (token) args.push("-H", `Authorization: Bearer ${token}`);
  let tmp = null;
  if (body !== undefined) {
    tmp = `${appHome()}/mods/files-open/.request.json`;
    try { await writeTextFile(tmp, JSON.stringify(body), null); } catch { tmp = null; }
    if (tmp) args.push("-H", "Content-Type: application/json", "--data-binary", `@${tmp}`);
  }
  let out;
  try { out = await exec("curl", args); }
  catch (e) { return { ok: false, status: 0, error: `curl 起不来：${e}` }; }
  const text = String(out?.stdout ?? "");
  const at = text.lastIndexOf("\n");
  const status = Number((at >= 0 ? text.slice(at + 1) : text).trim()) || 0;
  const payload = at >= 0 ? text.slice(0, at) : "";
  if (out?.code !== 0) return { ok: false, status, error: (out?.stderr || "").trim() || "网络请求失败" };
  let json = null;
  try { json = payload.trim() ? JSON.parse(payload) : null; } catch {}
  // A file:// feed answers with no HTTP status at all; a parsed body is the answer.
  const ok = (status >= 200 && status < 300) || (status === 0 && json !== null);
  return { ok, status, json, text: payload };
}

// The version the panel reports: mod.json when it carries one, else config "version".
async function localVersion() {
  try {
    const m = JSON.parse((await readTextFile(`${appHome()}/mods/files-open/mod.json`)) ?? "{}");
    if (m?.version) return String(m.version);
  } catch {}
  return String((await readConfig())?.version ?? "");
}

// 1.2.10 > 1.2.9: a plain string compare would put them the other way round.
function versionNewer(a, b) {
  const parse = (v) => String(v ?? "").replace(/^v/i, "").split(/[.\-+]/).map((n) => Number.parseInt(n, 10) || 0);
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}


async function makeDir(dir) {
  if (platform() === "windows") {
    const q = String(winpath(dir)).replace(/'/g, "''");
    await exec("powershell", ["-NoProfile", "-Command", `New-Item -ItemType Directory -Force -Path '${q}' | Out-Null`]);
  } else await exec("mkdir", ["-p", dir]);
}

// A size for the progress line: 812 KB, 22.4 MB, 1.3 GB.
const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} GB`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB`;
  if (v >= 1e3) return `${Math.round(v / 1e3)} KB`;
  return `${Math.round(v)} B`;
};

// How many bytes sit under `path` right now — the running destination of a copy, or
// its source to know what 100% is. One process per answer, so the bar samples it at
// a slow beat rather than every frame. Negative means "cannot tell": no bar, just a
// moving highlight.
async function bytesUnder(path, on = null) {
  try {
    if (on) {
      const r = await exec("ssh", [on, `du -sk '${String(path).replace(/'/g, "'\\''")}' 2>/dev/null || echo 0`]);
      const kb = parseInt((r.stdout || "").trim(), 10);
      return Number.isFinite(kb) ? kb * 1024 : -1;
    }
    if (platform() === "windows") {
      const q = String(winpath(path)).replace(/'/g, "''");
      const ps = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $p='" + q + "'; "
        + "if (-not (Test-Path -LiteralPath $p)) { 0 } "
        + "elseif (Test-Path -LiteralPath $p -PathType Container) { $s=[long]0; "
        + "foreach ($f in [IO.DirectoryInfo]::new($p).EnumerateFiles('*', [IO.SearchOption]::AllDirectories)) { $s += $f.Length }; $s } "
        + "else { (Get-Item -LiteralPath $p).Length }";
      const r = await exec("powershell", ["-NoProfile", "-Command", ps]);
      const n = parseInt((r.stdout || "").trim(), 10);
      return Number.isFinite(n) ? n : -1;
    }
    const r = await exec("du", ["-sk", path]);
    const kb = parseInt((r.stdout || "").trim().split(/\s+/)[0], 10);
    return Number.isFinite(kb) ? kb * 1024 : -1;
  } catch { return -1; }
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
// `dest` is where it should land, when the caller already picked the free name so a
// progress bar can watch that path while the copy runs. Powershell rather than
// `cmd /c copy`: a destination with a space or a bracket in it makes cmd re-read its
// own quotes and copy nothing.
async function copyInto(src, dir, dest) {
  const to = dest ?? await freeName(dir, base(src));
  if (platform() === "windows") {
    const q = (s) => String(s).replace(/'/g, "''");
    const ps = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); & { param($s, $t) "
      + "$p = Split-Path -Parent $t; "
      + "if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null } "
      + "Copy-Item -LiteralPath $s -Destination $t -Force -Recurse; $t } '"
      + q(winpath(src)) + "' '" + q(winpath(to)) + "'";
    const r = await exec("powershell", ["-NoProfile", "-Command", ps]);
    return (r.stdout || "").trim() || winpath(to);
  }
  const script = 'd=${2%/*}; [ -d "$d" ] || mkdir -p "$d"; cp -Rp "$1" "$2"; printf %s "$2"';
  const r = await exec("sh", ["-c", script, "cp", src, to]);
  return (r.stdout || "").trim() || to;
}

// scp a remote file or folder down to `dir`, never overwriting; returns the local path.
async function pullInto(machine, remote, dir, dest) {
  const to = dest ?? await freeName(dir, base(remote));
  await makeDir(dir);
  await exec("scp", ["-q", "-B", "-r", `${machine}:${remote}`, to]);
  return to;
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

// Ordering. Folders always come first, then the field a column header picked, then
// the name as a tie-break — so a size sort still reads alphabetically inside a
// run of equal sizes. Lists are re-sorted from the stored entries rather than from a
// second listing, which is what keeps the order across a refresh or a jump.
const SORT_FIELDS = ["name", "date", "type", "size"];

// Natural order: `file2` before `file10`, and case never decides the winner.
function nlCompare(a, b) {
  const ax = String(a).toLowerCase(), bx = String(b).toLowerCase();
  const an = ax.match(/\d+|\D+/g) ?? [], bn = bx.match(/\d+|\D+/g) ?? [];
  const n = Math.min(an.length, bn.length);
  for (let i = 0; i < n; i++) {
    const x = an[i], y = bn[i];
    if (x === y) continue;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const d = Number(x) - Number(y);
      if (d) return d < 0 ? -1 : 1;
      continue;
    }
    return x < y ? -1 : 1;
  }
  if (an.length !== bn.length) return an.length - bn.length;
  return ax === bx ? 0 : ax < bx ? -1 : 1;
}

// Type is the extension: a folder sorts as its own kind, before every extension.
const typeOf = (e) => (e.dir ? "" : extOf(e.name));

function compareBy(key, a, b) {
  if (key === "date") return (a.ms ?? 0) - (b.ms ?? 0);
  if (key === "size") return (a.dir ? -1 : a.size ?? 0) - (b.dir ? -1 : b.size ?? 0);
  if (key === "type") return nlCompare(typeOf(a), typeOf(b));
  return nlCompare(a.name, b.name);
}

// The three right-hand columns: fixed widths, so a header cell and the value under it
// line up at every depth of the tree. `Name` is not among them — it is the row — but it
// can still be sorted by, and the rest can be hidden or moved, from the columns menu.
const COL_W = { date: 74, type: 46, size: 54 };
const COL_DEFS = ["date", "type", "size"];
const COL_LABEL = { name: "Name", date: "Modified", type: "Type", size: "Size" };
const colText = (e, k) =>
  k === "date" ? fmtWhen(e.ms)
    : k === "type" ? (e.dir ? "folder" : (extOf(e.name) || "—"))
      : e.dir ? "" : fmtBytes(e.size);

// Time for something from this year, date for anything older — narrow enough to sit
// in a panel that is often half a screen wide.
function fmtWhen(ms) {
  if (!ms) return "";
  const d = new Date(ms), now = new Date(), p = (n) => String(n).padStart(2, "0");
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}-${md}`;
  return `${md} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// The folder one level up, spelled the way this path already is. Null at a root, so
// the ↑ button knows there is nowhere left to go.
function parentOf(p) {
  const s = String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!s) return null;
  const cut = s.replace(/\/[^/]*$/, "");
  if (cut === s) return null;
  if (/^[A-Za-z]:$/.test(cut)) return `${cut}/`;
  return cut || "/";
}

// Why a folder could not be listed, in words that say what to do about it. The sh
// script exits 2/3/4 and PowerShell exits the same way, so the kind is usually known
// before the message is read.
function folderError(kind, msg) {
  const e = new Error(msg);
  e.kind = kind;
  return e;
}
function errText(e, target) {
  const raw = String(e?.stderr || e?.message || e || "").trim();
  const kind = e?.kind
    ?? (/denied|permission|拒绝访问|没有访问|EACCES|EPERM/i.test(raw) ? "denied"
      : /not a directory|ENOTDIR/i.test(raw) ? "notdir"
      : /cannot find|does not exist|not found|找不到|不存在|ENOENT/i.test(raw) ? "missing"
      : "other");
  if (kind === "denied") return `Permission denied: ${target}`;
  if (kind === "missing") return `Not found: ${target}`;
  if (kind === "notdir") return `Not a folder: ${target}`;
  const why = raw.split("\n")[0].slice(0, 120);
  return why ? `Cannot open ${target} · ${why}` : `Cannot open ${target}`;
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    // A file path would otherwise list itself as one entry, so it is reported as
    // "not a folder" (4) and the caller can preview it instead of navigating into it.
    const ps = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) "
      + "if (-not (Test-Path -LiteralPath $p -PathType Container)) { if (Test-Path -LiteralPath $p) { exit 4 } else { exit 2 } } "
      + "@(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 "
      + "| ForEach-Object { @{ name=$_.Name; size=[long]$_.Length; "
      + "ms=[long]($_.LastWriteTimeUtc - [datetime]::new(1970,1,1,0,0,0,[System.DateTimeKind]::Utc)).TotalMilliseconds; "
      + "dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType "
      + "-or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) "
      + "| ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'";
    const r = await exec("powershell", ["-NoProfile", "-Command", ps], { on });
    if (r.code === 2) throw folderError("missing", "Not found");
    if (r.code === 4) throw folderError("notdir", "Not a folder");
    if (r.code !== 0) throw folderError(null, r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  // 2 = missing, 3 = unreadable, 4 = a file. `stat` has two dialects: GNU (Linux, and
  // a remote machine) takes -c, the BSD one on macOS takes -f; probed once per listing
  // rather than once per entry.
  const script = 'd=$1; [ -e "$d" ] || [ -L "$d" ] || exit 2; [ -d "$d" ] || exit 4; '
    + '{ [ -r "$d" ] && [ -x "$d" ]; } || exit 3; '
    + 'if stat -c %Y / >/dev/null 2>&1; then G=1; else G=0; fi; n=0; '
    + 'for p in "$d"/* "$d"/.[!.]* "$d"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; '
    + '[ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; '
    + 'if [ $G -eq 1 ]; then set -- $(stat -c \'%Y %s\' "$p" 2>/dev/null); else set -- $(stat -f \'%m %z\' "$p" 2>/dev/null); fi; '
    + 'mt=${1:-0}; if [ "$kind" = d ]; then sz=0; else sz=${2:-0}; fi; '
    + 'printf "%s\\0%s\\0%s\\0%s\\0" "$kind" "$name" "$mt" "$sz"; '
    + 'n=$((n+1)); [ "$n" -gt 500 ] && break; done';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code === 2) throw folderError("missing", "Not found");
  if (r.code === 3) throw folderError("denied", "Permission denied");
  if (r.code === 4) throw folderError("notdir", "Not a folder");
  if (r.code !== 0) throw folderError(null, r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    out.push({ name: fields[i + 1], dir: fields[i] === "d", ms: Number(fields[i + 2]) * 1000 || 0, size: Number(fields[i + 3]) || 0 });
  }
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    // The same mod draws its context and column menus as popups; those copies hold
    // no file tree of their own.
    if (props()?.fileMenu || props()?.colMenu) return;
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    // A newer version, once found, stays found: the banner sits until it is dealt with.
    this.update = null;
    this.checkUpdate(cx);
    // When this view appeared: a menu's note is left in shared state, and a view that
    // starts later must not act on one an earlier view was asked to do.
    this.bornAt = Date.now();
    // Sort lives on the view, not on the listing: a refresh, a jump or a walk up the
    // tree re-lists entries but keeps the order the person chose. A layout may pick a
    // starting order with `"props": {"sort": "date", "sortDesc": true}`.
    this.sortKey = SORT_FIELDS.includes(props()?.sort) ? props().sort : "name";
    this.sortDesc = typeof props()?.sortDesc === "boolean" ? props()?.sortDesc : false;
    // Which of the three value columns are on screen, and in what order. Name is the
    // row itself, so it is always first; the rest come from config.json.
    this.colOrder = COL_DEFS.slice();
    this.colHidden = new Set();
    this.loadCols(cx);
    // Dragging a column header: the one in hand, and the one under the pointer that
    // it would land on. Both clear on release; the timestamp swallows the click that
    // the same release would otherwise read as "sort by this column".
    this.dragCol = null;
    this.overCol = null;
    this.droppedAt = 0;
    // The header path doubles as an address bar: click it, type, Enter.
    this.editing = false;
    this.input = InputState.new({ placeholder: "path — Enter to go, empty Enter to cancel" });
    this.input.on("submit", (_e, cx) => this.jumpTo(this.input.value(), cx));
    this.input.on("blur", (_e, cx) => { if (this.editing) { this.editing = false; cx.notify(); } });
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

  // Folders first, then the chosen field, then the name — the one order every path
  // through this view uses, so a fresh listing and a re-sort agree.
  sorted(list) {
    const key = SORT_FIELDS.includes(this.sortKey) ? this.sortKey : "name";
    const sign = this.sortDesc ? -1 : 1;
    return list.slice().sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      const c = compareBy(key, a, b);
      return c ? c * sign : nlCompare(a.name, b.name);
    });
  }

  // Re-order what is already in hand: no second listing for a header click.
  resortAll() {
    for (const [p, list] of this.entries) this.entries.set(p, this.sorted(list));
  }

  // The column header is the whole control: sort by it, or reverse what it already did.
  setSort(key, cx) {
    if (this.sortKey === key) this.sortDesc = !this.sortDesc;
    else { this.sortKey = key; this.sortDesc = false; }
    this.resortAll();
    cx.notify();
  }

  // Which value columns show, and in what order — `{"columns": ["size","date"],
  // "hiddenColumns": ["type"]}` in config.json, so it survives a restart.
  async loadCols(cx) {
    const cfg = await readConfig();
    const order = (Array.isArray(cfg?.columns) ? cfg.columns : []).filter(k => COL_DEFS.includes(k));
    for (const k of COL_DEFS) if (!order.includes(k)) order.push(k);
    const hidden = (Array.isArray(cfg?.hiddenColumns) ? cfg.hiddenColumns : []).filter(k => COL_DEFS.includes(k));
    this.colOrder = order;
    this.colHidden = new Set(hidden);
    cx.notify();
  }

  async saveCols() {
    try {
      const before = (await readTextFile(CONFIG_FILE)) ?? null;
      const cfg = before ? (JSON.parse(before) ?? {}) : {};
      cfg.columns = this.colOrder;
      cfg.hiddenColumns = [...this.colHidden];
      await writeTextFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", before);
    } catch {}
  }

  visibleCols() {
    return this.colOrder.filter(k => !this.colHidden.has(k));
  }

  toggleCol(key, cx) {
    if (this.colHidden.has(key)) this.colHidden.delete(key);
    else this.colHidden.add(key);
    this.saveCols();
    cx.notify();
  }

  // Move one column past its visible neighbour. The hidden ones keep their relative
  // order at the tail, so showing one later puts it back among the columns, not after.
  moveCol(key, dir, cx) {
    const vis = this.visibleCols(), i = vis.indexOf(key), j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= vis.length) return;
    const swap = vis[i];
    vis[i] = vis[j]; vis[j] = swap;
    this.colOrder = [...vis, ...this.colOrder.filter(k => this.colHidden.has(k))];
    this.saveCols();
    cx.notify();
  }

  // Dragged onto another header: the column lands where that one was, on the side it
  // came from, and the hidden ones stay behind in the tail of the order.
  dropCol(to, cx) {
    const from = this.dragCol;
    this.dragCol = null; this.overCol = null;
    const vis = this.visibleCols(), a = vis.indexOf(from), b = vis.indexOf(to);
    if (a < 0 || b < 0 || a === b) { cx.notify(); return; }
    const list = vis.filter(k => k !== from);
    list.splice(list.indexOf(to) + (a < b ? 1 : 0), 0, from);
    this.colOrder = [...list, ...this.colOrder.filter(k => this.colHidden.has(k))];
    this.droppedAt = Date.now();
    this.saveCols();
    cx.notify();
  }

  colMenu(cx) {
    openOverlay({
      mod: "files-open", kind: "popup", at: "pointer", width: 214,
      props: { colMenu: { cols: this.visibleCols(), hidden: [...this.colHidden], key: this.sortKey } },
    });
    cx.notify();
  }

  // One menu for both jobs: ✓ shows or hides a column, ← → moves it. Name is the row
  // itself, so it stays: no ✓ and no arrows on its line.
  renderColMenu(t) {
    const m = props()?.colMenu;
    if (!m) return div();
    const vis = m.cols ?? [];
    const row = (k) => {
      const fixed = k === "name", shown = fixed || vis.includes(k), at = vis.indexOf(k);
      const arrow = (glyph, dir, off) => div().w(15).flex_none().text_center().text_size(12)
        .text_color(off ? t.border : t.muted)
        .when(!off, el => el.cursor_pointer().hover(s => s.text_color(t.foreground))
          .on_click((_e, _cx) => { this.ask({ what: "colmove", key: k, dir }); closeOverlay(props().overlay); }))
        .child(glyph);
      return h_flex().id(`fc-${k}`).h(28).px(6).rounded(7).gap(1).items_center().cursor_pointer()
        .when(k === m.key, el => el.bg(t.selected))
        .hover(el => el.bg(k === m.key ? t.selected : t.hover))
        .child(div().w(16).flex_none().text_center().text_size(11).text_color(shown ? t.ansi2 : t.border)
          .when(!fixed, el => el.on_click((_e, _cx) => { this.ask({ what: "coltoggle", key: k }); closeOverlay(props().overlay); }))
          .child(shown ? "✓" : "·"))
        .child(div().flex_1().min_w(0).truncate().text_color(shown ? t.foreground : t.dim).child(COL_LABEL[k]))
        .when(!fixed, el => el.child(arrow("←", -1, at <= 0)).child(arrow("→", 1, at < 0 || at === vis.length - 1)));
    };
    return v_flex().id("files-col-menu").w_full().p(4).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .child(div().px(7).pt(3).pb(5).text_size(11).text_color(t.dim).child("Columns · ✓ shows · drag a header to move"))
      .children(["name", ...COL_DEFS].map(row));
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    // Sorted first, then cut: the entries kept are the first ones as displayed.
    this.entries.set(path, this.sorted(entries).slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }


  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.baseCwd = cwd;
      this.entries = new Map(); this.folders = new Set(saved?.folders);
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
      } catch (e) { if (this.current(context)) this.error = errText(e, this.root); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
    this.watch(this.root ?? cwd, cx);
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
        catch (e) { if (this.current(context)) { this.status = errText(e, `${this.root}/${path}`); this.failed = true; this.fade(cx); } }
        finally { this.pending.delete(path); cx.notify(); }
      });
    }
    cx.notify();
  }

  // The header path is also an address bar. A folder moves the tree there; a path to a
  // file moves to its folder and previews it, since that is what a pasted path means.
  beginJump(cx) {
    this.input.set_value(this.file ? `${this.root}/${this.file}` : this.root ?? "");
    // Starting from the current path and selected, so typing replaces it and Enter
    // without typing is a no-op.
    this.input.set_selected_range({ start: 0, end: this.input.value().length });
    this.editing = true;
    this.input.focus();
    cx.notify();
  }

  // `~` means the home of the machine the panel is looking at, so a remote panel asks
  // that machine once and remembers the answer instead of pasting this computer's home
  // onto a path the far side will never have. Asked through the same channel the
  // listings use, so `~` lands where a listing would (a container's home can differ
  // from the one `ssh` reports).
  async remoteHome(on) {
    if (!on) return home();
    if (!this.homes) this.homes = new Map();
    if (this.homes.has(on)) return this.homes.get(on);
    try {
      const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on });
      const h = (r.stdout || "").trim();
      if (h) this.homes.set(on, h);
      return h || null;
    } catch { return null; }
  }

  jumpTo(text, cx, opts = {}) {
    this.editing = false;
    const context = this.context, on = this.on;
    const land = (root, file, entries) => {
      this.context = { ...context, cwd: root };
      this.root = root;
      this.folders = new Set(); this.pending = new Set(); this.marks = {};
      this.selected = opts.expand ?? null; this.selectedDir = opts.expand ? true : null;
      this.entries = new Map([["", this.sorted(entries).slice(0, PER_FOLDER)]]);
      this.watched = null; this.error = null; this.status = null; this.failed = false;
      this.limited = entries.length > PER_FOLDER;
      this.show(file ?? null, cx);
      this.watch(root, cx);
      // Walking up from a folder re-opens the one just left, so the move is visible.
      if (opts.expand) this.toggle(opts.expand, cx);
    };
    this.status = null; this.failed = false;
    cx.spawn(async cx => {
      let raw = String(text ?? "");
      if (/^\s*~(?=$|[\\/])/.test(raw)) {
        const h = await this.remoteHome(on);
        if (!this.current(context)) return;
        if (!h) { this.status = "Cannot resolve ~ on this machine"; this.failed = true; this.fade(cx); cx.notify(); return; }
        raw = raw.replace(/^\s*~/, h);
      }
      const target = resolvePath(raw, this.root);
      if (!target) { cx.notify(); return; }
      if (target === this.root) { this.status = null; this.failed = false; cx.notify(); return; }
      try {
        const entries = await directory(target, on);
        if (!this.current(context)) return;
        land(target, null, entries);
      } catch (e) {
        // A path to a file is a reasonable thing to paste: land on its folder and
        // preview it. A folder that refused to list stays the error it was.
        const cut = target.replace(/[\\/][^\\/]*$/, ""), name = target.split("/").pop();
        let entries = null;
        if (cut && cut !== target) { try { entries = await directory(cut, on); } catch {} }
        if (!this.current(context)) return;
        const hit = entries?.find(x => x.name === name);
        if (hit && !hit.dir) land(cut, name, entries);
        else { this.status = errText(e, target); this.failed = true; this.fade(cx); }
      } finally { cx.notify(); }
    });
  }

  // Walk into a folder: it becomes the root of the tree, and ↑ leads back out. A
  // relative path, so it is read against the folder on screen like any typed name.
  enter(path, cx) {
    this.jumpTo(path, cx);
  }

  // One level up, with the folder just left re-opened and selected. At a drive root
  // or `/` there is nowhere to go, and it says so rather than doing nothing.
  goUp(cx) {
    const up = parentOf(this.root);
    if (!up) { this.status = `Already at the top: ${this.root}`; this.failed = true; cx.notify(); this.fade(cx); return; }
    this.jumpTo(up, cx, { expand: base(this.root) });
  }

  // `name` while the tree sits on the pane's own folder, `…/name` once it has been
  // moved somewhere else — enough to tell a jump happened without reading the path.
  rootLabel() {
    const root = this.root ?? "", name = base(root) || root || "/";
    return this.baseCwd && root && root !== this.baseCwd ? `…/${name}` : name;
  }

  pathLine(t, cx) {
    if (this.editing) {
      return Input.new(this.input).flex_1().min_w(0).h(24).px(6).rounded(6).border_1()
        .border_color(t.accent).bg(t.background).text_size(12).text_color(t.foreground);
    }
    const label = this.copied
      ? `✓ ${this.copied.split(/[\\/]/).pop() || this.copied}`
      : this.file ?? this.rootLabel();
    // Drawn as a field, not as a label: the border is the hint that this is where a
    // path can be typed. Right-click copies it instead.
    return h_flex().id("files-path").flex_1().min_w(0).h(24).px(7).items_center().justify_end().rounded(6)
      .border_1().border_color(t.border).bg(t.background).cursor_pointer()
      .hover(s => s.border_color(t.accent).text_color(t.foreground))
      .on_click((_e, cx) => this.beginJump(cx))
      .on_mouse_down("right", (_e, cx) => this.copyPath(this.file ?? "", cx))
      .child(div().min_w(0).truncate().text_size(12).text_color(this.copied ? t.ansi2 : t.dim).child(label));
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
  // The bar under the header follows the destination's size, sampled on a slow beat
  // (one `du` or PowerShell per sample, not per frame) and stopped with the copy.
  download(path, cx, choose = false) {
    const context = this.context, name = base(path), on = this.on;
    cx.spawn(async cx => {
      const dir = choose ? await pickFolder({ prompt: `Download ${name} to…` }) : await saveDir();
      if (!dir) return;
      const full = `${this.root}/${path}`;
      // Copying a folder into itself would recurse forever; say so instead.
      if (!on) {
        const norm = (s) => String(s).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        const src = norm(winpath(full)), dst = norm(winpath(dir));
        if (dst === src || dst.startsWith(src + "/")) {
          this.status = `Pick a folder outside ${name}`; cx.notify(); this.fade(cx); return;
        }
      }
      this.status = null; this.hint = null; this.failed = false;
      let job = this.job = { label: `Preparing ${name}…`, unit: "bytes", done: 0, total: 0 };
      cx.notify();
      try {
        // One free name, chosen here so the sampler knows exactly what to watch.
        const saved = await freeName(dir, name);
        const size = await bytesUnder(full, on);
        job = this.job = { label: `Downloading ${name}`, unit: "bytes", done: 0, total: size > 0 ? size : 0 };
        const stop = this.sampleBytes(saved, job, cx);
        try { await (on ? pullInto(on, full, dir, saved) : copyInto(full, dir, saved)); }
        finally { stop(); }
        if (choose) await rememberSaveDir(dir);
        if (this.current(context)) this.status = `Saved to ${saved}`;
        notify({ title: "Downloaded", body: saved, level: "success", timeout: 2400 });
        // Show where it landed — Explorer/Finder with the file selected. Not awaited:
        // the file is saved either way, and the bar shouldn't wait on a window.
        if (await revealWanted()) showInFileManager(saved);
      } catch (e) {
        if (this.current(context)) this.status = `Download failed: ${String(e).split("\n")[0].slice(0, 160)}`;
      } finally {
        // A second download started meanwhile owns the bar now; leave it alone.
        if (this.job === job) this.job = null;
        cx.notify(); this.fade(cx);
      }
    });
  }

  // Watch a copy in flight: every beat, ask how big the destination has grown and move
  // the bar. Returns the stop function; a stale job (or a failed sample) is ignored.
  sampleBytes(dest, job, cx) {
    const tick = async () => {
      if (this.job !== job) return;
      const n = await bytesUnder(dest);
      if (this.job === job && n >= 0) { job.done = n; cx.notify(); }
    };
    const task = cx.timer.every(700, () => { tick(); });
    return () => task.cancel();
  }

  // The bar itself: a filled groove once the size is known, a sliding highlight while
  // it is not. Both animations run natively, so a render is only spent when a sample
  // actually moves the number.
  jobRow(t) {
    const job = this.job, total = job.total > 0 ? job.total : 0;
    const done = total ? Math.min(job.done, total) : job.done;
    const pct = total ? Math.min(100, (done / total) * 100) : null;
    const detail = total ? (job.unit === "items" ? `${done} of ${total}` : `${fmtBytes(done)} of ${fmtBytes(total)}`) : "";
    const fill = pct === null
      ? div().absolute().top(0).left(0).h_full().w(96).rounded_full().bg(t.ansi2)
          .loop("left", { from: -96, to: 336, period: 1400, easing: "ease-in-out" })
      : div().h_full().rounded_full().bg(t.ansi2).w(`${pct.toFixed(1)}%`).transition("width", { duration: 240, easing: "ease-out" });
    return v_flex().flex_none().px(12).py(6).gap(5).border_b(1).border_color(t.border)
      .child(div().text_size(11).text_color(t.dim).truncate().child(detail ? `${job.label} · ${detail}` : job.label))
      .child(div().h(3).w_full().rounded_full().relative().overflow_hidden().bg(t.border).child(fill));
  }

  // Files from outside (a drop, or the system picker) land in the folder on screen.
  upload(paths, cx, into = "") {
    if (!paths?.length) return;
    const context = this.context, root = this.root, on = this.on;
    const remoteDir = `${(root ?? "").replace(/\/+$/, "")}${into ? "/" + into : ""}`;
    const localDir = into ? `${root}/${into}` : root;
    const where = into || base(root) || root;
    const total = paths.length;
    // Item by item is free to count, so uploads get a bar without sampling anything.
    this.job = { label: `Uploading to ${where}`, unit: "items", done: 0, total };
    this.failed = false;
    cx.notify();
    cx.spawn(async cx => {
      const done = [];
      try {
        for (const p of paths) {
          if (on) await pushUp(on, p, remoteDir);
          else await copyInto(p, localDir);
          done.push(base(p));
          if (this.job) this.job.done = done.length;
          if (this.current(context)) cx.notify();
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
        this.hint = null; this.job = null;
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
      .child(item("download", m.dir ? "Download folder" : "Download", "download"))
      .child(item("downloadto", m.dir ? "Download folder to…" : "Download to…", "downloadto"))
      .when(m.dir, el => el.child(item("upload", "Upload files here…", "upload")))
      .child(item("copy", "Copy path", "copy"));
  }

  // A popup cannot finish an scp or a picker after it closes, and it draws in a
  // different view, so it leaves a note for this one instead.
  ask(intent) { setShared("files-open.intent", { ...intent, at: Date.now() }); }

  takeIntent(cx) {
    const it = shared("files-open.intent");
    if (!it?.at || it.at === this.intentAt || !this.root) return;
    if (it.at < (this.bornAt ?? 0)) { this.intentAt = it.at; return; }
    this.intentAt = it.at;
    const path = it.path ?? "";
    if (it.what === "preview") this.show(path, cx);
    else if (it.what === "open") this.handOff(path, cx);
    else if (it.what === "openwith") this.handOff(path, cx, true);
    else if (it.what === "download") this.download(path, cx);
    else if (it.what === "downloadto") this.download(path, cx, true);
    else if (it.what === "upload") this.startUpload(cx, path);
    else if (it.what === "copy") this.copyPath(path, cx);
    else if (it.what === "coltoggle" && COL_DEFS.includes(it.key)) this.toggleCol(it.key, cx);
    else if (it.what === "colmove" && COL_DEFS.includes(it.key)) this.moveCol(it.key, it.dir, cx);
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

  // A table header: the columns the rows are made of, and the place a click sorts by —
  // clicking the column already sorted reverses it. The ⋮ sits first, before the name,
  // because the name is the one cell that flexes: put it last and every column would
  // shift left by its width and stop lining up with the values under it. A value column
  // can be dragged onto another and lands on the side it came from; the name stays put,
  // since it is the row itself.
  headerRow(t) {
    const active = (k) => this.sortKey === k;
    const col = (k, label, w, right = false) => {
      const dragged = this.dragCol === k, target = Boolean(this.dragCol) && this.overCol === k && !dragged;
      const cell = h_flex().id(`files-col-${k}`).relative().h_full().flex_none().items_center().gap(3).truncate().cursor_pointer()
        .text_size(10.5).text_color(active(k) ? t.accent : t.dim)
        .hover(s => s.text_color(t.foreground))
        .on_click((_e, cx) => { if (Date.now() - this.droppedAt > 250) this.setSort(k, cx); })
        .on_mouse_down("right", (_e, cx) => this.colMenu(cx))
        .when(dragged, el => el.opacity(0.45))
        .when(target, el => el.bg(t.hover))
        .when(right, el => el.justify_end())
        .child(div().truncate().child(label))
        .when(active(k), el => el.child(div().text_size(8).child(this.sortDesc ? "▼" : "▲")));
      if (!w) return cell.flex_1().min_w(0);
      return cell.w(w)
        .tooltip("Click to sort · drag onto another column to move it")
        .when(dragged, el => el.cursor_grabbing())
        .when(!dragged, el => el.cursor_grab())
        .when(target, el => el.child(div().absolute().top(0).bottom(0).left(-4).w(2).rounded(1).bg(t.accent)))
        .on_mouse_down("left", (_e, cx) => { this.dragCol = k; this.overCol = k; cx.notify(); })
        .on_mouse_move((_e, cx) => { if (this.dragCol && this.overCol !== k) { this.overCol = k; cx.notify(); } })
        .on_mouse_up("left", (_e, cx) => { if (this.dragCol) { cx.stop_propagation(); this.dropCol(this.overCol, cx); } });
    };
    return h_flex().id("files-head").flex_none().h(21).px(14).gap(7).items_center().border_b(1).border_color(t.border)
      .child(div().id("files-cols").flex_none().w(14).text_center().cursor_pointer().text_size(12).text_color(t.muted)
        .hover(s => s.text_color(t.foreground)).on_click((_e, cx) => this.colMenu(cx)).child("⋮"))
      .child(col("name", COL_LABEL.name))
      .children(this.visibleCols().map(k => col(k, COL_LABEL[k], COL_W[k], k === "size")));
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    const cell = (w, text, right = false) => h_flex().flex_none().h_full().items_center().w(w).when(right, el => el.justify_end())
      .child(div().truncate().text_size(10.5).text_color(t.dim).child(text));
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
          // A single click on a folder opens it in place; a double click walks into
          // it — the same gesture as a file manager, and ↑ leads back out.
          if (entry.dir) { if (e.click_count >= 2) this.enter(path, cx); else this.toggle(path, cx); return; }
          if (e.click_count >= 2) this.handOff(path, cx);
          else if (!external) this.show(path, cx);
          else cx.notify();
        })
        .on_mouse_down("right", (_e, cx) => this.menuFor(path, entry.dir, cx))
        .child(entry.dir ? svg(`mods/files-open/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(image(iconSvg(entry.dir ? (open ? "folder-open" : "folder") : iconOf(entry.name))).w(15).h(15).flex_none())
        .child(div().flex_1().min_w(0).truncate().when(copied, el => el.text_color(t.ansi2).child("✓ ")).child(entry.name))
        // Badges sit before the value columns: anything after them would push those
        // columns left and break the alignment with the header.
        .when(external, el => el.child(div().text_size(10).text_color(t.dim).child("↗")))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)))
        .children(this.visibleCols().map(k => cell(COL_W[k], colText(entry, k), k === "size"))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  // ── Update banner ────────────────────────────────────────────────────────
  // Asks GitHub once per `intervalHours`; what it learned is kept in state.json so a
  // restart inside the window neither asks again nor forgets the banner it earned.
  // No `updates.repo` (or `updates.feed`) means it never runs at all.
  async checkUpdate(cx) {
    const cfg = await readConfig();
    const up = cfg?.updates ?? {};
    if (up.check === false) return;
    const repo = String(up.repo ?? "").trim();
    const url = String(up.feed ?? "").trim()
      || (repo ? `https://api.github.com/repos/${repo}/releases/latest` : "");
    if (!url) return;
    const state = await readState();
    const every = Math.max(1, Number(up.intervalHours) || 6) * 3600000;
    let latest = state.latest ?? null;
    if (!latest || !state.checkedAt || Date.now() - Number(state.checkedAt) > every) {
      const r = await httpJson("GET", url, { token: await tokenOf(cfg?.updates) });
      if (r.ok && r.json) {
        const next = {
          version: String(r.json.version ?? r.json.tag_name ?? "").replace(/^v/i, "").trim(),
          notes: String(r.json.notes ?? r.json.body ?? "").slice(0, 600),
          url: String(r.json.url ?? r.json.html_url ?? ""),
        };
        if (next.version) {
          latest = next;
          await writeState({ latest: next, checkedAt: Date.now() });
        }
      }
    }
    if (!latest?.version) return;
    const local = await localVersion();
    if (!local || !versionNewer(latest.version, local)) return;
    if (state.dismissedVersion === latest.version) return;
    if (Number(state.snoozeUntil) > Date.now()) return;
    this.update = { ...latest, local };
    cx.notify();
  }

  // Later: quiet for a day. ✕: this version is not news any more.
  async dismissUpdate(cx, snooze) {
    const v = this.update?.version;
    this.update = null;
    cx.notify();
    if (!v) return;
    if (snooze) await writeState({ snoozeUntil: Date.now() + 24 * 3600000 });
    else await writeState({ dismissedVersion: v, snoozeUntil: 0 });
  }

  renderUpdate(t, cx) {
    const u = this.update;
    if (!u) return div();
    const act = (id, text, run, accent = false) => div().id(id).flex_none().cursor_pointer().text_size(11)
      .text_color(accent ? t.accent : t.muted).hover(s => s.text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); run(cx); }).child(text);
    return h_flex().id("files-update").flex_none().h(26).px(12).gap(9).items_center()
      .bg(t.selected).border_b(1).border_color(t.border).text_size(11)
      .child(div().flex_none().text_color(t.ansi2).child("↑"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground)
        .child(`v${u.version} 可用 · 当前 ${u.local}`))
      .when(Boolean(u.url), el => el.child(act("files-update-notes", "更新说明", () => launch(u.url), true)))
      .child(act("files-update-later", "稍后", (cx) => this.dismissUpdate(cx, true)))
      .child(act("files-update-close", "✕", (cx) => this.dismissUpdate(cx, false)));
  }

  render(cx) {
    const t = theme();
    if (props()?.fileMenu) return this.renderMenu(t);
    if (props()?.colMenu) return this.renderColMenu(t);
    if (key() !== this.context?.key) this.refresh(cx);
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_drop((event, cx) => this.upload(event.paths, cx, this.selectedDir ? this.selected ?? "" : ""))
      // A header drag released anywhere else in the card is dropped, not left holding
      // a column: the next hover would otherwise move it again.
      .on_mouse_up("left", (_e, cx) => { if (this.dragCol) { this.dragCol = null; this.overCol = null; cx.notify(); } })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .when(Boolean(this.file), el => el.child(image(iconSvg(iconOf(this.file))).w(15).h(15).flex_none()))
        // The cat is the panel's mark; the word still says what it is, and both fit in
        // the 42 px header at a panel that is often half a screen wide.
        .child(div().id("files-logo").flex_none().child(image("mods/files-open/logo.png").w(24).h(24)))
        .child(div().font_semibold().child("Files"))
        .when(Boolean(this.baseCwd) && this.root !== this.baseCwd, el => el.child(div().id("files-home").px(3).cursor_pointer()
          .text_color(t.muted).hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => this.jumpTo(this.baseCwd, cx)).child("↩")))
        .when(!this.file, el => el.child(div().id("files-up").px(3).cursor_pointer()
          .text_color(parentOf(this.root) ? t.muted : t.border).hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => this.goUp(cx)).child("↑")))
        .child(this.pathLine(t, cx))
        .when(!this.file, el => el.child(div().id("files-upload").px(4).cursor_pointer().text_size(11.5)
          .text_color(t.muted).hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => this.startUpload(cx)).child("Upload")))
        .when(Boolean(this.file), el => el.child(div().id("files-open-ext").px(6).cursor_pointer().text_color(t.muted).hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => this.handOff(this.file, cx)).child("↗"))))
      .when(Boolean(this.update), el => el.child(this.renderUpdate(t, cx)))
      .when(Boolean(this.status || this.hint), el => el.child(div().px(12).py(5).flex_none().border_b(1).border_color(t.border).text_size(11)
        .text_color(this.failed ? t.ansi1 : t.dim).truncate().child(this.status || this.hint)))
      .when(Boolean(this.job), el => el.child(this.jobRow(t)))
      .when(!this.file && Boolean(this.entries.get("")?.length), el => el.child(this.headerRow(t)))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().id("files-empty").p(8).text_size(12)
          .text_color(this.error ? t.ansi1 : t.dim)
          .child(this.error || (this.loading ? "Loading files…" : !this.root ? "No folder" : "This folder is empty"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(
        this.md != null
          ? div().id("files-md").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(10).text_size(13)
              .child(TextView.markdown(`files-md:${this.file}`, this.md).selectable(true).scrollable(true))
          : this.code ? Editor.new(this.code).flex_1().min_h(0)
          : div().p(12).text_color(t.dim).child(this.hint || this.fileError || "Loading file…")));
  }
}
