import { T } from "./_lib/store.mjs";
import { exigir } from "./_lib/auth.mjs";

export const config = { path: ["/api/ordenes", "/api/ordenes/*", "/api/fotos", "/api/fotos/*"] };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const ESTADOS = ["Recibido", "Diagnóstico", "Esperando aprobación", "En reparación", "Listo", "Entregado"];
const ID = /^[a-z0-9]{6,40}$/, s = (v, n = 200) => String(v ?? "").trim().slice(0, n);
const arr = (v) => (Array.isArray(v) ? v : []);

// Solo se aceptan estos campos y con estos tipos
const CAMPOS = {
  mat: (v) => s(v, 12).toUpperCase().replace(/\s/g, ""), marca: (v) => s(v, 40), modelo: (v) => s(v, 40),
  anio: (v) => +v || 0, km: (v) => +v || 0, cli: (v) => s(v, 80), tel: (v) => s(v, 25), otro: (v) => s(v, 120),
  notas: (v) => s(v, 4000), mec: (v) => s(v, 30), foto: (v) => (ID.test(v) ? v : ""),
  mot: (v) => arr(v).map((x) => s(x, 60)).filter(Boolean).slice(0, 20),
  estado: (v) => (ESTADOS.includes(v) ? v : "Recibido"),
  vb: (v) => (["", "pendiente", "ok"].includes(v) ? v : ""),
  fotos: (v) => arr(v).filter((x) => ID.test(x)).slice(0, 40),
  pres: (v) => arr(v).slice(0, 100).map((l) => ({ c: s(l?.c, 120), t: l?.t == "Pieza" ? "Pieza" : "Mano de obra", i: Math.max(0, +l?.i || 0) })),
};
const limpia = (b, solo) => Object.fromEntries(Object.keys(CAMPOS).filter((k) => k in b && (!solo || solo.includes(k))).map((k) => [k, CAMPOS[k](b[k])]));
const nuevoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export default async (req) => {
  if (!exigir(req, "admin")) return json({ error: "No autorizado" }, 403);
  const t = T("main"), p = new URL(req.url).pathname.split("/").filter(Boolean); // [api, ordenes|fotos, id?]
  const body = ["POST", "PUT"].includes(req.method) ? await req.json().catch(() => ({})) : {};

  if (p[1] === "fotos") {
    if (req.method === "POST") {
      const d = String(body.data || ""), pre = "data:image/jpeg;base64,";
      if (!d.startsWith(pre) || d.length > 1.6e6) return json({ error: "Foto no válida o demasiado grande" }, 400);
      const id = nuevoId();
      await t.put("fotos/" + id, { d: d.slice(pre.length) });
      return json({ id });
    }
    const f = ID.test(p[2] || "") && (await t.get("fotos/" + p[2]));
    if (!f) return json({ error: "No existe" }, 404);
    return new Response(Buffer.from(f.d, "base64"), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
  }

  if (req.method === "GET" && !p[2]) {
    const os = await Promise.all((await t.list("ordenes/")).map((k) => t.get(k)));
    return json(os.filter(Boolean).sort((a, b) => b.creado - a.creado));
  }
  if (req.method === "POST" && !p[2]) {
    const o = { estado: "Recibido", mec: "", notas: "", fotos: [], pres: [], vb: "", foto: "", otro: "", mot: [], ...limpia(body) };
    if (!o.mat || !o.marca || (!o.mot.length && !o.otro)) return json({ error: "Faltan datos de la entrada" }, 400);
    o.id = nuevoId(); o.creado = Date.now();
    o.fecha = new Date().toLocaleDateString("es-ES", { timeZone: "Europe/Madrid" });
    await t.put("ordenes/" + o.id, o);
    return json(o, 201);
  }
  if (req.method === "PUT" && ID.test(p[2] || "")) {
    const o = await t.get("ordenes/" + p[2]);
    if (!o) return json({ error: "No existe" }, 404);
    Object.assign(o, limpia(body, ["estado", "mec", "notas", "pres", "vb", "fotos"]));
    await t.put("ordenes/" + o.id, o);
    return json(o);
  }
  return json({ error: "No encontrado" }, 404);
};
