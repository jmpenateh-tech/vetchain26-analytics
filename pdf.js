// =============================================================================
// Generador de PDF mínimo — VetChain 2.10
//
// Sin dependencias externas (solo "zlib" de Node), igual que el JWT del proyecto: así
// no cambia ningún package-lock.json y la imagen se construye exactamente igual.
// Produce PDF 1.4 reales con las fuentes estándar Helvetica / Helvetica-Bold
// (codificación WinAnsi: cubre tildes, ñ, ¿, ¡, °, €). Incluye:
//   - encabezado y pie en todas las páginas ("Página X de Y");
//   - títulos, párrafos con ajuste de línea, tarjetas de indicadores;
//   - tablas con encabezado repetido en cada página, filas cebra y texto largo ajustado
//     (una celda muy larga se recorta con "…" para que una fila nunca supere una página).
// =============================================================================
import zlib from "zlib";

// Anchos AFM (1/1000 em) de los caracteres 32..126.
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

// Caracteres fuera de Latin-1 que WinAnsi sí tiene.
const WIN_EXTRA = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99 };
// Sustitutos legibles para símbolos que la fuente estándar no tiene.
const REPLACE = { "→": "->", "←": "<-", "≥": ">=", "≤": "<=", "✓": "Si", "✗": "No", " ": " ", " ": " ", " ": " " };

function toWin(text) {
  const out = [];
  for (const ch of String(text ?? "").normalize("NFC")) {
    const rep = REPLACE[ch];
    if (rep) { for (const c of rep) out.push(c.charCodeAt(0)); continue; }
    const code = ch.codePointAt(0);
    if (code === 9 || code === 10 || code === 13) out.push(32);
    else if (code >= 32 && code <= 126) out.push(code);
    else if (code >= 160 && code <= 255) out.push(code);
    else if (WIN_EXTRA[ch]) out.push(WIN_EXTRA[ch]);
    else if (code >= 32) {
      // Letra con diacrítico no soportado: se usa la letra base (ő -> o); si no, "?".
      const base = ch.normalize("NFD")[0].codePointAt(0);
      out.push(base >= 32 && base <= 126 ? base : 63);
    }
  }
  return out;
}

const BASE_FOR_WIDTH = (code) => {
  if (code <= 126) return code;
  if (code === 0x85) return 46; // … ≈ ancho de un punto x3 (se corrige abajo)
  if (code >= 0x91 && code <= 0x94) return 39;
  if (code === 0x96 || code === 0x97) return 45;
  if (code >= 192) { const b = String.fromCharCode(code).normalize("NFD")[0].charCodeAt(0); if (b <= 126) return b; }
  return 0;
};
function widthOf(codes, bold, size) {
  const T = bold ? W_BOLD : W_REG;
  let w = 0;
  for (const c of codes) {
    if (c === 0x85) { w += 1000; continue; }
    const b = BASE_FOR_WIDTH(c);
    w += b >= 32 && b <= 126 ? T[b - 32] : 556;
  }
  return (w * size) / 1000;
}
const pdfStr = (codes) => {
  let s = "(";
  for (const c of codes) {
    if (c === 40 || c === 41 || c === 92) s += "\\" + String.fromCharCode(c);
    else s += String.fromCharCode(c);
  }
  return s + ")";
};

const hex = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255].map((x) => x.toFixed(3)).join(" "); };
const COLORS = { brand: "#0f766e", ink: "#0f172a", muted: "#64748b", line: "#cbd5e1", head: "#e2e8f0", zebra: "#f8fafc", warn: "#b45309", warnBg: "#fef3c7", card: "#f1f5f9" };

export class PdfDoc {
  constructor({ title, subtitle = "", meta = [], landscape = false, author = "VetChain" } = {}) {
    this.title = title; this.subtitle = subtitle; this.meta = meta; this.author = author;
    this.W = landscape ? 841.89 : 595.28; this.H = landscape ? 595.28 : 841.89;
    this.M = 40; this.pages = []; this.newPage(true);
  }
  get contentWidth() { return this.W - this.M * 2; }

