"""Generate the coloured file-tree icons used by the files-open mod.

Every icon is full colour (explicit hex fills/strokes, never currentColor) because
gpui-kit's `image()` keeps the source colours while `svg()` would tint them with
the theme. Run again after tweaking to rewrite ftypes/*.svg next to this script.
"""
import pathlib

OUT = pathlib.Path(__file__).resolve().parent / "ftypes"
OUT.mkdir(parents=True, exist_ok=True)


def svg(body: str) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
        'width="24" height="24">' + body + "</svg>\n"
    )


def chip(color: str, glyph: str) -> str:
    """A rounded square in the type's colour with a white glyph on top."""
    return svg(
        f'<rect x="2.6" y="2.6" width="18.8" height="18.8" rx="4.6" fill="{color}"/>'
        + glyph
    )


def page(color: str, fold: str, extra: str = "") -> str:
    """A document with a folded corner, then whatever marks the type needs."""
    return svg(
        f'<path d="M6.4 2.4h7.4L20 8.6v13a2 2 0 0 1-2 2H6.4a2 2 0 0 1-2-2v-17a2 2 0 0 1 2-2Z" fill="{color}"/>'
        f'<path d="M13.8 2.4 20 8.6h-4.5a1.7 1.7 0 0 1-1.7-1.7Z" fill="{fold}"/>'
        + extra
    )


WHITE = "#ffffff"
LINES = (
    '<g fill="#ffffff" fill-opacity="0.92">'
    '<rect x="7.6" y="11.4" width="8.8" height="1.5" rx="0.75"/>'
    '<rect x="7.6" y="14.7" width="8.8" height="1.5" rx="0.75"/>'
    '<rect x="7.6" y="18" width="5.6" height="1.5" rx="0.75"/></g>'
)
CHEVRONS = (
    '<path d="M9.5 8.6 6.1 12l3.4 3.4M14.5 8.6 17.9 12l-3.4 3.4" fill="none" '
    'stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
)
BRACES = (
    '<path d="M10.2 8.1c-1.35 0-2 .72-1.9 1.95.1 1.05-.35 1.7-1.4 2 -.95.38-1.5 1.06-1.4 1.95-.1.89.45 1.57 1.4 1.95 1.05.3 1.5.95 1.4 2 -.1 1.23.55 1.95 1.9 1.95M13.8 8.1c1.35 0 2 .72 1.9 1.95-.1 1.05.35 1.7 1.4 2 .95.38 1.5 1.06 1.4 1.95.1.89-.45 1.57-1.4 1.95-1.05.3-1.5.95-1.4 2 .1 1.23-.55 1.95-1.9 1.95" '
    'fill="none" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
)

# --- source code: one chip shape, colours that separate the common languages ---
CODE_GLYPH = CHEVRONS
for name, color in [
    ("js", "#E9C63A"), ("ts", "#3178C6"), ("py", "#3E9BD1"),
    ("code", "#6E7BFF"), ("shell", "#4CAF50"),
]:
    glyph = (
        '<path d="M7 9.2 9.9 12 7 14.8M13 15h4.2" fill="none" stroke="#ffffff" '
        'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
        if name == "shell" else CODE_GLYPH
    )
    (OUT / f"file-{name}.svg").write_text(chip(color, glyph), encoding="utf-8")

# --- config / data: braces ---
(OUT / "file-data.svg").write_text(chip("#A78BFA", BRACES), encoding="utf-8")

# --- markdown: an arrow in a chip ---
(OUT / "file-md.svg").write_text(
    chip("#5B8FB9",
         '<path d="M7.4 15.6V8.4l3.1 3.9 3.1-3.9v7.2" fill="none" stroke="#ffffff" stroke-width="1.8" '
         'stroke-linecap="round" stroke-linejoin="round"/>'
         '<path d="M16.4 8.4v7.2M13.9 13.3l2.5 2.5 2.5-2.5" fill="none" stroke="#ffffff" '
         'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>'),
    encoding="utf-8")

