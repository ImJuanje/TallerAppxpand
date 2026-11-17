import { g, T } from "./_lib/store.mjs";
import { hashPass, checkPass, sha, igual, crearCookie, borrarCookie, sesion, vigente } from "./_lib/auth.mjs";

export const config = { path: "/api/auth/*" };
const json = (o, status = 200, h = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...h } });
const MAL = "Usuario o contraseña incorrectos";
const USER_OK = /^[a-z0-9._-]{3,30}$/;
const PW_MIN = 8, PW_MAX = 200;
const pwOk = (p) => typeof p === "string" && p.length >= PW_MIN && p.length <= PW_MAX;
// Hash de relleno: si el usuario no existe se hace el mismo trabajo, para que el tiempo de respuesta no delate qué usuarios existen
const RELLENO = hashPass("relleno-" + Math.random());

// Límite de intentos: tras demasiados fallos se bloquea 15 min. Se cuenta por (IP + usuario) y por IP,
// así quien falla no puede dejar fuera al admin desde otra conexión.
// Los contadores se actualizan con escritura condicional: dos intentos simultáneos no se "pisan" y no se cuela ninguno.
const VENTANA = 15 * 60 * 1000;
const ipDe = (req) => req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "desconocida";
const bloqueado = async (...ks) => {
  for (const k of ks) { const r = await g.get(k); if (r?.hasta > Date.now()) return Math.ceil((r.hasta - Date.now()) / 60000); }
  return 0;
};
const fallo = (k, max) => g.mutate(k, (r) => {
  const ahora = Date.now(), c = r && ahora - r.desde <= VENTANA ? { ...r } : { n: 0, desde: ahora };
  c.n++; if (c.n >= max) c.hasta = ahora + VENTANA;
  return { write: c, out: c };
});
const espera = (min) => json({ error: `Demasiados intentos. Prueba de nuevo en ${min} min.` }, 429);

