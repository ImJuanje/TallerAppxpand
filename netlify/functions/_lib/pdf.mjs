import { deflateSync, inflateSync } from "node:zlib";

// Generador de PDF sin dependencias (A4, Helvetica estándar). Anchos de letra de Helvetica / Helvetica-Bold por código WinAnsi (cp1252), en milésimas de em.
const AN = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,761,556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500];
const AB = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,761,556,0,278,556,500,1000,556,556,333,1000,667,333,1000,0,611,0,0,278,278,500,500,350,556,1000,333,1000,556,333,944,0,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556];
const WIN = { 0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E,
  0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F };
const bytes = (t) => Array.from(String(t ?? "").replace(/[\r\n\t]+/g, " ")).map((ch) => { const c = ch.codePointAt(0); return c >= 32 && c < 127 ? c : c >= 160 && c < 256 ? c : WIN[c] || 63; });
const ancho = (t, size, neg) => bytes(t).reduce((s, b) => s + (neg ? AB : AN)[b], 0) * size / 1000;
const hex = (t) => "<" + bytes(t).map((b) => b.toString(16).padStart(2, "0")).join("") + ">";
const num = (n) => (Math.round(n * 100) / 100).toString();

// Formatos españoles: 1.234,56 € y dd/mm/aaaa (hora de Madrid)
export const eur = (x) => { const neg = x < 0, [e, d] = Math.abs(x).toFixed(2).split("."); return (neg ? "-" : "") + e.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "," + d + " €"; };
export const fechaES = (ms) => new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(ms));

// ---- imágenes (logo): JPEG directo; PNG de 8 bits sin entrelazar, decodificado a RGB (+ canal alfa como máscara) ----
function leePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let pos = 8, w, h, bd, ct, il, plte = null, trns = null; const idat = [];
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos), tipo = buf.toString("latin1", pos + 4, pos + 8), d = buf.subarray(pos + 8, pos + 8 + len);
    if (tipo === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; il = d[12]; }
    else if (tipo === "PLTE") plte = d; else if (tipo === "tRNS") trns = d; else if (tipo === "IDAT") idat.push(d); else if (tipo === "IEND") break;
    pos += 12 + len;
  }
  if (!w || !h || bd !== 8 || il !== 0 || ![0, 2, 3, 4, 6].includes(ct) || w * h > 4e6 || (ct === 3 && !plte)) return null;
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct], stride = w * ch, raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * h) return null;
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], ro = y * (stride + 1) + 1, po = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[po + x - ch] : 0, b = y ? px[po - stride + x] : 0, c = x >= ch && y ? px[po - stride + x - ch] : 0; let v = raw[ro + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (f !== 0) return null;
      px[po + x] = v & 255;
    }
  }
  const rgb = Buffer.alloc(w * h * 3), conAlfa = ct === 4 || ct === 6 || (ct === 3 && trns), alfa = conAlfa ? Buffer.alloc(w * h) : null;
  for (let i = 0; i < w * h; i++) {
    if (ct === 2 || ct === 6) { rgb[i * 3] = px[i * ch]; rgb[i * 3 + 1] = px[i * ch + 1]; rgb[i * 3 + 2] = px[i * ch + 2]; if (ct === 6) alfa[i] = px[i * 4 + 3]; }
    else if (ct === 0 || ct === 4) { const v = px[i * ch]; rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = v; if (ct === 4) alfa[i] = px[i * 2 + 1]; }
    else { const k = px[i]; rgb[i * 3] = plte[k * 3]; rgb[i * 3 + 1] = plte[k * 3 + 1]; rgb[i * 3 + 2] = plte[k * 3 + 2]; if (alfa) alfa[i] = k < trns.length ? trns[k] : 255; }
  }
  return { tipo: "png", w, h, rgb, alfa };
}
function leeJpeg(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xc0 || m === 0xc1 || m === 0xc2) { const comps = buf[i + 9]; return comps === 1 || comps === 3 ? { tipo: "jpeg", w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), comps, data: buf } : null; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
const leeLogo = (url) => { try { const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(url || ""); if (!m) return null; const b = Buffer.from(m[2], "base64"); return m[1] === "png" ? leePng(b) : leeJpeg(b); } catch { return null; } };

