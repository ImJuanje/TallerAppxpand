import { g } from "./store.mjs";

// Límite de intentos por conexión (misma lógica que el login): tras demasiados fallos se bloquea 15 min.
// Los contadores usan escritura condicional, así que dos intentos simultáneos no se pisan.
const VENTANA = 15 * 60 * 1000;
export const ipDe = (req) => req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "desconocida";
export const bloqueado = async (...ks) => {
  for (const k of ks) { const r = await g.get(k); if (r?.hasta > Date.now()) return Math.ceil((r.hasta - Date.now()) / 60000); }
  return 0;
};
export const fallo = (k, max) => g.mutate(k, (r) => {
  const ahora = Date.now(), c = r && ahora - r.desde <= VENTANA ? { ...r } : { n: 0, desde: ahora };
  c.n++; if (c.n >= max) c.hasta = ahora + VENTANA;
  return { write: c, out: c };
});
