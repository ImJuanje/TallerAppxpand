import { randomBytes } from "node:crypto";
import { T } from "./_lib/store.mjs";
import { exigir, vigente, sha } from "./_lib/auth.mjs";

export const config = { path: ["/api/ordenes", "/api/ordenes/*", "/api/fotos", "/api/fotos/*"] };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const ESTADOS = ["Recibido", "Diagnóstico", "Esperando aprobación", "En reparación", "Listo", "Entregado"];
const ID = /^[a-z0-9]{6,40}$/, s = (v, n = 200) => String(v ?? "").trim().slice(0, n);
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v, max) => Math.min(max, Math.max(0, Math.round(+v || 0)));

// Solo se aceptan estos campos y con estos tipos
const CAMPOS = {
  mat: (v) => s(v, 20).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12), // sin espacios ni guiones: "4821-klm" y "4821 KLM" son la misma matrícula
  marca: (v) => s(v, 40), modelo: (v) => s(v, 40),
  anio: (v) => num(v, 2100), km: (v) => num(v, 9999999), cli: (v) => s(v, 80), tel: (v) => s(v, 25), otro: (v) => s(v, 120),
  notas: (v) => s(v, 4000), mec: (v) => s(v, 30), foto: (v) => (ID.test(v) ? v : ""),
  mot: (v) => arr(v).map((x) => s(x, 60)).filter(Boolean).slice(0, 20),
  estado: (v) => (ESTADOS.includes(v) ? v : "Recibido"),
  vb: (v) => (["", "pendiente", "ok"].includes(v) ? v : ""),
  fotos: (v) => arr(v).filter((x) => ID.test(x)).slice(0, 40),
  pres: (v) => arr(v).slice(0, 100).map((l) => ({ c: s(l?.c, 120), t: l?.t == "Pieza" ? "Pieza" : "Mano de obra", i: Math.max(0, +l?.i || 0) })),
};
const limpia = (b, solo) => Object.fromEntries(Object.keys(CAMPOS).filter((k) => k in b && (!solo || solo.includes(k))).map((k) => [k, CAMPOS[k](b[k])]));
const nuevoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pub = ({ fr, fp, ...o }) => o; // `fr` (versión por campo) y `fp` (quién lo tocó) son internos

// Datos de la entrada: los puede corregir el admin y el mecánico asignado
const DATOS = ["mat", "marca", "modelo", "anio", "km", "cli", "tel", "otro", "mot"];
const ALTA = [...DATOS, "foto", "mec"];
const EDIT_ADMIN = [...DATOS, "estado", "mec", "notas", "pres", "vb", "fotos"];
const EDIT_MEC = [...DATOS, "estado", "notas", "pres", "vb", "fotos"];
const ETIQ = { mat: "la matrícula", marca: "la marca", modelo: "el modelo", anio: "el año", km: "los kilómetros", cli: "el cliente", tel: "el teléfono", otro: "el motivo", mot: "el motivo",
  estado: "el estado", mec: "el mecánico", notas: "las notas", pres: "el presupuesto", vb: "el visto bueno", fotos: "las fotos" };

// Validación de los datos de la entrada (valores ya limpiados). `ks` = solo esos campos (al editar); sin `ks`, todos (al crear).
const errorDatos = (o, ks = DATOS) => {
  const h = (k) => ks.includes(k);
  if (h("mat") && o.mat.length < 3) return "La matrícula no es válida";
  if (h("marca") && !o.marca) return "Falta la marca";
  if (h("cli") && !o.cli) return "Falta el cliente";
  if (h("tel") && ((o.tel.match(/\d/g) || []).length < 6 || !/^[\d\s+().-]+$/.test(o.tel))) return "El teléfono no es válido";
  if (h("anio") && o.anio && (o.anio < 1900 || o.anio > 2100)) return "El año no es válido";
  if ((h("mot") || h("otro")) && !o.mot.length && !o.otro) return "Elige al menos un motivo";
  return "";
};
const POR_DEFECTO = { mat: "", marca: "", modelo: "", anio: 0, km: 0, cli: "", tel: "", otro: "", notas: "", mec: "", vb: "", estado: "Recibido", mot: [], fotos: [], pres: [] };

