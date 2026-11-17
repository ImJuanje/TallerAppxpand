import { T } from "./_lib/store.mjs";
import { sha } from "./_lib/auth.mjs";
import { ipDe, bloqueado, fallo } from "./_lib/limite.mjs";

// Portal del cliente: público (sin sesión). Solo lee, salvo /decision (aprobar o rechazar el presupuesto vigente). Se entra con el token del enlace, que va en el cuerpo de la petición
// (no en la URL, para que no quede en registros ni en el historial). Solo se devuelve una lista blanca de datos.
export const config = { path: ["/api/cliente", "/api/cliente/foto", "/api/cliente/decision"] };
const CAB = { "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: CAB });

const handler = async (req) => {
  if (req.method !== "POST") return json({ error: "No encontrado" }, 404);
  const body = await req.json().catch(() => ({})), token = String(body.token || ""), t = T("main");
  const kIp = "rl/cli/" + sha(ipDe(req)), min = await bloqueado(kIp);
  if (min) return json({ error: `Demasiados intentos. Prueba de nuevo en ${min} min.` }, 429);
  const malo = async () => { await fallo(kIp, 30); return json({ error: "Este enlace no es válido." }, 404); }; // solo los enlaces inventados cuentan como fallo

  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return malo();
  const h = sha(token), e = await t.get("enlaces/" + h);
  if (!e) return malo();
  if (e.exp < Date.now()) return json({ error: "Este enlace ha caducado. Pídele uno nuevo al taller." }, 410);
  const act = await t.get("enlaceorden/" + e.orden);
  if (!act || act.h !== h) return malo(); // regenerado o anulado
  const o = await t.get("ordenes/" + e.orden);
  if (!o) return malo();
  const fotos = [o.foto, ...(o.fotos || [])].filter(Boolean);

  if (new URL(req.url).pathname.endsWith("/foto")) {
    const id = String(body.id || "");
    if (!fotos.includes(id)) return json({ error: "No existe" }, 404); // solo fotos de ESTA orden
    const f = await t.get("fotos/" + id);
    if (!f) return json({ error: "No existe" }, 404);
    return new Response(Buffer.from(f.d, "base64"), { headers: { "content-type": "image/jpeg", "cache-control": "private, no-store", "referrer-policy": "no-referrer" } });
  }

  const ruta = new URL(req.url).pathname;
  const resumen = (d) => d && { resultado: d.resultado, fecha: d.fecha, mensaje: d.mensaje }; // al cliente nunca se le devuelve la IP ni el navegador

  // Aprobar o rechazar UNA versión concreta del presupuesto.
  //  · Solo la versión vigente (la última enviada) y solo una vez: la escritura es condicional (ETag), así que dos respuestas
  //    a la vez (doble toque, dos móviles) no pueden ganar las dos; la segunda ve que ya está decidido.
  //  · Se guarda dentro de la propia versión: fecha y hora, IP, navegador, mensaje, número de versión y su huella.
  //    Las líneas y el total de la versión no se tocan (siguen siendo inmutables).
  if (ruta.endsWith("/decision")) {
    const n = body.n, accion = body.decision, huella = String(body.huella || "");
    if (!Number.isInteger(n) || !/^[a-f0-9]{64}$/.test(huella) || !["aprobar", "rechazar"].includes(accion)) return json({ error: "Petición no válida." }, 400);
    const mensaje = String(body.mensaje ?? "").trim().slice(0, 500), ip = ipDe(req), ua = (req.headers.get("user-agent") || "").slice(0, 300);
    const r = await t.mutate("ordenes/" + e.orden, (ord) => {
      if (!ord) return { out: [404, { error: "Este enlace no es válido." }] };
      const vs = ord.presV || [], i = vs.findIndex((q) => q.n === n), x = vs[i];
      if (!x || x.huella !== huella) return { out: [409, { error: "Este presupuesto ya no está disponible. Recarga la página." }] };
      if (x.dec) return { out: [409, { error: "Este presupuesto ya tiene tu respuesta.", decision: resumen(x.dec) }] };
      if (i !== vs.length - 1) return { out: [409, { error: "El taller ha enviado un presupuesto más reciente. Recarga la página para verlo." }] };
      const ahora = Date.now(), rv = (ord.rev || 0) + 1;
      const dec = { resultado: accion === "aprobar" ? "aprobado" : "rechazado", fecha: ahora, mensaje, ip, ua, n: x.n, huella: x.huella };
      const nuevo = { ...ord, presV: vs.map((q, j) => (j === i ? { ...q, dec } : q)), rev: rv, fr: { ...(ord.fr || {}), presV: rv }, fp: { ...(ord.fp || {}), presV: "cliente" }, mod: ahora, modPor: "cliente" };
      return { write: nuevo, out: [200, { ok: true, decision: resumen(dec) }] };
    });
    return json(r[1], r[0]);
  }

  const v = (o.presV || []).at(-1);
  return json({
    cliente: o.cli, vehiculo: { mat: o.mat, marca: o.marca, modelo: o.modelo, anio: o.anio },
    estado: o.estado, motivos: [...(o.mot || []), o.otro].filter(Boolean), notas: o.notas || "", fotos,
    linea: (o.hist || [{ estado: o.estado, fecha: o.creado, aprox: true }]).map(({ estado, fecha, aprox }) => ({ estado, fecha, aprox: !!aprox })),
    presupuesto: v ? { n: v.n, huella: v.huella, lineas: v.lineas, base: v.base, iva: v.iva, total: v.total, enviada: v.enviada, decision: resumen(v.dec) || null } : null,
    vence: act.exp,
  });
};
export default async (req) => {
  try { return await handler(req); }
  catch (e) { console.error(e); return json({ error: "Algo ha fallado. Inténtalo de nuevo en un momento." }, 500); }
};
