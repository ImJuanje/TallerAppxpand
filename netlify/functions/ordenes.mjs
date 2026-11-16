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

const ALTA = ["mat", "marca", "modelo", "anio", "km", "cli", "tel", "otro", "mot", "foto", "mec"];

export default async (req) => {
  const ses = exigir(req); // admin o mecánico
  if (!ses) return json({ error: "No autorizado" }, 403);
  const adm = ses.rol === "admin", t = T("main"), url = new URL(req.url);
  const p = url.pathname.split("/").filter(Boolean); // [api, ordenes|fotos, id?]
  if (!adm) { // una baja corta el acceso aunque la cookie siga viva
    const u = await t.get("usuarios/" + ses.usuario);
    if (!u || u.activo === false) return json({ error: "No autorizado" }, 403);
  }
  // El mecánico solo ve fotos que subió él o que pertenecen a una orden asignada a él
  const puedeVer = async (id) => {
    const m = await t.get("fotosmeta/" + id);
    if (m?.por === ses.usuario) return true;
    const tiene = (o) => o && o.mec === ses.usuario && (o.foto === id || (o.fotos || []).includes(id));
    if (m?.orden && tiene(await t.get("ordenes/" + m.orden))) return true;
    // foto antigua o aún sin enlazar: se busca entre sus órdenes y se recuerda
    const mias = (await Promise.all((await t.list("ordenes/")).map((k) => t.get(k)))).filter(tiene);
    if (!mias.length) return false;
    await t.put("fotosmeta/" + id, { por: m?.por || "", orden: mias[0].id });
    return true;
  };
  const body = ["POST", "PUT"].includes(req.method) ? await req.json().catch(() => ({})) : {};

  if (p[1] === "fotos") {
    if (req.method === "POST") {
      const d = String(body.data || ""), pre = "data:image/jpeg;base64,";
      if (!d.startsWith(pre) || d.length > 1.6e6) return json({ error: "Foto no válida o demasiado grande" }, 400);
      const id = nuevoId();
      await t.put("fotos/" + id, { d: d.slice(pre.length) });
      await t.put("fotosmeta/" + id, { por: ses.usuario, orden: "" }); // quién la subió y a qué orden pertenece
      return json({ id });
    }
    const f = ID.test(p[2] || "") && (await t.get("fotos/" + p[2]));
    if (!f) return json({ error: "No existe" }, 404);
    if (!adm && !(await puedeVer(p[2]))) return json({ error: "No autorizado" }, 403);
    return new Response(Buffer.from(f.d, "base64"), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
  }

  if (req.method === "GET" && !p[2]) {
    const todas = (await Promise.all((await t.list("ordenes/")).map((k) => t.get(k)))).filter(Boolean).sort((a, b) => b.creado - a.creado);
    const mat = CAMPOS.mat(url.searchParams.get("mat") || "");
    if (mat) { // autorrelleno al dar de alta un coche que ya ha venido
      const o = todas.find((x) => x.mat === mat);
      return json(o ? { marca: o.marca, modelo: o.modelo, anio: o.anio, cli: o.cli, tel: o.tel } : {});
    }
    if (adm) return json(todas);
    // Mecánico: solo las matrículas que tiene ahora en su tablero (sin entregar) y el historial de esas matrículas
    const mats = new Set(todas.filter((o) => o.mec === ses.usuario && o.estado !== "Entregado").map((o) => o.mat));
    return json(todas.filter((o) => mats.has(o.mat)));
  }
  if (req.method === "POST" && !p[2]) {
    // El mecánico solo da de alta el vehículo, y queda asignado a él
    const datos = adm ? body : { ...body, mec: ses.usuario };
    const o = { estado: "Recibido", mec: "", notas: "", fotos: [], pres: [], vb: "", foto: "", otro: "", mot: [], ...limpia(datos, adm ? undefined : ALTA) };
    if (!adm && o.foto && (await t.get("fotosmeta/" + o.foto))?.por !== ses.usuario) o.foto = ""; // no puede usar fotos ajenas
    if (!o.mat || !o.marca || (!o.mot.length && !o.otro)) return json({ error: "Faltan datos de la entrada" }, 400);
    o.id = nuevoId(); o.creado = Date.now();
    o.fecha = new Date().toLocaleDateString("es-ES", { timeZone: "Europe/Madrid" });
    await t.put("ordenes/" + o.id, o);
    return json(o, 201);
  }
  if (req.method === "PUT" && ID.test(p[2] || "")) {
    const o = await t.get("ordenes/" + p[2]);
    if (!o) return json({ error: "No existe" }, 404);
    if (!adm && o.mec !== ses.usuario) return json({ error: "No autorizado" }, 403);
    const c = limpia(body, adm ? ["estado", "mec", "notas", "pres", "vb", "fotos"] : ["estado", "notas", "pres", "vb", "fotos"]);
    if (!adm && c.fotos) { // solo puede añadir fotos que subió él
      for (const id of c.fotos.filter((x) => !(o.fotos || []).includes(x)))
        if ((await t.get("fotosmeta/" + id))?.por !== ses.usuario) return json({ error: "Foto no válida" }, 403);
    }
    if (!adm) { // sin permiso, el mecánico no puede cerrar ni dejar aprobado un presupuesto por su cuenta
      const aj = { vistoBuenoActivo: false, ...(await t.get("ajustes")) }, u = await t.get("usuarios/" + ses.usuario);
      if (aj.vistoBuenoActivo && !u?.libre) {
        const cambiaPres = c.pres && JSON.stringify(c.pres) !== JSON.stringify(o.pres);
        if (cambiaPres || (c.vb === "ok" && o.vb !== "ok")) c.vb = c.vb === "ok" || c.vb === "pendiente" ? "pendiente" : "";
      }
    }
    Object.assign(o, c);
    await t.put("ordenes/" + o.id, o);
    return json(o);
  }
  return json({ error: "No encontrado" }, 404);
};
