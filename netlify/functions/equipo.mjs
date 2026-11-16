import { g, T } from "./_lib/store.mjs";
import { exigir, sha, nuevoCodigo } from "./_lib/auth.mjs";

export const config = { path: ["/api/equipo", "/api/equipo/*", "/api/ajustes"] };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const MOTIVOS = ["Revisión", "Aceite y filtros", "Frenos", "Neumáticos", "Diagnóstico de avería", "Aire acondicionado", "Embrague", "Distribución", "Sistema eléctrico", "Carrocería"];

const handler = async (req) => {
  const ses = exigir(req);
  if (!ses) return json({ error: "No autorizado" }, 403);
  const t = T("main"), p = new URL(req.url).pathname.split("/").filter(Boolean); // [api, equipo|ajustes, x?]
  // Los mecánicos solo pueden LEER los ajustes (motivos y visto bueno)
  if (ses.rol !== "admin") {
    if (!(p[1] === "ajustes" && req.method === "GET")) return json({ error: "No autorizado" }, 403);
    const u = await t.get("usuarios/" + ses.usuario); // una baja corta el acceso aunque la cookie siga viva
    if (!u || u.activo === false) return json({ error: "No autorizado" }, 403);
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
      return json(us.filter(Boolean).map(({ pass, ...u }) => u));
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
    if (p[2] && req.method === "PATCH") {
      const u = await t.get("usuarios/" + p[2]);
      if (!u) return json({ error: "No existe" }, 404);
      if ("libre" in body) u.libre = !!body.libre;
      if ("activo" in body) u.activo = !!body.activo;
      await t.put("usuarios/" + p[2], u);
      return json({ ok: true });
    }
  }
  return json({ error: "No encontrado" }, 404);
};

export default async (req) => {
  try { return await handler(req); }
  catch (e) { console.error(e); return json({ error: "Error del servidor: " + (e?.message || e) }, 500); }
};
