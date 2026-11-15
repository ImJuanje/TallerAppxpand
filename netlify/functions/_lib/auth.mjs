import { scryptSync, randomBytes, timingSafeEqual, createHmac, createHash } from "node:crypto";
const SECRET = () => process.env.SESSION_SECRET;

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
  if (!d || !f || firma(d) !== f) return null;
  const p = JSON.parse(Buffer.from(d, "base64url").toString());
  return p.exp > Date.now() ? p : null;
};
export const exigir = (req, rol) => {
  const s = sesion(req);
  return s && (!rol || s.rol === rol) ? s : null;
};
