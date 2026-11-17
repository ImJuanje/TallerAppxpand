import { getStore } from "@netlify/blobs";
const db = () => getStore({ name: "taller", consistency: "strong" });

// Escrituras condicionales (necesitan @netlify/blobs >= 9):
//   putNew  → solo escribe si la clave no existe (atómico)
//   putIf   → solo escribe si el ETag sigue siendo el que se leyó (atómico)
//   mutate  → leer-modificar-escribir con reintentos: si otro escribe entre medias, se vuelve a leer y a aplicar
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const crear = (pre) => {
  const p = (k) => pre + k;
  const s = {
    get: (k) => db().get(p(k), { type: "json" }),
    getE: async (k) => {
      const r = await db().getWithMetadata(p(k), { type: "json" });
      return r ? { data: r.data, etag: r.etag } : null;
    },
    put: (k, v) => db().setJSON(p(k), v),
    putNew: async (k, v) => (await db().setJSON(p(k), v, { onlyIfNew: true })).modified !== false,
    putIf: async (k, v, etag) => (await db().setJSON(p(k), v, { onlyIfMatch: etag })).modified !== false,
    del: (k) => db().delete(p(k)),
    list: async (q) => (await db().list({ prefix: p(q) })).blobs.map((b) => b.key.slice(pre.length)),
    // fn(actual|null) → { write?: nuevoValor, out: resultado }. Sin "write" no se escribe nada.
    // fn puede ejecutarse varias veces (una por reintento): que no tenga efectos fuera de su valor de retorno.
    mutate: async (k, fn, intentos = 8) => {
      for (let i = 0; i < intentos; i++) {
        const cur = await s.getE(k);
        const r = await fn(cur ? cur.data : null);
        if (!("write" in r)) return r.out;
        const ok = cur ? await s.putIf(k, r.write, cur.etag) : await s.putNew(k, r.write);
        if (ok) return r.out;
        await esperar(15 + Math.random() * 60 * (i + 1));
      }
      throw new Error("Hay mucha actividad ahora mismo. Inténtalo de nuevo.");
    },
  };
  return s;
};

// Acceso global (solo para índices: login, límite de intentos y códigos de alta/restablecimiento)
export const g = crear("");

// Acceso por taller: el prefijo sale SIEMPRE de la sesión, nunca del cliente
export const T = (taller) => crear(`t/${taller}/`);