const handler = async (req) => {
  const accion = new URL(req.url).pathname.split("/").pop();
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  if (accion === "login" && req.method === "POST") {
    const usuario = String(body.usuario || "").trim().toLowerCase(), pw = String(body.password || "").slice(0, PW_MAX);
    const ip = ipDe(req), kPar = "rl/" + sha(ip + "|" + usuario), kIp = "rl/" + sha(ip);
    const min = await bloqueado(kPar, kIp);
    if (min) return espera(min);
    const mal = async () => { await fallo(kPar, 5); await fallo(kIp, 20); return json({ error: MAL }, 401); };
    const ADM = (process.env.ADMIN_USER || "").trim().toLowerCase(), ADM_PW = process.env.ADMIN_PASSWORD || "";
    // Admin: usuario y contraseña de las variables de entorno de Netlify. Sin contraseña configurada no se puede entrar como admin.
    if (ADM && usuario === ADM) {
      if (!ADM_PW || !igual(pw, ADM_PW)) return mal();
      await g.del(kPar);
      return json({ ok: true, rol: "admin" }, 200, { "set-cookie": crearCookie({ usuario: "admin", taller: "main", rol: "admin" }, !!body.mantener) });
    }
    // Mecánico: cuenta creada al activar un código de alta
    const u = USER_OK.test(usuario) && (await T("main").get("usuarios/" + usuario));
    let passOk = false;
    try { passOk = checkPass(pw, u && typeof u.pass === "string" ? u.pass : RELLENO) && !!u && typeof u.pass === "string"; } catch (e) { console.error("checkPass", e); }
    if (!u || u.activo === false || !passOk) return mal();
    await g.del(kPar);
    return json({ ok: true, rol: "mecanico" }, 200, { "set-cookie": crearCookie({ usuario, taller: "main", rol: "mecanico", sv: u.sv || 0 }, !!body.mantener) });
  }

  if (accion === "logout") return json({ ok: true }, 200, { "set-cookie": borrarCookie() });

  if (accion === "yo") {
    const s = sesion(req);
    if (!s) return json({ error: "Sin sesión" }, 401);
    let extra = {};
    if (s.rol === "mecanico") {
      const u = await vigente(s, T("main"));
      if (!u) return json({ error: "Cuenta desactivada o sesión caducada" }, 401, { "set-cookie": borrarCookie() });
      extra = { nombre: u.nombre || s.usuario, libre: !!u.libre };
    }
    return json({ usuario: s.usuario, rol: s.rol, ...extra });
  }

  // Activación de cuenta con código de alta
  if (accion === "activar" && req.method === "POST") {
    const kAct = "rl/act/" + sha(ipDe(req)), minAct = await bloqueado(kAct);
    if (minAct) return espera(minAct);
    const usuario = String(body.usuario || "").trim().toLowerCase();
    if (!USER_OK.test(usuario) || !pwOk(body.password))
      return json({ error: "Usuario (3-30 caracteres, sin espacios) y contraseña (8-200 caracteres) no válidos" }, 400);
    if (["admin", "codigo", "invitaciones"].includes(usuario) || usuario === (process.env.ADMIN_USER || "").trim().toLowerCase()) // nombres reservados (coinciden con rutas de la API)
      return json({ error: "Ese usuario no está disponible" }, 409);
    const ck = "codigo/" + sha(String(body.codigo || "").trim().toUpperCase());
    const c = await g.get(ck);
    if (!c || c.usado || c.exp < Date.now()) { await fallo(kAct, 10); return json({ error: "Código no válido o caducado" }, 400); }
    // Se crea el usuario de forma atómica: si ya existe, no se pisa
    const creado = await T("main").putNew("usuarios/" + usuario, { usuario, nombre: c.nombre, rol: "mecanico", activo: true, libre: false, sv: 0, pass: hashPass(String(body.password)) });
    if (!creado) return json({ error: "Ese usuario ya existe" }, 409);
    await g.put("login/" + usuario, { taller: "main" }); // índice (ya no es necesario para entrar)
    await g.put(ck, { ...c, usado: Date.now(), usuario }); // se usa una sola vez; queda registrado como usada
    return json({ ok: true });
  }

  // Restablecer contraseña olvidada con el código que genera el admin en Equipo (un solo uso, caduca en 24 h)
  if (accion === "restablecer" && req.method === "POST") {
    const usuario = String(body.usuario || "").trim().toLowerCase();
    const kIp = "rl/rst/" + sha(ipDe(req)), kUs = "rl/rst/u/" + sha(usuario);
    const min = await bloqueado(kIp, kUs);
    if (min) return espera(min);
    if (!pwOk(body.password)) return json({ error: "La contraseña nueva debe tener entre 8 y 200 caracteres" }, 400);
    const rk = "reset/" + sha(usuario), r = USER_OK.test(usuario) ? await g.get(rk) : null;
    const codigoOk = !!r && r.exp > Date.now() && igual(sha(String(body.codigo || "").trim().toUpperCase()), r.hash);
    if (!codigoOk) { await fallo(kIp, 10); await fallo(kUs, 10); return json({ error: "Código no válido o caducado" }, 400); }
    const hecho = await T("main").mutate("usuarios/" + usuario, (u) =>
      !u || u.activo === false ? { out: false }
        : { write: { ...u, pass: hashPass(String(body.password)), sv: (u.sv || 0) + 1 }, out: true }); // sv+1: cierra todas sus sesiones abiertas
    await g.del(rk); // un solo uso
    if (!hecho) return json({ error: "Código no válido o caducado" }, 400);
    await g.del("rl/" + sha(ipDe(req) + "|" + usuario)); // desbloquea el login de ese usuario desde esta conexión
    return json({ ok: true });
  }
  return json({ error: "No encontrado" }, 404);
};

export default async (req) => {
  try { return await handler(req); }
  catch (e) { console.error(e); return json({ error: "Error del servidor: " + (e?.message || e) }, 500); }
};
