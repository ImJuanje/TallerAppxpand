import { T } from "./_lib/store.mjs";
import { exigir } from "./_lib/auth.mjs";

// Copia de seguridad (solo admin):
//   GET /api/export?formato=json → todas las órdenes, el equipo (sin contraseñas) y los ajustes, más la lista de fotos
//   GET /api/export?formato=csv  → una fila por orden, para abrir con Excel
// Las fotos NO van aquí: el panel las baja una a una de /api/fotos/ID (así no se supera el límite de tamaño de las funciones).
export const config = { path: "/api/export" };

const SIN_CACHE = { "cache-control": "no-store" };
const json = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", ...SIN_CACHE, ...h } });

// Lee muchas claves sin lanzarlas todas a la vez
const leerTodas = async (t, pre) => {
  const ks = await t.list(pre), out = [];
  for (let i = 0; i < ks.length; i += 25) out.push(...(await Promise.all(ks.slice(i, i + 25).map((k) => t.get(k)))));
  return out.filter(Boolean);
};

// CSV para Excel en español: separador «;», decimales con coma, BOM para los acentos
const SEGURO = /^[+-]?[\d\s().,-]+$/; // teléfonos y números que empiezan por + o -
const celda = (v) => {
  let x = String(v ?? "");
  if (/^[=@\t\r]/.test(x) || (/^[+-]/.test(x) && !SEGURO.test(x))) x = "'" + x; // evita que Excel ejecute fórmulas escritas por clientes
  return /[";\r\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x;
};
const eur = (n) => (Math.round(n * 100) / 100).toFixed(2).replace(".", ",");
const COLS = ["Fecha de entrada", "Matrícula", "Marca", "Modelo", "Año", "Km", "Cliente", "Teléfono", "Motivo", "Estado", "Mecánico",
  "Visto bueno", "Base (€)", "IVA 21 % (€)", "Total (€)", "Notas", "Fotos"];
const VB = { ok: "Aprobado", pendiente: "Pendiente", "": "" };

export default async (req) => {
  if (req.method !== "GET") return json({ error: "No encontrado" }, 404);
  if (!exigir(req, "admin")) return json({ error: "No autorizado" }, 403);
  const t = T("main"), formato = new URL(req.url).searchParams.get("formato") || "json";
  if (!["json", "csv"].includes(formato)) return json({ error: "Formato no válido" }, 400);

  const ordenes = (await leerTodas(t, "ordenes/")).map(({ fr, fp, ...o }) => o).sort((a, b) => (b.creado || 0) - (a.creado || 0));

  if (formato === "csv") {
    const nombres = Object.fromEntries((await leerTodas(t, "usuarios/")).map((u) => [u.usuario, u.nombre || u.usuario]));
    const filas = ordenes.map((o) => {
      const base = (o.pres || []).reduce((s, l) => s + (+l.i || 0), 0);
      return [o.fecha, o.mat, o.marca, o.modelo, o.anio || "", o.km || "", o.cli, o.tel, [...(o.mot || []), o.otro].filter(Boolean).join(", "), o.estado,
        o.mec ? nombres[o.mec] || o.mec : "Sin asignar", VB[o.vb] ?? "", eur(base), eur(base * 0.21), eur(base * 1.21), o.notas,
        (o.fotos || []).length + (o.foto ? 1 : 0)].map(celda).join(";");
    });
    return new Response("\uFEFF" + [COLS.join(";"), ...filas].join("\r\n") + "\r\n", {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="taller-ordenes.csv"', ...SIN_CACHE } });
  }

  const equipo = (await leerTodas(t, "usuarios/")).map(({ pass, sv, ...u }) => u);
  const ajustes = (await t.get("ajustes")) || {};
  const fotos = [...new Set(ordenes.flatMap((o) => [o.foto, ...(o.fotos || [])]).filter(Boolean))];
  return json({ generado: new Date().toISOString(), ordenes, equipo, ajustes, fotos });
};