  newPage(first = false) {
    this.page = { ops: [] }; this.pages.push(this.page);
    const top = this.H - this.M;
    // Encabezado
    this.rect(0, this.H - 8, this.W, 8, COLORS.brand);
    this.text("VetChain", this.M, top - 6, { bold: true, size: 13, color: COLORS.brand });
    if (!first) this.text(this.title, this.M + 70, top - 6, { bold: true, size: 10, color: COLORS.ink, maxWidth: this.contentWidth - 70 });
    this.line(this.M, top - 14, this.W - this.M, top - 14, COLORS.line);
    this.y = top - 30;
    if (first) {
      this.text(this.title, this.M, this.y, { bold: true, size: 17, color: COLORS.ink, maxWidth: this.contentWidth });
      this.y -= 18;
      if (this.subtitle) { this.paragraph(this.subtitle, { size: 10, color: COLORS.muted }); }
      for (const m of this.meta) this.paragraph(m, { size: 9, color: COLORS.muted, gap: 1 });
      this.y -= 6;
    }
  }
  ensure(h) { if (this.y - h < this.M + 24) this.newPage(); }

  // --- primitivas ---
  rect(x, y, w, h, fill) { this.page.ops.push(`${hex(fill)} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`); }
  line(x1, y1, x2, y2, color, width = 0.6) { this.page.ops.push(`${hex(color)} RG ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`); }
  text(t, x, y, { bold = false, size = 9, color = COLORS.ink, maxWidth, align = "left", width } = {}) {
    let codes = toWin(t);
    if (maxWidth && widthOf(codes, bold, size) > maxWidth) codes = this.truncate(codes, bold, size, maxWidth);
    let tx = x;
    if (align !== "left" && width) { const tw = widthOf(codes, bold, size); tx = align === "right" ? x + width - tw : x + (width - tw) / 2; }
    this.page.ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${hex(color)} rg 1 0 0 1 ${tx.toFixed(2)} ${y.toFixed(2)} Tm ${pdfStr(codes)} Tj ET`);
  }
  truncate(codes, bold, size, maxWidth) {
    const ell = widthOf([0x85], bold, size);
    const out = [];
    for (const c of codes) { if (widthOf([...out, c], bold, size) + ell > maxWidth) break; out.push(c); }
    return [...out, 0x85];
  }
  wrap(t, { bold = false, size = 9, maxWidth }) {
    const words = String(t ?? "").split(/\s+/).filter(Boolean);
    const lines = []; let cur = [];
    const fits = (arr) => widthOf(toWin(arr.join(" ")), bold, size) <= maxWidth;
    for (const w of words) {
      if (fits([...cur, w])) { cur.push(w); continue; }
      if (cur.length) lines.push(cur.join(" "));
      cur = [];
      if (fits([w])) { cur = [w]; continue; }
      // palabra más larga que la columna (p. ej. un número de serie): se corta por caracteres
      let piece = "";
      for (const ch of w) { if (widthOf(toWin(piece + ch), bold, size) > maxWidth && piece) { lines.push(piece); piece = ""; } piece += ch; }
      cur = [piece];
    }
    if (cur.length) lines.push(cur.join(" "));
    return lines.length ? lines : [""];
  }

  // --- bloques ---
  heading(t, { size = 13 } = {}) {
    // Espacio para el título + encabezado de tabla + al menos una fila: un título nunca queda solo al pie.
    this.ensure(size + 70);
    this.y -= 8;
    this.text(t, this.M, this.y, { bold: true, size, color: COLORS.brand, maxWidth: this.contentWidth });
    this.y -= 6; this.line(this.M, this.y, this.W - this.M, this.y, COLORS.line); this.y -= 12;
  }
  paragraph(t, { size = 9.5, color = COLORS.ink, bold = false, gap = 4 } = {}) {
    const lines = this.wrap(t, { size, bold, maxWidth: this.contentWidth });
    for (const l of lines) { this.ensure(size + 3); this.text(l, this.M, this.y, { size, color, bold }); this.y -= size + 3; }
    this.y -= gap;
  }
  notice(t) {
    const lines = this.wrap(t, { size: 9, maxWidth: this.contentWidth - 16 });
    const h = lines.length * 12 + 10;
    this.ensure(h + 6);
    this.rect(this.M, this.y - h + 9, this.contentWidth, h, COLORS.warnBg);
    let yy = this.y - 2;
    for (const l of lines) { this.text(l, this.M + 8, yy, { size: 9, color: COLORS.warn, bold: true }); yy -= 12; }
    this.y -= h + 6;
  }
  kpis(items, { perRow = 4 } = {}) {
    const gap = 8, w = (this.contentWidth - gap * (perRow - 1)) / perRow, h = 42;
    for (let i = 0; i < items.length; i += perRow) {
      this.ensure(h + gap);
      items.slice(i, i + perRow).forEach(([label, value], j) => {
        const x = this.M + j * (w + gap);
        this.rect(x, this.y - h + 10, w, h, COLORS.card);
        this.text(String(value), x + 8, this.y - 8, { bold: true, size: 14, color: COLORS.ink, maxWidth: w - 16 });
        this.text(label, x + 8, this.y - 24, { size: 8, color: COLORS.muted, maxWidth: w - 16 });
      });
      this.y -= h + gap;
    }
    this.y -= 2;
  }
  // columns: [{ label, key | value(row), width (proporción), align }]
  table({ columns, rows, emptyText = "No hay registros para los filtros seleccionados.", size = 8, maxLines = 6 }) {
    const total = columns.reduce((a, c) => a + (c.width || 1), 0);
    const cols = columns.map((c) => ({ ...c, w: (this.contentWidth * (c.width || 1)) / total }));
    const pad = 4, lh = size + 2.5;
    const drawHead = () => {
      const lines = cols.map((c) => this.wrap(c.label, { bold: true, size, maxWidth: c.w - pad * 2 }).slice(0, 2));
      const h = Math.max(...lines.map((l) => l.length)) * lh + pad * 2;
      this.ensure(h + lh * 2 + pad * 2);
      this.rect(this.M, this.y - h + lh, this.contentWidth, h, COLORS.head);
      let x = this.M;
      cols.forEach((c, i) => { let yy = this.y - pad + 1; for (const l of lines[i]) { this.text(l, x + pad, yy, { bold: true, size, align: c.align, width: c.w - pad * 2 }); yy -= lh; } x += c.w; });
      this.y -= h;
    };
    drawHead();
    if (!rows.length) { this.paragraph(emptyText, { size: 9, color: COLORS.muted }); return; }
    rows.forEach((row, idx) => {
      const cells = cols.map((c) => {
        const v = c.value ? c.value(row) : row[c.key];
        let lines = this.wrap(v === null || v === undefined || v === "" ? "—" : String(v), { size, maxWidth: c.w - pad * 2 });
        if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] += " …"; }
        return lines;
      });
      const h = Math.max(...cells.map((l) => l.length)) * lh + pad * 2;
      if (this.y - h < this.M + 24) { this.newPage(); drawHead(); }
      if (idx % 2 === 1) this.rect(this.M, this.y - h + lh, this.contentWidth, h, COLORS.zebra);
      let x = this.M;
      cols.forEach((c, i) => { let yy = this.y - pad + 1; for (const l of cells[i]) { this.text(l, x + pad, yy, { size, align: c.align, width: c.w - pad * 2, maxWidth: c.w - pad * 2 }); yy -= lh; } x += c.w; });
      this.y -= h;
    });
    this.line(this.M, this.y + lh - 1, this.W - this.M, this.y + lh - 1, COLORS.line);
    this.y -= 6;
  }

  toBuffer() {
    const n = this.pages.length;
    const stamp = new Date();
    this.pages.forEach((p, i) => {
      this.page = p;
      this.line(this.M, this.M + 6, this.W - this.M, this.M + 6, COLORS.line);
      this.text(`Generado el ${stamp.toLocaleString("es-CO", { timeZone: process.env.REPORT_TZ || "America/Bogota" })} · Documento confidencial de uso interno`, this.M, this.M - 6, { size: 7.5, color: COLORS.muted });
      this.text(`Página ${i + 1} de ${n}`, this.M, this.M - 6, { size: 7.5, color: COLORS.muted, align: "right", width: this.contentWidth });
    });
    const objs = [];
    const add = (body) => { objs.push(body); return objs.length; };
    const catalog = add(null), pagesId = add(null);
    const f1 = add(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>", "latin1"));
    const f2 = add(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>", "latin1"));
    const kids = [];
    for (const p of this.pages) {
      const raw = zlib.deflateSync(Buffer.from(p.ops.join("\n"), "latin1"));
      const content = add(Buffer.concat([Buffer.from(`<< /Length ${raw.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), raw, Buffer.from("\nendstream", "latin1")]));
      kids.push(add(Buffer.from(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`, "latin1")));
    }
    objs[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, "latin1");
    objs[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`, "latin1");
    const d = stamp.toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const info = add(Buffer.from(`<< /Title ${pdfStr(toWin(this.title))} /Author ${pdfStr(toWin(this.author))} /Producer (VetChain) /CreationDate (D:${d}Z) >>`, "latin1"));
    const parts = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    const offsets = [];
    let pos = parts[0].length;
    objs.forEach((body, i) => {
      const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
      offsets.push(pos); pos += chunk.length; parts.push(chunk);
    });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, "latin1"));
    return Buffer.concat(parts);
  }
}