// ---- página: acumula operaciones de dibujo ----
const W = 595.28, H = 841.89, M = 48, CW = W - 2 * M;
class Pag {
  constructor() { this.o = []; this.logo = false; }
  txt(x, y, t, size = 10, neg = false, g = 0) { this.o.push(`${g} g BT /${neg ? "F2" : "F1"} ${size} Tf ${num(x)} ${num(y)} Td ${hex(t)} Tj ET`); }
  der(xr, y, t, size, neg, g) { this.txt(xr - ancho(t, size, neg), y, t, size, neg, g); }
  lin(x1, y1, x2, y2, g = 0.8, gr = 0.5) { this.o.push(`${g} G ${gr} w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`); }
  caja(x, y, w, h, g) { this.o.push(`${g} g ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`); }
  img(x, y, w, h) { this.logo = true; this.o.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /Im1 Do Q`); }
}
function envolver(t, size, neg, max) {
  const out = []; let l = "";
  for (const p of String(t ?? "").split(/\s+/).filter(Boolean)) {
    const c = l ? l + " " + p : p;
    if (ancho(c, size, neg) <= max || !l) l = c; else { out.push(l); l = p; }
  }
  if (l) out.push(l);
  return out.length ? out : [""];
}

// f = documento de factura (ver facturas.mjs). Devuelve un Buffer con el PDF.
export function facturaPdf(f) {
  const rect = f.tipo === "R", tit = rect ? "FACTURA RECTIFICATIVA" : f.simplificada ? "FACTURA SIMPLIFICADA" : "FACTURA";
  const logo = leeLogo(f.emisor?.logo), pags = [];
  const nueva = () => { const p = new Pag(); pags.push(p); return p; };
  let p = nueva(), y = H - M;

  // cabecera: logo a la izquierda, título y número a la derecha
  let yl = y;
  if (logo) { const k = Math.min(150 / logo.w, 52 / logo.h), lw = logo.w * k, lh = logo.h * k; p.img(M, y - lh, lw, lh); yl = y - lh - 10; }
  p.der(W - M, y - 16, tit, 17, true); p.der(W - M, y - 34, "Nº " + f.numero, 11, true); p.der(W - M, y - 49, "Fecha: " + fechaES(f.fecha), 10);
  y = Math.min(yl, y - 62) - 14;

  // emisor (izquierda) y cliente (derecha)
  const e = f.emisor || {}, c = f.cliente || {}, xc = M + CW / 2 + 12, wc = CW / 2 - 12;
  p.txt(M, y, "EMISOR", 7.5, true, 0.45); p.txt(xc, y, "CLIENTE", 7.5, true, 0.45);
  let ye = y - 14, yc = y - 14;
  for (const l of envolver(e.razon, 11, true, wc)) { p.txt(M, ye, l, 11, true); ye -= 14; }
  for (const l of [e.nif && "NIF: " + e.nif, e.dir, [e.cp, e.ciudad].filter(Boolean).join(" ") + (e.provincia ? " (" + e.provincia + ")" : "")]) if (l && l.trim()) for (const s of envolver(l, 9.5, false, wc)) { p.txt(M, ye, s, 9.5); ye -= 12.5; }
  for (const l of envolver(c.nombre, 11, true, wc)) { p.txt(xc, yc, l, 11, true); yc -= 14; }
  for (const l of [c.nif && "NIF: " + c.nif, c.dir, [c.cp, c.ciudad].filter(Boolean).join(" ")]) if (l && l.trim()) for (const s of envolver(l, 9.5, false, wc)) { p.txt(xc, yc, s, 9.5); yc -= 12.5; }
  y = Math.min(ye, yc) - 10;

  const v = f.vehiculo || {}, veh = [[v.marca, v.modelo].filter(Boolean).join(" "), v.mat && "Matrícula " + v.mat, v.km && String(Math.round(v.km)).replace(/\B(?=(\d{3})+(?!\d))/g, ".") + " km"].filter(Boolean).join("  ·  ");
  if (veh) { p.txt(M, y, "Vehículo: " + veh, 9.5, false, 0.25); y -= 16; }
  if (rect) {
    for (const l of envolver(`Rectifica la factura ${f.rect.de} (${fechaES(f.rect.fechaOriginal)}). Motivo: ${f.rect.motivo}`, 9.5, false, CW)) { p.txt(M, y, l, 9.5, false, 0.25); y -= 12.5; }
    y -= 4;
  }

  // tabla de conceptos
  const cabTabla = (pg, yy) => { pg.caja(M, yy - 5, CW, 18, 0.93); pg.txt(M + 8, yy, "Concepto", 9.5, true); pg.der(W - M - 8, yy, "Importe (base)", 9.5, true); return yy - 20; };
  y = cabTabla(p, y - 4);
  for (const l of f.lineas || []) {
    const partes = envolver(l.c + (l.t ? "  (" + l.t + ")" : ""), 10, false, CW - 130), alto = partes.length * 13 + 6;
    if (y - alto < M + 120) { // salto de página
      p = nueva(); y = H - M; p.txt(M, y, `Factura ${f.numero} (continuación)`, 10, true, 0.3); y = cabTabla(p, y - 24);
    }
    partes.forEach((s, i) => p.txt(M + 8, y - i * 13, s, 10));
    p.der(W - M - 8, y, eur(l.i), 10);
    y -= alto; p.lin(M, y + 8, W - M, y + 8, 0.88, 0.4);
  }

  // totales
  if (y < M + 100) { p = nueva(); y = H - M; }
  y -= 8; const xl = W - M - 200, xr = W - M - 8;
  for (const [t, val] of [["Base imponible", eur(f.base)], [`IVA ${f.tipoIva} %`, eur(f.iva)]]) { p.txt(xl, y, t, 10); p.der(xr, y, val, 10); y -= 16; }
  p.lin(xl, y + 9, W - M, y + 9, 0.3, 0.8); y -= 4;
  p.caja(xl - 6, y - 7, 206, 22, 0.93); p.txt(xl, y, "TOTAL", 12, true); p.der(xr, y, eur(f.total), 12, true);

  // pie con número de página
  pags.forEach((pg, i) => { pg.lin(M, M - 6, W - M, M - 6, 0.85, 0.4); pg.txt(M, M - 20, `Factura ${f.numero}`, 8, false, 0.45); pg.der(W - M, M - 20, `Página ${i + 1} de ${pags.length}`, 8, false, 0.45); });

  // ---- ensamblado del PDF ----
  const objs = []; const add = (s) => { objs.push(s); return objs.length; };
  const flate = (b) => deflateSync(b);
  add("<< /Type /Catalog /Pages 2 0 R >>"); add(null);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  let imId = 0;
  if (logo) {
    if (logo.tipo === "jpeg") imId = add({ d: `<< /Type /XObject /Subtype /Image /Width ${logo.w} /Height ${logo.h} /ColorSpace /${logo.comps === 1 ? "DeviceGray" : "DeviceRGB"} /BitsPerComponent 8 /Filter /DCTDecode`, b: logo.data });
    else {
      const sm = logo.alfa ? add({ d: `<< /Type /XObject /Subtype /Image /Width ${logo.w} /Height ${logo.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, b: flate(logo.alfa) }) : 0;
      imId = add({ d: `<< /Type /XObject /Subtype /Image /Width ${logo.w} /Height ${logo.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${sm ? ` /SMask ${sm} 0 R` : ""}`, b: flate(logo.rgb) });
    }
  }
  const hojas = pags.map((pg) => {
    const cont = add({ d: "<< /Filter /FlateDecode", b: flate(Buffer.from(pg.o.join("\n"), "latin1")) });
    return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${cont} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${pg.logo && imId ? ` /XObject << /Im1 ${imId} 0 R >>` : ""} >> >>`);
  });
  objs[1] = `<< /Type /Pages /Kids [${hojas.map((i) => i + " 0 R").join(" ")}] /Count ${hojas.length} >>`;
  const partes = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")], offs = []; let len = partes[0].length;
  objs.forEach((o, i) => {
    offs.push(len);
    const b = typeof o === "string" ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, "latin1")
      : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.d} /Length ${o.b.length} >>\nstream\n`, "latin1"), o.b, Buffer.from("\nendstream\nendobj\n", "latin1")]);
    partes.push(b); len += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("") + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`;
  partes.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(partes);
}
