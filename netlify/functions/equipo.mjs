import { g, T } from "./_lib/store.mjs";
import { exigir, sha, nuevoCodigo } from "./_lib/auth.mjs";

export const config = { path: ["/api/equipo", "/api/equipo/*", "/api/ajustes"] };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const MOTIVOS = ["Revisión", "Aceite y filtros", "Frenos", "Neumáticos", "Diagnóstico de avería", "Aire acondicionado", "Embrague", "Distribución", "Sistema eléctrico", "Carrocería"];

const handler = async (req) => {
  if (!exigir(req, "admin")) return json({ error: "No autorizado" }, 403);
  const t = T("main"), p = new URL(req.url).pathname.split("/").filter(Boolean); // [api, equipo|ajustes, x?]
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
      await g.put("codigo/" + sha(codigo), { taller: "main", rol: "mecanico", nombre: String(body.nombre || "").trim(), exp: Date.now() + 7 * 864e5 });
      return json({ codigo });
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