export default async (req) => {
  try { return await handler(req); }
  catch (e) { console.error(e); return json({ error: "Error del servidor: " + (e?.message || e) }, 500); }
};

const handler = async (req) => {
  const ses = exigir(req); // admin o mecánico
  if (!ses) return json({ error: "No autorizado" }, 403);
  const adm = ses.rol === "admin", t = T("main"), url = new URL(req.url);
  const p = url.pathname.split("/").filter(Boolean); // [api, ordenes|fotos, id?]
  if (!adm && !(await vigente(ses, t))) return json({ error: "No autorizado" }, 403); // una baja o un cambio de contraseña cortan el acceso aunque la cookie siga viva
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
      const o = todas.find((x) => CAMPOS.mat(x.mat) === mat);
      return json(o ? { marca: o.marca, modelo: o.modelo, anio: o.anio, cli: o.cli, tel: o.tel } : {});
    }
    if (adm) return json(todas.map(pub));
    // Mecánico: solo las matrículas que tiene ahora en su tablero (sin entregar) y el historial de esas matrículas
    const mats = new Set(todas.filter((o) => o.mec === ses.usuario && o.estado !== "Entregado").map((o) => o.mat));
    return json(todas.filter((o) => mats.has(o.mat)).map(pub));
  }

  if (req.method === "POST" && !p[2]) {
    // El mecánico solo da de alta el vehículo, y queda asignado a él
    const datos = adm ? body : { ...body, mec: ses.usuario };
    const o = { estado: "Recibido", mec: "", notas: "", fotos: [], pres: [], vb: "", foto: "", otro: "", mot: [], anio: 0, km: 0, tel: "", cli: "", ...limpia(datos, adm ? undefined : ALTA) };
    if (!adm && o.foto && (await t.get("fotosmeta/" + o.foto))?.por !== ses.usuario) o.foto = ""; // no puede usar fotos ajenas
    const err = errorDatos(o);
    if (err) return json({ error: err }, 400);
    o.id = nuevoId(); o.creado = Date.now(); o.rev = 1;
    o.fecha = new Date().toLocaleDateString("es-ES", { timeZone: "Europe/Madrid" });
    o.mod = o.creado; o.modPor = ses.usuario;
    o.hist = [{ estado: o.estado, fecha: o.creado, por: ses.usuario }]; // historial de estados (alimentará la línea de tiempo del cliente)
    await t.put("ordenes/" + o.id, o);
    return json(pub(o), 201);
  }

  // Edición de una orden. El cliente manda `rev` (la versión que tenía en pantalla) y SOLO los campos que cambia.
  //  · Cada campo recuerda en qué versión se tocó por última vez (`fr`). Si alguien lo cambió después de la `rev` del cliente → 409
  //    y se devuelve la orden actual; si han tocado otros campos distintos, no hay conflicto y se fusiona.
  //  · La escritura es condicional (ETag): si otro guarda a la vez, se vuelve a leer y a comprobar (nunca se pisa en silencio).
  //  · Las fotos se fusionan (unión): dos personas subiendo fotos a la vez no se quitan ninguna.
  if (req.method === "PUT" && ID.test(p[2] || "")) {
    if (!Number.isInteger(body.rev) || body.rev < 0) return json({ error: "Falta la versión de la orden. Recarga la página." }, 400);
    const c = limpia(body, adm ? EDIT_ADMIN : EDIT_MEC);
    if ("estado" in c && !ESTADOS.includes(body.estado)) return json({ error: "Estado no válido" }, 400);
    const aj = adm ? null : { vistoBuenoActivo: false, ...(await t.get("ajustes")) }, u = adm ? null : await t.get("usuarios/" + ses.usuario);
    const r = await t.mutate("ordenes/" + p[2], async (o) => {
      if (!o) return { out: [404, { error: "No existe" }] };
      if (!adm && o.mec !== ses.usuario) return { out: [403, { error: "No autorizado" }] };
      const n = { ...c };
      if (!adm && n.fotos) { // solo puede añadir fotos que subió él
        for (const id of n.fotos.filter((x) => !(o.fotos || []).includes(x)))
          if ((await t.get("fotosmeta/" + id))?.por !== ses.usuario) return { out: [403, { error: "Foto no válida" }] };
      }
      if (n.fotos) n.fotos = [...new Set([...(o.fotos || []), ...n.fotos])].slice(0, 40);
      if (!adm && aj.vistoBuenoActivo && !u?.libre) { // sin permiso, el mecánico no puede cerrar ni dejar aprobado un presupuesto por su cuenta
        const cambiaPres = n.pres && JSON.stringify(n.pres) !== JSON.stringify(o.pres);
        if (cambiaPres || (n.vb === "ok" && o.vb !== "ok")) n.vb = n.vb === "ok" || n.vb === "pendiente" ? "pendiente" : "";
      }
      const cambios = Object.keys(n).filter((k) => JSON.stringify(n[k]) !== JSON.stringify(o[k] ?? POR_DEFECTO[k]));
      if (!cambios.length) return { out: [200, pub(o)] };
      const fr = o.fr || {}, fp = o.fp || {};
      const choque = cambios.filter((k) => k !== "fotos" && (fr[k] || 0) > body.rev); // las fotos se fusionan, nunca chocan
      if (choque.length) {
        const quienes = [...new Set(choque.map((k) => fp[k]).filter((x) => x && x !== ses.usuario))];
        const quien = quienes.length ? ` (${quienes.join(", ")})` : "";
        return { out: [409, { error: `Otra persona${quien} ha cambiado ${[...new Set(choque.map((k) => ETIQ[k]))].join(", ")} mientras lo editabas. Se ha cargado la versión actual: revísala y repite tu cambio.`, actual: pub(o) }] };
      }
      const v = (o.rev || 0) + 1, nuevo = { ...o, ...n, rev: v, fr: { ...fr, ...Object.fromEntries(cambios.map((k) => [k, v])) }, fp: { ...fp, ...Object.fromEntries(cambios.map((k) => [k, ses.usuario])) }, mod: Date.now(), modPor: ses.usuario };
      if (cambios.some((k) => DATOS.includes(k))) { // los datos de la entrada tienen que seguir siendo válidos tras la corrección
        const err = errorDatos(nuevo, cambios.filter((k) => DATOS.includes(k)));
        if (err) return { out: [400, { error: err }] };
      }
      if (cambios.includes("estado")) // órdenes anteriores a este cambio: se parte del estado que tenían (fecha aproximada)
        nuevo.hist = [...(o.hist ?? [{ estado: o.estado, fecha: o.creado, aprox: o.estado !== "Recibido" }]), { estado: n.estado, fecha: Date.now(), por: ses.usuario }].slice(-100);
      return { write: nuevo, out: [200, pub(nuevo)] };
    });
    return json(r[1], r[0]);
  }

  // Enlace del cliente (admin o mecánico asignado). El token se muestra UNA vez al generarlo; solo se guarda su huella.
  //  · Caduca a los 30 días. Generar otro anula el anterior (aunque no hubiera caducado). Se puede anular sin sustituirlo.
  if (ID.test(p[2] || "") && p[3] === "enlace") {
    const o = await t.get("ordenes/" + p[2]);
    if (!o) return json({ error: "No existe" }, 404);
    if (!adm && o.mec !== ses.usuario) return json({ error: "No autorizado" }, 403);
    const act = await t.get("enlaceorden/" + p[2]);
    if (req.method === "GET") return json(act && act.exp > Date.now() ? { activo: true, exp: act.exp, creado: act.creado, por: act.por } : { activo: false, caducado: !!act });
    if (req.method === "POST") {
      if (body.accion === "revocar") {
        if (act) { await t.del("enlaces/" + act.h); await t.del("enlaceorden/" + p[2]); }
        return json({ activo: false });
      }
      const token = randomBytes(24).toString("base64url"), h = sha(token), creado = Date.now(), exp = creado + 30 * 864e5;
      await t.put("enlaces/" + h, { orden: p[2], creado, exp });
      await t.put("enlaceorden/" + p[2], { h, creado, exp, por: ses.usuario });
      if (act) await t.del("enlaces/" + act.h);
      return json({ token, exp, activo: true });
    }
  }

  // Enviar el presupuesto al cliente = congelar una VERSIÓN numerada e inmutable de las líneas actuales.
  //  · Solo se puede enviar un presupuesto cerrado/aprobado (vb "ok"): un mecánico sin permiso no llega ahí sin el visto bueno del admin.
  //  · Si las líneas son las mismas que la última versión enviada, no se crea otra (idempotente).
  //  · Si se edita el borrador después, la versión enviada no cambia: hay que enviar una nueva (n+1).
  //  · Misma protección de versiones que al editar: si alguien tocó el presupuesto o el visto bueno después de que lo vieras → 409.
  if (req.method === "POST" && ID.test(p[2] || "") && p[3] === "presupuesto") {
    if (!Number.isInteger(body.rev) || body.rev < 0) return json({ error: "Falta la versión de la orden. Recarga la página." }, 400);
    const r2 = (x) => Math.round(x * 100) / 100;
    const r = await t.mutate("ordenes/" + p[2], (o) => {
      if (!o) return { out: [404, { error: "No existe" }] };
      if (!adm && o.mec !== ses.usuario) return { out: [403, { error: "No autorizado" }] };
      const fr = o.fr || {}, fp = o.fp || {}, choque = ["pres", "vb"].filter((k) => (fr[k] || 0) > body.rev);
      if (choque.length) {
        const quienes = [...new Set(choque.map((k) => fp[k]).filter((x) => x && x !== ses.usuario))];
        return { out: [409, { error: `Otra persona${quienes.length ? ` (${quienes.join(", ")})` : ""} ha cambiado ${[...new Set(choque.map((k) => ETIQ[k]))].join(" y ")} mientras lo mirabas. Se ha cargado la versión actual: revísala y vuelve a enviar.`, actual: pub(o) }] };
      }
      const lineas = (o.pres || []).map((l) => ({ c: l.c, t: l.t, i: l.i }));
      if (!lineas.length) return { out: [400, { error: "El presupuesto está vacío" }] };
      if (o.vb !== "ok") return { out: [400, { error: "El presupuesto aún no está cerrado ni aprobado" }] };
      const huella = sha(JSON.stringify(lineas.map((l) => [l.c, l.t, l.i]))), vs = o.presV || [], ult = vs[vs.length - 1];
      if (ult && ult.huella === huella) return { out: [200, pub(o)] };
      if (vs.length >= 20) return { out: [400, { error: "Demasiadas versiones enviadas de este presupuesto" }] };
      const base = lineas.reduce((a, l) => a + (+l.i || 0), 0), v = (o.rev || 0) + 1;
      const ver = { n: (ult?.n || 0) + 1, lineas, base: r2(base), iva: r2(base * 0.21), total: r2(base * 1.21), huella, enviada: Date.now(), por: ses.usuario };
      const nuevo = { ...o, presV: [...vs, ver], rev: v, fr: { ...fr, presV: v }, fp: { ...fp, presV: ses.usuario }, mod: Date.now(), modPor: ses.usuario };
      return { write: nuevo, out: [200, pub(nuevo)] };
    });
    return json(r[1], r[0]);
  }
  return json({ error: "No encontrado" }, 404);
};
