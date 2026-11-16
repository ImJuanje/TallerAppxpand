import { timingSafeEqual } from "node:crypto";
import { g, T } from "./_lib/store.mjs";
import { hashPass, checkPass, sha, crearCookie, borrarCookie, sesion } from "./_lib/auth.mjs";

export const config = { path: "/api/auth/*" };
const json = (o, status = 200, h = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...h } });
const igual = (a, b) => timingSafeEqual(Buffer.from(sha(String(a)), "hex"), Buffer.from(sha(String(b)), "hex"));
const MAL = "Usuario o contraseña incorrectos";
const USER_OK = /^[a-z0-9._-]{3,30}$/;

export default async (req) => {
  const accion = new URL(req.url).pathname.split("/").pop();
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  if (accion === "login" && req.method === "POST") {
    const usuario = String(body.usuario || "").trim().toLowerCase(), pw = String(body.password || "");
    const ADM = (process.env.ADMIN_USER || "").trim().toLowerCase();
    // Admin: usuario y contraseña de las variables de entorno de Netlify
    if (ADM && usuario === ADM) {
      if (!igual(pw, process.env.ADMIN_PASSWORD || "")) return json({ error: MAL }, 401);
      return json({ ok: true, rol: "admin" }, 200, { "set-cookie": crearCookie({ usuario: "admin", taller: "main", rol: "admin" }, !!body.mantener) });
    }
    // Mecánico: cuenta creada al activar un código de alta
    const l = USER_OK.test(usuario) && (await g.get("login/" + usuario));
    const u = l && (await T("main").get("usuarios/" + usuario));
    if (!u || !u.activo || !checkPass(pw, u.pass)) return json({ error: MAL }, 401);
    return json({ ok: true, rol: "mecanico" }, 200, { "set-cookie": crearCookie({ usuario, taller: "main", rol: "mecanico" }, !!body.mantener) });
  }

  if (accion === "logout") return json({ ok: true }, 200, { "set-cookie": borrarCookie() });

  if (accion === "yo") {
    const s = sesion(req);
    if (!s) return json({ error: "Sin sesión" }, 401);
    if (s.rol === "mecanico") { // una baja corta el acceso aunque la cookie siga viva
      const u = await T("main").get("usuarios/" + s.usuario);
      if (!u || !u.activo) return json({ error: "Cuenta desactivada" }, 401, { "set-cookie": borrarCookie() });
    }
    return json({ usuario: s.usuario, rol: s.rol });
  }

  // Activación de cuenta con código de alta
  if (accion === "activar" && req.method === "POST") {
    const usuario = String(body.usuario || "").trim().toLowerCase();
    if (!USER_OK.test(usuario) || String(body.password || "").length < 8)
      return json({ error: "Usuario (3-30 caracteres, sin espacios) y contraseña (mínimo 8) no válidos" }, 400);
    if (usuario === "admin" || usuario === (process.env.ADMIN_USER || "").trim().toLowerCase())
      return json({ error: "Ese usuario no está disponible" }, 409);
    const ck = "codigo/" + sha(String(body.codigo || "").trim().toUpperCase());
    const c = await g.get(ck);
    if (!c || c.exp < Date.now()) return json({ error: "Código no válido o caducado" }, 400);
    if (!(await g.putNew("login/" + usuario, { taller: "main" }))) return json({ error: "Ese usuario ya existe" }, 409);
    await T("main").put("usuarios/" + usuario, { usuario, nombre: c.nombre, rol: "mecanico", activo: true, libre: false, pass: hashPass(body.password) });
    await g.del(ck); // el código se usa una sola vez
    return json({ ok: true });
  }
  return json({ error: "No encontrado" }, 404);
};
