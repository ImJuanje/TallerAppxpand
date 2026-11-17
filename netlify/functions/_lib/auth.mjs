import { scryptSync, randomBytes, timingSafeEqual, createHmac, createHash } from "node:crypto";
const SECRET = () => {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("Falta SESSION_SECRET en las variables de entorno de Netlify (mínimo 16 caracteres)");
  return s;
};

export const hashPass = (pw) => {
  const salt = randomBytes(16);
  return salt.toString("hex") + ":" + scryptSync(pw, salt, 64).toString("hex");
};
export const checkPass = (pw, stored) => {
  const [s, h] = stored.split(":");
  const a = scryptSync(pw, Buffer.from(s, "hex"), 64), b = Buffer.from(h, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};
export const sha = (x) => createHash("sha256").update(x).digest("hex");
export const nuevoCodigo = () => randomBytes(5).toString("hex").toUpperCase();
// Comparación en tiempo constante de dos textos cualesquiera
export const igual = (a, b) => timingSafeEqual(Buffer.from(sha(String(a)), "hex"), Buffer.from(sha(String(b)), "hex"));

const firma = (d) => createHmac("sha256", SECRET()).update(d).digest("base64url");
export const crearCookie = (payload, mantener) => {
  const exp = Date.now() + (mantener ? 30 : 1) * 864e5;
  const d = Buffer.from(JSON.stringify({ ...payload, exp })).toString("base64url");
  const age = mantener ? `; Max-Age=${30 * 86400}` : "";
  return `sid=${d}.${firma(d)}; HttpOnly; Secure; SameSite=Strict; Path=/${age}`;
};
export const borrarCookie = () => "sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0";

export const sesion = (req) => {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.get("cookie") || "");
  if (!m) return null;
  const [d, f] = m[1].split(".");
  if (!d || !f || !igual(firma(d), f)) return null;
  try {
    const p = JSON.parse(Buffer.from(d, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
};
export const exigir = (req, rol) => {
  const s = sesion(req);
  return s && (!rol || s.rol === rol) ? s : null;
};

// Un mecánico solo está "vigente" si su cuenta existe, no está de baja y la sesión es de la versión actual.
// Una baja o un cambio de contraseña (sube `sv`) cortan el acceso aunque la cookie siga viva.
export const vigente = async (ses, t) => {
  if (ses.rol === "admin") return {};
  const u = await t.get("usuarios/" + ses.usuario);
  return u && u.activo !== false && (u.sv || 0) === (ses.sv || 0) ? u : null;
};
