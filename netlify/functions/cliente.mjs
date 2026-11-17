import { T } from "./_lib/store.mjs";
import { sha } from "./_lib/auth.mjs";
import { ipDe, bloqueado, fallo } from "./_lib/limite.mjs";

// Portal del cliente: público (sin sesión), SOLO LECTURA. Se entra con el token del enlace, que va en el cuerpo de la petición
// (no en la URL, para que no quede en registros ni en el historial). Solo se devuelve una lista blanca de datos.
export const config = { path: ["/api/cliente", "/api/cliente/foto"] };
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

  const v = (o.presV || []).at(-1);
  return json({
    cliente: o.cli, vehiculo: { mat: o.mat, marca: o.marca, modelo: o.modelo, anio: o.anio },
    estado: o.estado, motivos: [...(o.mot || []), o.otro].filter(Boolean), notas: o.notas || "", fotos,
    linea: (o.hist || [{ estado: o.estado, fecha: o.creado, aprox: true }]).map(({ estado, fecha, aprox }) => ({ estado, fecha, aprox: !!aprox })),
    presupuesto: v ? { n: v.n, lineas: v.lineas, base: v.base, iva: v.iva, total: v.total, enviada: v.enviada } : null,
    vence: act.exp,
  });
};
export default async (req) => {
  try { return await handler(req); }
  catch (e) { console.error(e); return json({ error: "Algo ha fallado. Inténtalo de nuevo en un momento." }, 500); }
};
