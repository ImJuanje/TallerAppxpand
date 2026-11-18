import { T } from "./_lib/store.mjs";
import { exigir, sha } from "./_lib/auth.mjs";
import { validaNif } from "./_lib/nif.mjs";
import { facturaPdf } from "./_lib/pdf.mjs";

// Facturación (solo admin).
//  · /api/fiscal                       datos fiscales del taller (sin ellos no se emite)
//  · POST /api/facturas                emitir factura desde una orden con presupuesto aprobado
//  · POST /api/facturas/:nº/rectificar emitir la rectificativa que anula una factura (la original nunca se toca)
//  · GET  /api/facturas                listado (?anio=2026&trimestre=4) · ?orden=ID las de un coche
//  · GET  /api/facturas/:nº/pdf        descarga del PDF
//  · GET  /api/facturas/verificar      comprueba números sin saltos y cadena de huellas
// Las facturas son inmutables: no existe ninguna ruta para editarlas o borrarlas. Cada una guarda una copia de los datos fiscales de ese
// momento, el número correlativo por año (rectificativas en su propia serie R-) y una huella encadenada con la anterior.
export const config = { path: ["/api/fiscal", "/api/facturas", "/api/facturas/*"] };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const s = (v, n) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, n);
const LOGO = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const OBLIGATORIOS = ["razon", "nif", "dir", "cp", "ciudad"];
const ID = /^[a-z0-9]{6,40}$/, NUM = /^(R-)?(\d{4})-(\d{4,6})$/;
const IVA = 21, LIMITE_SIMPLIFICADA = 400; // según recuerdo, el tope general de la factura simplificada es 400 € con IVA: confírmalo con el asesor
const cts = (x) => Math.round(x * 100);
const num = (tipo, anio, n) => `${tipo === "R" ? "R-" : ""}${anio}-${String(n).padStart(4, "0")}`;
const madrid = (ms, o) => +new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", ...o }).format(new Date(ms)).replace(/\D/g, "");
const anioDe = (ms) => madrid(ms, { year: "numeric" }), trimDe = (ms) => Math.ceil(madrid(ms, { month: "numeric" }) / 3);
const calc = (lineas) => { const b = lineas.reduce((a, l) => a + cts(l.i), 0), i = Math.round(b * IVA / 100); return { base: b / 100, iva: i / 100, total: (b + i) / 100 }; };
const huellaDe = (d) => sha(JSON.stringify([d.prev, d.numero, d.fecha, d.emisor?.nif, d.cliente?.nif || "", d.base, d.iva, d.total, (d.lineas || []).map((l) => [l.c, l.t, l.i]), d.rect?.de || ""]));
const resumen = ({ emisor, ...d }) => ({ numero: d.numero, tipo: d.tipo, fecha: d.fecha, orden: d.orden, cliente: { nombre: d.cliente.nombre, nif: d.cliente.nif || "" }, vehiculo: d.vehiculo,
  base: d.base, iva: d.iva, total: d.total, simplificada: !!d.simplificada, rectDe: d.rect?.de || "" });

const leerTodas = async (t) => {
  const ks = await t.list("facturas/"), out = [];
  for (let i = 0; i < ks.length; i += 25) out.push(...(await Promise.all(ks.slice(i, i + 25).map((k) => t.get(k)))));
  return out.filter(Boolean).sort((a, b) => a.seq - b.seq);
};

