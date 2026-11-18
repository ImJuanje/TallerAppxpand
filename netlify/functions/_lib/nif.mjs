// Validación de NIF (DNI), NIE y CIF españoles. Devuelve { ok, tipo, nif } con el NIF normalizado (mayúsculas, sin espacios ni guiones).
const LETRAS = "TRWAGMYFPDXBNJZSQVHLCKE";
export function validaNif(entrada) {
  const x = String(entrada ?? "").toUpperCase().replace(/[\s.-]/g, "");
  let m;
  if ((m = /^(\d{8})([A-Z])$/.exec(x))) return LETRAS[m[1] % 23] === m[2] ? { ok: true, tipo: "NIF", nif: x } : { ok: false };
  if ((m = /^([XYZ])(\d{7})([A-Z])$/.exec(x))) return LETRAS[("XYZ".indexOf(m[1]) + m[2]) % 23] === m[3] ? { ok: true, tipo: "NIE", nif: x } : { ok: false };
  if ((m = /^([ABCDEFGHJNPQRSUVW])(\d{7})([0-9A-J])$/.exec(x))) {
    let par = 0, imp = 0;
    for (let i = 0; i < 7; i++) { const v = +m[2][i]; if (i % 2 === 0) { const w = v * 2; imp += Math.floor(w / 10) + (w % 10); } else par += v; }
    const c = (10 - ((par + imp) % 10)) % 10, L = "JABCDEFGHI"[c];
    const ok = "PQRSNW".includes(m[1]) ? m[3] === L : "ABEH".includes(m[1]) ? m[3] === String(c) : m[3] === String(c) || m[3] === L;
    return ok ? { ok: true, tipo: "CIF", nif: x } : { ok: false };
  }
  return { ok: false };
}
