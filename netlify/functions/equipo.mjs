import { g, T } from "./_lib/store.mjs";
import { exigir, sha, nuevoCodigo, vigente } from "./_lib/auth.mjs";

export const config = { path: ["/api/equipo", "/api/equipo/*", "/api/ajustes"] };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const USER_OK = /^[a-z0-9._-]{3,30}$/;
const MOTIVOS = ["Revisión", "Aceite y filtros", "Frenos", "Neumáticos", "Diagnóstico de avería", "Aire acondicionado", "Embrague", "Distribución", "Sistema eléctrico", "Carrocería"];

const handler = async (req) => {
  const ses = exigir(req);
  if (!ses) return json({ error: "No autorizado" }, 403);
  const t = T("main"), p = new URL(req.url).pathname.split("/").filter(Boolean); // [api, equipo|ajustes, x?]
  // Los mecánicos solo pueden LEER los ajustes (motivos y visto bueno)
  if (ses.rol !== "admin") {
    if (!(p[1] === "ajustes" && req.method === "GET")) return json({ error: "No autorizado" }, 403);
    if (!(await vigente(ses, t))) return json({ error: "No autorizado" }, 403); // una baja o un cambio de contraseña cortan el acceso aunque la cookie siga viva
  }
  const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await req.json().catch(() => ({})) : {};

  if (p[1] === "ajustes") {
    if (req.method === "GET") return json({ vistoBuenoActivo: false, motivos: MOTIVOS, ...(await t.get("ajustes")) });
    if (req.method === "PUT") {
      const a = { vistoBuenoActivo: !!body.vistoBuenoActivo,
        motivos: (Array.isArray(body.motivos) ? body.motivos : []).map((m) => String(m).trim()).filter(Boolean).slice(0, 60) };
      await t.put("ajustes", a);
      return json(a);
    }
  }
  if (p[1] === "equipo") {
    if (!p[2] && req.method === "GET") {
      const us = await Promise.all((await t.list("usuarios/")).map((k) => t.get(k)));
      return json(us.filter(Boolean).map(({ pass, sv, ...u }) => u));
    }
    if (p[2] === "codigo" && req.method === "POST") {
      const codigo = nuevoCodigo();
      await g.put("codigo/" + sha(codigo), { taller: "main", rol: "mecanico", nombre: String(body.nombre || "").trim(), creado: Date.now(), exp: Date.now() + 7 * 864e5 });
      return json({ codigo });
    }
    if (p[2] === "invitaciones") {
      if (req.method === "GET" && !p[3]) {
        const ahora = Date.now();
        const cs = (await Promise.all((await g.list("codigo/")).map(async (k) => { const c = await g.get(k); return c && c.taller === "main" ? { id: k.slice(7), ...c } : null; }))).filter(Boolean);
        return json(cs.map((c) => ({ id: c.id, nombre: c.nombre || "", estado: c.usado ? "usada" : c.exp < ahora ? "caducada" : "pendiente",
          creado: c.creado || c.exp - 7 * 864e5, exp: c.exp, usuario: c.usuario || "" })).sort((a, b) => b.creado - a.creado).slice(0, 50));
      }
      if (req.method === "POST" && /^[a-f0-9]{64}$/.test(p[3] || "") && ["anular", "regenerar"].includes(p[4])) {
        const k = "codigo/" + p[3], c = await g.get(k);
        if (!c || c.taller !== "main") return json({ error: "No existe" }, 404);
        if (c.usado) return json({ error: "Esa invitación ya se usó" }, 409);
        await g.del(k);
        if (p[4] === "anular") return json({ ok: true });
        const codigo = nuevoCodigo();
        await g.put("codigo/" + sha(codigo), { taller: "main", rol: "mecanico", nombre: c.nombre || "", creado: Date.now(), exp: Date.now() + 7 * 864e5 });
        return json({ codigo });
      }
    }
    // Restablecer la contraseña de un mecánico que la ha olvidado: se genera un código de un solo uso (24 h).
    // El admin no llega a conocer la contraseña nueva; la elige el mecánico en la pantalla de acceso.
    if (USER_OK.test(p[2] || "") && p[3] === "reset" && req.method === "POST") {
      const u = await t.get("usuarios/" + p[2]);
      if (!u) return json({ error: "No existe" }, 404);
      if (u.activo === false) return json({ error: "Ese mecánico está de baja. Reactívalo primero." }, 409);
      const codigo = nuevoCodigo(), exp = Date.now() + 864e5;
      await g.put("reset/" + sha(p[2]), { hash: sha(codigo), exp, creado: Date.now() }); // pisa cualquier código anterior de ese usuario
      return json({ codigo, exp });
    }
    if (USER_OK.test(p[2] || "") && !p[3] && req.method === "PATCH") {
      const r = await t.mutate("usuarios/" + p[2], (u) => {
        if (!u) return { out: false };
        const n = { ...u };
        if ("libre" in body) n.libre = !!body.libre;
        if ("activo" in body) n.activo = !!body.activo;
        return { write: n, out: true };
      });
      return r ? json({ ok: true }) : json({ error: "No existe" }, 404);
    }
  }
  return json({ error: "No encontrado" }, 404);
};

export default async (req) => {
  try { return await handler(req); }
  catch (e) { console.error(e); return json({ error: "Error del servidor: " + (e?.message || e) }, 500); }
};