// Siguiente número de la serie y huella de la última factura emitida (de cualquier serie)
async function siguiente(t, tipo, anio) {
  const e = (await t.list("facturas/")).map((k) => NUM.exec(k.slice(9))).filter(Boolean).map((m) => ({ tipo: m[1] ? "R" : "F", anio: +m[2], n: +m[3] }));
  const ult = (tp) => e.filter((x) => x.tipo === tp).sort((a, b) => a.anio - b.anio || a.n - b.n).at(-1);
  const n = Math.max(0, ...e.filter((x) => x.tipo === tipo && x.anio === anio).map((x) => x.n)) + 1;
  const docs = await Promise.all(["F", "R"].map(ult).filter(Boolean).map((x) => t.get("facturas/" + num(x.tipo, x.anio, x.n))));
  const u = docs.filter(Boolean).sort((a, b) => a.seq - b.seq).at(-1);
  return { n, prev: u?.hash || "", seq: (u?.seq || 0) + 1 };
}
// El número se reserva creando la propia factura (solo si no existe): así no puede haber saltos ni duplicados aunque dos peticiones coincidan.
async function emitir(t, tipo, datos) {
  for (let i = 0; i < 8; i++) {
    const fecha = Date.now(), anio = anioDe(fecha), { n, prev, seq } = await siguiente(t, tipo, anio);
    const d = { numero: num(tipo, anio, n), tipo, serie: (tipo === "R" ? "R-" : "") + anio, anio, n, seq, fecha, ...datos, tipoIva: IVA, prev };
    d.hash = huellaDe(d);
    if (await t.putNew("facturas/" + d.numero, d)) return d;
  }
  throw new Error("No se ha podido asignar el número de factura. Inténtalo de nuevo.");
}
const actualizaClaim = (t, orden, fn) => t.mutate("facturaorden/" + orden, (c) => { const n = fn({ actual: "", historial: [], bloqueo: 0, ...(c || {}) }); return { write: n, out: n }; });

