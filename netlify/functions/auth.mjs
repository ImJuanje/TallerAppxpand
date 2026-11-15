import { timingSafeEqual } from "node:crypto";
import { g, T } from "./_lib/store.mjs";
import { hashPass, sha, crearCookie, borrarCookie, sesion } from "./_lib/auth.mjs";

export const config = { path: "/api/auth/*" };
const json = (o, status = 200, h = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...h } });
// comparación en tiempo constante
const igual = (a, b) => timingSafeEqual(Buffer.from(sha(String(a)), "hex"), Buffer.from(sha(String(b)), "hex"));

export default async (req) => {
  const accion = new URL(req.url).pathname.split("/").pop();
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  // Admin: usuario y contraseña definidos en las variables de entorno de Netlify
  if (accion === "login" && req.method === "POST") {
    const okU = igual(String(body.usuario || "").trim().toLowerCase(), (process.env.ADMIN_USER || "").toLowerCase());
    const okP = igual(body.password || "", process.env.ADMIN_PASSWORD || "");
    if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD || !(okU && okP))
      return json({ error: "Usuario o contraseña incorrectos" }, 401);
    return json({ ok: true, rol: "admin" }, 200, { "set-cookie": crearCookie({ usuario: "admin", taller: "main", rol: "admin" }, !!body.mantener) });
  }
  if (accion === "logout") return json({ ok: true }, 200, { "set-cookie": borrarCookie() });
  if (accion === "yo") {
    const s = sesion(req);
    return s ? json({ usuario: s.usuario, rol: s.rol }) : json({ error: "Sin sesión" }, 401);
  }

  // Activación de mecánicos con código (sin pantalla todavía; se usará cuando exista la vista de mecánico)
  if (accion === "activar" && req.method === "POST") {
    const usuario = String(body.usuario || "").trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(usuario) || String(body.password || "").length < 8) return json({ error: "Datos no válidos" }, 400);
    const ck = "codigo/" + sha(String(body.codigo || "").trim().toUpperCase());
    const c = await g.get(ck);
    if (!c || c.exp < Date.now()) return json({ error: "Código no válido o caducado" }, 400);
    if (!(await g.putNew("login/" + usuario, { taller: "main" }))) return json({ error: "Ese usuario ya existe" }, 409);
    await T("main").put("usuarios/" + usuario, { usuario, nombre: c.nombre, rol: "mecanico", activo: true, libre: false, pass: hashPass(body.password) });
    await g.del(ck);
    return json({ ok: true });
  }
  return json({ error: "No encontrado" }, 404);
};
