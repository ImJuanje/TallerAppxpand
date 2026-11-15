import { getStore } from "@netlify/blobs";
const db = () => getStore({ name: "taller", consistency: "strong" });

// Acceso global (solo para índices: login y códigos de alta)
export const g = {
  get: (k) => db().get(k, { type: "json" }),
  put: (k, v) => db().setJSON(k, v),
  putNew: async (k, v) => (await db().setJSON(k, v, { onlyIfNew: true })).modified,
  del: (k) => db().delete(k),
};

// Acceso por taller: el prefijo sale SIEMPRE de la sesión, nunca del cliente
export const T = (taller) => {
  const p = (k) => `t/${taller}/${k}`;
  return {
    get: (k) => db().get(p(k), { type: "json" }),
    put: (k, v) => db().setJSON(p(k), v),
    putNew: async (k, v) => (await db().setJSON(p(k), v, { onlyIfNew: true })).modified,
    del: (k) => db().delete(p(k)),
    list: async (pre) => (await db().list({ prefix: p(pre) })).blobs.map((b) => b.key.slice(p("").length)),
  };
};