const handler = async (req) => {
  const ses = exigir(req, "admin");
  if (!ses) return json({ error: "No autorizado" }, 403);
  const t = T("main"), url = new URL(req.url), p = url.pathname.split("/").filter(Boolean); // [api, fiscal|facturas, x?, y?]

  // ---------- datos fiscales ----------
  if (p[1] === "fiscal") {
    if (req.method === "GET") { const f = await t.get("fiscal"); return json({ fiscal: f || null, completo: !!f && OBLIGATORIOS.every((k) => f[k]) }); }
    if (req.method === "PUT") {
      const b = await req.json().catch(() => ({})), err = [];
      const f = { razon: s(b.razon, 100), nif: "", dir: s(b.dir, 120), cp: s(b.cp, 5), ciudad: s(b.ciudad, 60), provincia: s(b.provincia, 60), logo: "" };
      if (!f.razon) err.push("Falta la razón social o el nombre");
      const n = validaNif(b.nif);
      if (n.ok) f.nif = n.nif; else err.push("El NIF o CIF no es válido");
      if (!f.dir) err.push("Falta la dirección");
      if (!/^\d{5}$/.test(f.cp)) err.push("El código postal debe tener 5 cifras");
      if (!f.ciudad) err.push("Falta el municipio");
      if (b.logo) {
        if (typeof b.logo !== "string" || b.logo.length > 280000 || !LOGO.test(b.logo)) err.push("El logo debe ser una imagen PNG o JPG pequeña");
        else f.logo = b.logo;
      }
      if (err.length) return json({ error: err.join(". ") + "." }, 400);
      f.actualizado = Date.now(); f.por = ses.usuario;
      await t.put("fiscal", f);
      return json({ fiscal: f, completo: true });
    }
    return json({ error: "No encontrado" }, 404);
  }

  // ---------- facturas ----------
  if (req.method === "GET" && !p[2]) {
    if (url.searchParams.get("orden")) { // las facturas de un coche
      const id = url.searchParams.get("orden");
      if (!ID.test(id)) return json({ error: "Orden no válida" }, 400);
      const c = await t.get("facturaorden/" + id);
      const docs = (await Promise.all((c?.historial || []).map((x) => t.get("facturas/" + x)))).filter(Boolean);
      const rectPor = Object.fromEntries(docs.filter((d) => d.rect).map((d) => [d.rect.de, d.numero]));
      return json({ actual: c?.actual || "", facturas: docs.map((d) => ({ ...resumen(d), rectificadaPor: rectPor[d.numero] || "" })) });
    }
    const anio = +url.searchParams.get("anio") || 0, tri = +url.searchParams.get("trimestre") || 0;
    const todas = await leerTodas(t), rectPor = Object.fromEntries(todas.filter((d) => d.rect).map((d) => [d.rect.de, d.numero]));
    const sel = todas.filter((d) => (!anio || anioDe(d.fecha) === anio) && (!tri || trimDe(d.fecha) === tri)).reverse();
    const sum = sel.reduce((a, d) => ({ base: a.base + cts(d.base), iva: a.iva + cts(d.iva), total: a.total + cts(d.total) }), { base: 0, iva: 0, total: 0 });
    return json({ facturas: sel.map((d) => ({ ...resumen(d), rectificadaPor: rectPor[d.numero] || "" })), totales: { n: sel.length, base: sum.base / 100, iva: sum.iva / 100, total: sum.total / 100 },
      anios: [...new Set(todas.map((d) => anioDe(d.fecha)))].sort((a, b) => b - a) });
  }

  if (req.method === "GET" && p[2] === "verificar") {
    const todas = await leerTodas(t), problemas = []; let prev = "", seq = 0;
    for (const d of todas) {
      if (d.seq !== seq + 1) problemas.push(`Falta una factura antes de la ${d.numero} (secuencia ${seq + 1}).`);
      if (d.prev !== prev) problemas.push(`La cadena se rompe en la ${d.numero}: no enlaza con la anterior.`);
      if (d.hash !== huellaDe(d)) problemas.push(`La factura ${d.numero} no coincide con su huella: ha sido modificada.`);
      prev = d.hash; seq = d.seq;
    }
    const series = {};
    for (const d of todas) (series[d.serie] ||= []).push(d.n);
    for (const [sr, ns] of Object.entries(series)) ns.sort((a, b) => a - b).forEach((n, i) => { if (n !== i + 1) problemas.push(`En la serie ${sr} falta el número ${i + 1}.`); });
    return json({ ok: !problemas.length, total: todas.length, problemas });
  }

  if (req.method === "GET" && NUM.test(p[2] || "") && p[3] === "pdf") {
    const d = await t.get("facturas/" + p[2]);
    if (!d) return json({ error: "No existe esa factura" }, 404);
    return new Response(facturaPdf(d), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${d.tipo === "R" ? "Factura-rectificativa" : "Factura"}-${d.numero}.pdf"`, "cache-control": "private, no-store" } });
  }

  if (req.method === "POST" && !p[2]) { // ---- emitir ----
    const b = await req.json().catch(() => ({})), fisc = await t.get("fiscal");
    if (!fisc || !OBLIGATORIOS.every((k) => fisc[k])) return json({ error: "Completa los datos fiscales del taller en Ajustes antes de emitir facturas." }, 400);
    const id = String(b.orden || "");
    if (!ID.test(id)) return json({ error: "Orden no válida" }, 400);
    const o = await t.get("ordenes/" + id);
    if (!o) return json({ error: "No existe esa orden" }, 404);
    // Las líneas salen de la última versión que el cliente aprobó; si no se usa el portal, del presupuesto cerrado por el taller
    const apr = [...(o.presV || [])].reverse().find((v) => v.dec?.resultado === "aprobado");
    let lineas, origen;
    if (apr) { lineas = apr.lineas; origen = `versión ${apr.n} aprobada por el cliente`; }
    else if (o.vb === "ok" && (o.pres || []).length) { lineas = o.pres; origen = "presupuesto cerrado por el taller"; }
    else return json({ error: "El presupuesto de este coche todavía no está aprobado." }, 400);
    lineas = lineas.map((l) => ({ c: s(l.c, 120), t: l.t === "Pieza" ? "Pieza" : "Mano de obra", i: Math.round(l.i * 100) / 100 }));
    const { base, iva, total } = calc(lineas), c = b.cliente || {}, err = [];
    const cli = { nombre: s(c.nombre, 100), nif: "", dir: s(c.dir, 120), cp: s(c.cp, 5), ciudad: s(c.ciudad, 60) };
    if (!cli.nombre) err.push("Falta el nombre del cliente");
    if (s(c.nif, 20)) { const n = validaNif(c.nif); if (n.ok) cli.nif = n.nif; else err.push("El NIF del cliente no es válido"); }
    if (cli.cp && !/^\d{5}$/.test(cli.cp)) err.push("El código postal debe tener 5 cifras");
    if (cli.nif && !cli.dir) err.push("Con NIF hay que indicar también la dirección del cliente");
    if (!cli.nif && total > LIMITE_SIMPLIFICADA) err.push(`Con un total de más de ${LIMITE_SIMPLIFICADA} € (IVA incluido) hay que identificar al cliente con su NIF y su dirección`);
    if (err.length) return json({ error: err.join(". ") + "." }, 400);

    // Una sola factura vigente por orden; el bloqueo de 30 s evita el doble clic
    const claim = await t.mutate("facturaorden/" + id, (cl) => {
      if (cl?.actual) return { out: ["ya", cl.actual] };
      if (cl?.bloqueo && Date.now() - cl.bloqueo < 30000) return { out: ["ocupado"] };
      return { write: { actual: "", historial: [], ...(cl || {}), bloqueo: Date.now() }, out: ["ok"] };
    });
    if (claim[0] === "ya") return json({ error: `Esta orden ya tiene la factura ${claim[1]}. Para cambiarla, rectifícala primero.` }, 409);
    if (claim[0] === "ocupado") return json({ error: "Ya se está emitiendo una factura para esta orden. Espera unos segundos." }, 409);
    try {
      const d = await emitir(t, "F", { orden: id, origen, simplificada: !cli.nif, emisor: fisc, cliente: cli,
        vehiculo: { mat: o.mat, marca: o.marca, modelo: o.modelo, km: o.km || 0 }, lineas, base, iva, total, emitidaPor: ses.usuario });
      await actualizaClaim(t, id, (c0) => ({ ...c0, actual: d.numero, historial: [...c0.historial, d.numero], bloqueo: 0 }));
      return json(resumen(d), 201);
    } catch (e) {
      await actualizaClaim(t, id, (c0) => ({ ...c0, bloqueo: 0 }));
      throw e;
    }
  }

  if (req.method === "POST" && NUM.test(p[2] || "") && p[3] === "rectificar") { // ---- rectificativa ----
    const b = await req.json().catch(() => ({})), motivo = s(b.motivo, 300);
    if (p[2].startsWith("R-")) return json({ error: "Una factura rectificativa no se puede rectificar" }, 400);
    if (motivo.length < 5) return json({ error: "Indica el motivo de la rectificación" }, 400);
    const o = await t.get("facturas/" + p[2]);
    if (!o) return json({ error: "No existe esa factura" }, 404);
    if (!(await t.putNew("rectificadas/" + p[2], { pendiente: true }))) return json({ error: "Esa factura ya está rectificada" }, 409);
    try {
      const neg = (x) => (x === 0 ? 0 : -x);
      const d = await emitir(t, "R", { orden: o.orden, origen: "rectificativa", simplificada: false, emisor: o.emisor, cliente: o.cliente, vehiculo: o.vehiculo,
        lineas: o.lineas.map((l) => ({ ...l, i: neg(l.i) })), base: neg(o.base), iva: neg(o.iva), total: neg(o.total),
        rect: { de: o.numero, fechaOriginal: o.fecha, motivo }, emitidaPor: ses.usuario });
      await t.put("rectificadas/" + p[2], { rect: d.numero, fecha: d.fecha });
      await actualizaClaim(t, o.orden, (c0) => ({ ...c0, actual: c0.actual === o.numero ? "" : c0.actual, historial: [...c0.historial, d.numero] }));
      return json(resumen(d), 201);
    } catch (e) {
      await t.del("rectificadas/" + p[2]);
      throw e;
    }
  }
  return json({ error: "No encontrado" }, 404);
};
export default async (req) => {
  try { return await handler(req); }
  catch (e) { console.error(e); return json({ error: "Error del servidor: " + (e?.message || e) }, 500); }
};