# --- web: a browser window with < > inside ---
(OUT / "file-web.svg").write_text(svg(
    '<rect x="2.2" y="3.6" width="19.6" height="16.8" rx="3.4" fill="#E8734A"/>'
    '<path d="M2.2 7a3.4 3.4 0 0 1 3.4-3.4h13.2A3.4 3.4 0 0 1 22.2 7v.5H2.2Z" fill="#FF9B74"/>'
    '<circle cx="5.2" cy="5.2" r="0.85" fill="#8C3719"/>'
    '<circle cx="7.8" cy="5.2" r="0.85" fill="#8C3719"/>'
    '<path d="M9.6 11.9 7.1 14.2l2.5 2.3M14.4 11.9 16.9 14.2l-2.5 2.3" fill="none" stroke="#ffffff" '
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'), encoding="utf-8")

# --- documents ---
(OUT / "file-text.svg").write_text(page("#93A1B1", "#6E7C8C", LINES), encoding="utf-8")
(OUT / "file-doc.svg").write_text(page("#2B7CD3", "#1B5FA8", LINES), encoding="utf-8")
(OUT / "file-pdf.svg").write_text(
    page("#E5534B", "#B93A34",
         '<path d="M9.4 11.6h3.2a1.9 1.9 0 0 1 0 3.8H9.4Zm0 3.8v2.8" fill="none" stroke="#ffffff" '
         'stroke-width="1.6" stroke-linecap="round"/>'
         '<path d="M15 11.6v6.6" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/>'),
    encoding="utf-8")

# --- spreadsheets: a grid ---
(OUT / "file-sheet.svg").write_text(svg(
    '<rect x="2.4" y="3.6" width="19.2" height="16.8" rx="3.6" fill="#21A366"/>'
    '<g stroke="#ffffff" stroke-width="1.5" stroke-opacity="0.9">'
    '<path d="M2.4 9h19.2M2.4 14.8h19.2M9.2 3.6v16.8M14.9 3.6v16.8"/></g>'), encoding="utf-8")

# --- slides ---
(OUT / "file-slides.svg").write_text(chip("#D24726", (
    '<rect x="5.8" y="6.4" width="12.4" height="8.6" rx="1.6" fill="#ffffff"/>'
    '<path d="M12 15v2.4M9.4 17.9h5.2" fill="none" stroke="#ffffff" stroke-width="1.6" '
    'stroke-linecap="round"/>')), encoding="utf-8")

# --- images ---
(OUT / "file-image.svg").write_text(svg(
    '<rect x="2.2" y="4" width="19.6" height="16" rx="3.2" fill="#C77DFF"/>'
    '<circle cx="8.2" cy="9.2" r="1.8" fill="#F6E8FF"/>'
    '<path d="M4.4 18.4 9.6 12.6l3.3 3.6 2.3-2.4 4.4 4.6Z" fill="#ffffff" fill-opacity="0.92"/>'),
    encoding="utf-8")

# --- audio ---
(OUT / "file-audio.svg").write_text(chip("#F06292", (
    '<path d="M14.6 6.4v8" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round"/>'
    '<path d="M9.6 7.9v7.2" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round"/>'
    '<path d="M9.6 7.9l5-1.4v2.4l-5 1.4Z" fill="#ffffff"/>'
    '<ellipse cx="8" cy="16.2" rx="2.5" ry="1.9" fill="#ffffff"/>'
    '<ellipse cx="13" cy="14.8" rx="2.5" ry="1.9" fill="#ffffff"/>')), encoding="utf-8")

# --- video ---
(OUT / "file-video.svg").write_text(svg(
    '<rect x="2.2" y="4.2" width="19.6" height="15.6" rx="3.4" fill="#0EA5E9"/>'
    '<path d="M10 8.8 15.8 12 10 15.2Z" fill="#ffffff"/>'), encoding="utf-8")

# --- archives ---
(OUT / "file-archive.svg").write_text(chip("#B98A4E", (
    '<rect x="10.2" y="2.6" width="3.6" height="6.4" fill="#F7E7CC" fill-opacity="0.95"/>'
    '<rect x="9.4" y="9.4" width="5.2" height="4.6" rx="1.2" fill="#F7E7CC" fill-opacity="0.95"/>'
    '<rect x="10.6" y="15" width="2.8" height="4.4" rx="1.4" fill="#7C5524"/>')), encoding="utf-8")

# --- binaries / everything opaque ---
(OUT / "file-bin.svg").write_text(chip("#7C8794", (
    '<g fill="#ffffff" fill-opacity="0.95">'
    '<rect x="6.4" y="6.6" width="4.6" height="5" rx="1.3"/>'
    '<rect x="13" y="6.6" width="4.6" height="5" rx="1.3"/>'
    '<rect x="6.4" y="13.2" width="4.6" height="4.2" rx="1.3" fill-opacity="0.6"/>'
    '<rect x="13" y="13.2" width="4.6" height="4.2" rx="1.3" fill-opacity="0.6"/></g>')), encoding="utf-8")

# --- keys, certificates, .env ---
(OUT / "file-lock.svg").write_text(svg(
    '<path d="M8.2 10.6V8.4a3.8 3.8 0 0 1 7.6 0v2.2" fill="none" stroke="#E3B341" stroke-width="2.1"/>'
    '<rect x="4.8" y="10.2" width="14.4" height="10.4" rx="2.8" fill="#E3B341"/>'
    '<circle cx="12" cy="14.6" r="1.5" fill="#7A5B10"/>'
    '<rect x="11.3" y="15.4" width="1.4" height="2.6" rx="0.7" fill="#7A5B10"/>'), encoding="utf-8")

# --- git housekeeping files ---
(OUT / "file-git.svg").write_text(svg(
    '<g fill="#F05033"><circle cx="7.6" cy="6.4" r="2.3"/><circle cx="7.6" cy="17.6" r="2.3"/>'
    '<circle cx="16.4" cy="9.6" r="2.3"/><rect x="6.8" y="6.4" width="1.6" height="11.2"/></g>'
    '<path d="M16.4 9.6c0 3.2-3 3.4-5.6 4.4" fill="none" stroke="#F05033" stroke-width="1.6" '
    'stroke-linecap="round"/>'), encoding="utf-8")

# --- databases ---
(OUT / "file-db.svg").write_text(svg(
    '<path d="M3.8 6.6v10.8c0 2 3.7 3.4 8.2 3.4s8.2-1.4 8.2-3.4V6.6Z" fill="#0F8FA0"/>'
    '<ellipse cx="12" cy="6.6" rx="8.2" ry="3.4" fill="#16B6C4"/>'
    '<path d="M3.8 12c0 2 3.7 3.4 8.2 3.4s8.2-1.4 8.2-3.4" fill="none" stroke="#0A6F7C" '
    'stroke-width="1.4" stroke-opacity="0.6"/>'), encoding="utf-8")

# --- folders ---
FLAP = ('<path d="M2.2 6.4A2.2 2.2 0 0 1 4.4 4.2h4.1c.62 0 1.2.26 1.62.72l1.05 1.16'
        'c.2.22.48.34.78.34h6.6A2.2 2.2 0 0 1 20.8 8.6v1.3H2.2Z" fill="#C98A2A"/>')
(OUT / "folder.svg").write_text(svg(
    FLAP +
    '<path d="M2.2 9.4h17.9a2.2 2.2 0 0 1 2.2 2.2v6.3a2.2 2.2 0 0 1-2.2 2.2H4.4a2.2 2.2 0 0 1-2.2-2.2Z" fill="#E9A93E"/>'),
    encoding="utf-8")
(OUT / "folder-open.svg").write_text(svg(
    FLAP +
    '<path d="M4.6 10.4h15.9a2 2 0 0 1 1.95 2.44l-1.42 6.05a2.4 2.4 0 0 1-2.34 1.86H4.4'
    'a2.2 2.2 0 0 1-2.2-2.2v-6a2.2 2.2 0 0 1 2.4-2.15Z" fill="#F0B552"/>'), encoding="utf-8")

print("\n".join(sorted(p.name for p in OUT.iterdir())))
