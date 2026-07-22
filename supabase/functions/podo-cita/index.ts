import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// podo-cita — backend de la agenda de la demo WhiteMoon · Clinica Podologica.
//
// Cubre huecos, reservas, agenda, estados, notas, reprogramaciones, pacientes,
// tratamientos y configuracion de la clinica.
//
// Canal de avisos: TELEGRAM (antes CallMeBot/WhatsApp).
//
// Secrets usados (nunca en cliente):
//   - TELEGRAM_BOT_TOKEN        : token del bot de Telegram (obligatorio)
//   - TELEGRAM_CHAT_ID          : chat destino; si falta se usa CHAT_ID_FALLBACK
//   - SUPABASE_URL              : inyectado por la plataforma
//   - SUPABASE_SERVICE_ROLE_KEY : inyectado por la plataforma
//
// Nota: las columnas podologia_config.wa_number y .callmebot_apikey se
// conservan (el panel de agenda.html las sigue leyendo/escribiendo via
// config-get / config-set), pero YA NO se usan para notificar.
//
// Regla del proyecto: si el aviso falla → console.warn, nunca rompe la reserva.
//
// Desplegar con:
//   supabase functions deploy podo-cita --no-verify-jwt --project-ref mlaqtniujnvfxcvcourm

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const GMB_FALLBACK = 'https://maps.app.goo.gl/3b9zDZrC8uvJfmYt7';

// El chat_id no es un secreto (solo identifica el destino); el token si lo es.
const CHAT_ID_FALLBACK = '861432965';

const REST_HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
};

const BLOQUES: Array<[string, string]> = [['09:30', '14:00'], ['16:00', '20:00']];
const GRANULARIDAD_MIN = 30;
const ESTADOS = ['agendada', 'confirmada', 'completada', 'cancelada', 'no_show'];
const CONFIG_CAMPOS = ['clinica_nombre', 'gerente_nombre', 'wa_number', 'callmebot_apikey', 'gmb_url'];

function normTel(t: string): string { return (t || '').replace(/\D/g, ''); }

async function getConfig() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/podologia_config?id=eq.1&select=clinica_nombre,gerente_nombre,wa_number,callmebot_apikey,gmb_url,updated_at`, { headers: REST_HEADERS });
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : { clinica_nombre: '', gerente_nombre: '', wa_number: '', callmebot_apikey: '', gmb_url: '', updated_at: null };
}

async function resolverPaciente(nombre: string, telefono: string): Promise<string | null> {
  const tn = normTel(telefono);
  if (!tn) return null;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/pacientes_podologia?telefono_norm=eq.${encodeURIComponent(tn)}&select=id`, { headers: REST_HEADERS });
  const rows = await r.json();
  if (Array.isArray(rows) && rows[0]) return rows[0].id;
  const ins = await fetch(`${SUPABASE_URL}/rest/v1/pacientes_podologia`, {
    method: 'POST',
    headers: { ...REST_HEADERS, 'Prefer': 'return=representation' },
    body: JSON.stringify({ nombre: nombre.slice(0, 120), telefono: telefono.slice(0, 30), telefono_norm: tn }),
  });
  const created = await ins.json();
  return Array.isArray(created) && created[0] ? created[0].id : null;
}

function madridOffset(dateStr: string): string {
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', hour: '2-digit', hour12: false }).format(probe), 10);
  let diff = h - 12;
  if (diff > 12) diff -= 24;
  if (diff < -12) diff += 24;
  return (diff >= 0 ? '+' : '-') + String(Math.abs(diff)).padStart(2, '0') + ':00';
}

function esLaborable(dateStr: string): boolean {
  const d = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5;
}

function slotISO(dateStr: string, hhmm: string): string {
  return `${dateStr}T${hhmm}:00${madridOffset(dateStr)}`;
}

function addMin(hhmm: string, min: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + min;
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

function fmtMadrid(iso: string): string {
  return new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

async function citasDelRango(desdeISO: string, hastaISO: string) {
  const url = `${SUPABASE_URL}/rest/v1/citas_podologia?cita_at=gte.${encodeURIComponent(desdeISO)}&cita_at=lt.${encodeURIComponent(hastaISO)}&estado=neq.cancelada&select=id,cita_at,duracion_min,estado,paciente_nombre,paciente_telefono,tratamiento,resena_enviada&order=cita_at.asc`;
  const r = await fetch(url, { headers: REST_HEADERS });
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

function seSolapan(aIni: number, aFin: number, bIni: number, bFin: number): boolean {
  return aIni < bFin && bIni < aFin;
}

async function huecosDia(dateStr: string, duracion: number): Promise<string[]> {
  if (!esLaborable(dateStr)) return [];
  const off = madridOffset(dateStr);
  const ocupadas = await citasDelRango(`${dateStr}T00:00:00${off}`, `${dateStr}T23:59:59${off}`);
  const ahora = Date.now() + 60 * 60 * 1000;
  const libres: string[] = [];
  for (const [ini, fin] of BLOQUES) {
    for (let t = ini; addMin(t, duracion) <= fin; t = addMin(t, GRANULARIDAD_MIN)) {
      const sIni = Date.parse(slotISO(dateStr, t));
      const sFin = sIni + duracion * 60000;
      if (sIni < ahora) continue;
      const choca = ocupadas.some((c: any) => {
        const cIni = Date.parse(c.cita_at);
        return seSolapan(sIni, sFin, cIni, cIni + (c.duracion_min || 30) * 60000);
      });
      if (!choca) libres.push(slotISO(dateStr, t));
    }
  }
  return libres;
}

// Devuelve true solo si Telegram acepto el mensaje, para poder verificar el
// aviso de punta a punta desde la respuesta de la funcion.
async function notificarGerente(text: string): Promise<boolean> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Deno.env.get('TELEGRAM_CHAT_ID') || CHAT_ID_FALLBACK;
  if (!token) {
    console.warn('[podo-cita] sin TELEGRAM_BOT_TOKEN, mensaje:', text);
    return false;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!r.ok) {
      console.warn('[podo-cita] Telegram fallo:', r.status, await r.text());
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[podo-cita] error enviando Telegram:', e);
    return false;
  }
}

async function log(citaId: string | null, accion: string, detalle: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/citas_podologia_log`, {
    method: 'POST',
    headers: { ...REST_HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ cita_id: citaId, accion, detalle }),
  }).catch(() => {});
}

Deno.serve(async (req: Request) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type' };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: { ...cors, 'Content-Type': 'application/json' } });
  const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

  try {
    const body = await req.json();
    const action = String(body.action || '');

    // ---- TRATAMIENTOS / SERVICIOS: listado con precios ----
    if (action === 'tratamientos-list') {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/tratamientos_podologia?select=id,nombre,duracion_min,precio_eur,activo,orden,updated_at&order=orden.asc`, { headers: REST_HEADERS });
      const rows = await r.json();
      return json({ ok: true, tratamientos: Array.isArray(rows) ? rows : [] });
    }

    // ---- TRATAMIENTO: editar precio/duracion/activo (nombre NO editable) ----
    if (action === 'tratamiento-set') {
      const tid = String(body.id || '');
      const campos = body.campos || {};
      if (!tid) return json({ error: 'id obligatorio' }, 400);
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if ('precio_eur' in campos) {
        const p = Number(campos.precio_eur);
        if (isNaN(p) || p < 0 || p > 9999) return json({ error: 'precio_eur debe ser un numero entre 0 y 9999' }, 400);
        patch.precio_eur = Math.round(p * 100) / 100;
      }
      if ('duracion_min' in campos) {
        const d = parseInt(campos.duracion_min, 10);
        if (isNaN(d) || d < 15 || d > 120) return json({ error: 'duracion_min debe estar entre 15 y 120' }, 400);
        patch.duracion_min = d;
      }
      if ('activo' in campos) patch.activo = Boolean(campos.activo);
      if (Object.keys(patch).length <= 1) return json({ error: 'sin campos validos (precio_eur, duracion_min, activo)' }, 400);
      const r = await fetch(`${SUPABASE_URL}/rest/v1/tratamientos_podologia?id=eq.${encodeURIComponent(tid)}`, {
        method: 'PATCH',
        headers: { ...REST_HEADERS, 'Prefer': 'return=representation' },
        body: JSON.stringify(patch),
      });
      const rows = await r.json();
      const t = Array.isArray(rows) ? rows[0] : null;
      if (!t) return json({ error: 'tratamiento no encontrado' }, 404);
      await log(null, 'tratamiento', `${t.nombre}: ${Object.keys(patch).filter(k => k !== 'updated_at').map(k => `${k}=${(patch as any)[k]}`).join(', ')}`);
      return json({ ok: true, id: t.id, nombre: t.nombre, precio_eur: t.precio_eur, duracion_min: t.duracion_min, activo: t.activo });
    }

    // ---- CONFIG ----
    if (action === 'config-get') {
      const cfg = await getConfig();
      return json({ ok: true, config: { clinica_nombre: cfg.clinica_nombre, gerente_nombre: cfg.gerente_nombre, wa_number: cfg.wa_number, gmb_url: cfg.gmb_url, tiene_apikey: Boolean((cfg.callmebot_apikey || '').trim()), updated_at: cfg.updated_at } });
    }
    if (action === 'config-set') {
      const campos = body.campos || {};
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      for (const k of CONFIG_CAMPOS) {
        if (k in campos) {
          if (k === 'callmebot_apikey' && String(campos[k] || '').trim() === '') continue;
          patch[k] = String(campos[k] || '').slice(0, 300);
        }
      }
      if (Object.keys(patch).length <= 1) return json({ error: 'sin campos validos' }, 400);
      const wa = 'wa_number' in patch ? String(patch.wa_number) : '';
      if (wa && !/^34\d{9}$/.test(wa)) return json({ error: 'wa_number debe ser 34 + 9 digitos (ej. 34600111222)' }, 400);
      await fetch(`${SUPABASE_URL}/rest/v1/podologia_config?id=eq.1`, {
        method: 'PATCH',
        headers: { ...REST_HEADERS, 'Prefer': 'return=minimal' },
        body: JSON.stringify(patch),
      });
      await log(null, 'config', `Perfil actualizado: ${Object.keys(patch).filter(k => k !== 'updated_at').join(', ')}`);
      return json({ ok: true });
    }

    // ---- PACIENTES ----
    if (action === 'pacientes') {
      const q = String(body.q || '').trim();
      let filtro = '';
      if (q) {
        const qEnc = encodeURIComponent(`*${q}*`);
        filtro = `&or=(nombre.ilike.${qEnc},telefono.ilike.${qEnc})`;
      }
      const r = await fetch(`${SUPABASE_URL}/rest/v1/pacientes_podologia_resumen?select=id,nombre,telefono,notas,n_citas,ultima_cita,created_at${filtro}&order=ultima_cita.desc.nullslast&limit=200`, { headers: REST_HEADERS });
      const rows = await r.json();
      return json({ ok: true, pacientes: Array.isArray(rows) ? rows : [] });
    }
    if (action === 'paciente-get') {
      const pid = String(body.paciente_id || '');
      if (!pid) return json({ error: 'paciente_id obligatorio' }, 400);
      const r = await fetch(`${SUPABASE_URL}/rest/v1/pacientes_podologia?id=eq.${encodeURIComponent(pid)}&select=id,nombre,telefono,notas,created_at,updated_at`, { headers: REST_HEADERS });
      const rows = await r.json();
      const paciente = Array.isArray(rows) ? rows[0] : null;
      if (!paciente) return json({ error: 'paciente no encontrado' }, 404);
      const cr = await fetch(`${SUPABASE_URL}/rest/v1/citas_podologia?paciente_id=eq.${encodeURIComponent(pid)}&select=id,cita_at,tratamiento,duracion_min,estado,notas,resena_enviada&order=cita_at.desc&limit=100`, { headers: REST_HEADERS });
      const citas = await cr.json();
      return json({ ok: true, paciente, historial: Array.isArray(citas) ? citas : [] });
    }
    if (action === 'paciente-set') {
      const pid = String(body.paciente_id || '');
      const nombre = String(body.nombre || '').slice(0, 120).trim();
      const telefono = String(body.telefono || '').slice(0, 30).trim();
      const notas = body.notas === undefined ? undefined : (body.notas === null ? null : String(body.notas).slice(0, 3000));
      const tn = normTel(telefono);
      if (!pid && (!nombre || tn.length < 9)) return json({ error: 'nombre y telefono (min 9 digitos) obligatorios para crear' }, 400);
      if (tn) {
        const dup = await fetch(`${SUPABASE_URL}/rest/v1/pacientes_podologia?telefono_norm=eq.${encodeURIComponent(tn)}&select=id`, { headers: REST_HEADERS });
        const dRows = await dup.json();
        if (Array.isArray(dRows) && dRows[0] && dRows[0].id !== pid) {
          return json({ ok: false, reason: 'ya existe un paciente con ese telefono' });
        }
      }
      if (pid) {
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (nombre) patch.nombre = nombre;
        if (telefono && tn.length >= 9) { patch.telefono = telefono; patch.telefono_norm = tn; }
        if (notas !== undefined) patch.notas = notas;
        const r = await fetch(`${SUPABASE_URL}/rest/v1/pacientes_podologia?id=eq.${encodeURIComponent(pid)}`, {
          method: 'PATCH',
          headers: { ...REST_HEADERS, 'Prefer': 'return=representation' },
          body: JSON.stringify(patch),
        });
        const rows = await r.json();
        if (!Array.isArray(rows) || !rows[0]) return json({ error: 'paciente no encontrado' }, 404);
        await log(null, 'paciente', `Editado: ${rows[0].nombre}`);
        return json({ ok: true, paciente_id: rows[0].id });
      }
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/pacientes_podologia`, {
        method: 'POST',
        headers: { ...REST_HEADERS, 'Prefer': 'return=representation' },
        body: JSON.stringify({ nombre, telefono, telefono_norm: tn, notas: notas ?? null }),
      });
      const created = await ins.json();
      const p = Array.isArray(created) ? created[0] : null;
      if (!p) return json({ error: 'no se pudo crear el paciente' }, 500);
      await log(null, 'paciente', `Creado: ${nombre}`);
      return json({ ok: true, paciente_id: p.id });
    }

    // ---- HUECOS ----
    if (action === 'huecos') {
      const dia = String(body.dia || '');
      const duracion = Math.min(Math.max(parseInt(body.duracion_min, 10) || 30, 15), 120);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return json({ error: 'dia YYYY-MM-DD obligatorio' }, 400);
      return json({ ok: true, dia, duracion_min: duracion, huecos: await huecosDia(dia, duracion) });
    }

    // ---- RESERVAR ----
    if (action === 'reservar') {
      const nombre = String(body.paciente_nombre || '').slice(0, 120);
      const telefono = String(body.paciente_telefono || '').slice(0, 30);
      const tratamiento = String(body.tratamiento || '').slice(0, 80);
      const duracion = Math.min(Math.max(parseInt(body.duracion_min, 10) || 30, 15), 120);
      const citaAt = String(body.cita_at || '');
      if (!nombre || !telefono || !tratamiento || isNaN(Date.parse(citaAt))) {
        return json({ error: 'paciente_nombre, paciente_telefono, tratamiento y cita_at ISO obligatorios' }, 400);
      }
      const ini = Date.parse(citaAt);
      const fin = ini + duracion * 60000;
      const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(citaAt));
      const off = madridOffset(dia);
      const ocupadas = await citasDelRango(`${dia}T00:00:00${off}`, `${dia}T23:59:59${off}`);
      const choca = ocupadas.some((c: any) => {
        const cIni = Date.parse(c.cita_at);
        return seSolapan(ini, fin, cIni, cIni + (c.duracion_min || 30) * 60000);
      });
      if (choca) return json({ ok: false, reason: 'hueco ya ocupado, elige otro' });

      const pacienteId = await resolverPaciente(nombre, telefono);
      const insRes = await fetch(`${SUPABASE_URL}/rest/v1/citas_podologia`, {
        method: 'POST',
        headers: { ...REST_HEADERS, 'Prefer': 'return=representation' },
        body: JSON.stringify({ paciente_nombre: nombre, paciente_telefono: telefono, tratamiento, duracion_min: duracion, cita_at: citaAt, paciente_id: pacienteId }),
      });
      const rows = await insRes.json();
      const cita = Array.isArray(rows) ? rows[0] : null;
      if (!cita) return json({ error: 'no se pudo crear la cita' }, 500);
      const cfg = await getConfig();
      await log(cita.id, 'reservada', `${tratamiento} ${citaAt} (${nombre})`);
      const notified = await notificarGerente(`📅 NUEVA CITA${cfg.clinica_nombre ? ' - ' + cfg.clinica_nombre : ''}\nPaciente: ${nombre}\nTel: ${telefono}\nTratamiento: ${tratamiento} (${duracion} min)\nCuando: ${fmtMadrid(citaAt)}`);
      return json({ ok: true, cita_id: cita.id, cita_at: citaAt, cuando: fmtMadrid(citaAt), notified });
    }

    // ---- AGENDA ----
    if (action === 'agenda') {
      const desde = String(body.desde || '');
      const hasta = String(body.hasta || '');
      if (isNaN(Date.parse(desde)) || isNaN(Date.parse(hasta))) return json({ error: 'desde y hasta ISO obligatorios' }, 400);
      const url = `${SUPABASE_URL}/rest/v1/citas_podologia?cita_at=gte.${encodeURIComponent(desde)}&cita_at=lt.${encodeURIComponent(hasta)}&select=id,created_at,paciente_nombre,paciente_telefono,paciente_id,tratamiento,duracion_min,cita_at,estado,resena_enviada,notas&order=cita_at.asc`;
      const r = await fetch(url, { headers: REST_HEADERS });
      const rows = await r.json();
      return json({ ok: true, citas: Array.isArray(rows) ? rows : [] });
    }

    // ---- ESTADO ----
    if (action === 'estado') {
      const citaId = String(body.cita_id || '');
      const estado = String(body.estado || '');
      if (!citaId || !ESTADOS.includes(estado)) return json({ error: `cita_id y estado valido (${ESTADOS.join('|')})` }, 400);
      const r = await fetch(`${SUPABASE_URL}/rest/v1/citas_podologia?id=eq.${encodeURIComponent(citaId)}&select=id,estado,paciente_nombre,paciente_telefono,tratamiento,resena_enviada`, { headers: REST_HEADERS });
      const rows = await r.json();
      const cita = Array.isArray(rows) ? rows[0] : null;
      if (!cita) return json({ error: 'cita no encontrada' }, 404);

      await fetch(`${SUPABASE_URL}/rest/v1/citas_podologia?id=eq.${encodeURIComponent(citaId)}`, {
        method: 'PATCH',
        headers: { ...REST_HEADERS, 'Prefer': 'return=minimal' },
        body: JSON.stringify(estado === 'completada' && !cita.resena_enviada ? { estado, resena_enviada: true } : { estado }),
      });
      await log(citaId, 'estado', `${cita.estado} -> ${estado}`);

      if (estado === 'completada' && !cita.resena_enviada) {
        const cfg = await getConfig();
        const gmb = (cfg.gmb_url || '').trim() || GMB_FALLBACK;
        await notificarGerente(`✅ VISITA COMPLETADA\nPaciente: ${cita.paciente_nombre}\nTel: ${cita.paciente_telefono}\nTratamiento: ${cita.tratamiento}\n\nEnvia al paciente el enlace de resena:\n${gmb}`);
      }
      return json({ ok: true, cita_id: citaId, estado });
    }

    // ---- NOTAS DE CITA ----
    if (action === 'notas') {
      const citaId = String(body.cita_id || '');
      const notas = body.notas === null ? null : String(body.notas || '').slice(0, 2000);
      if (!citaId) return json({ error: 'cita_id obligatorio' }, 400);
      const r = await fetch(`${SUPABASE_URL}/rest/v1/citas_podologia?id=eq.${encodeURIComponent(citaId)}&select=id`, { headers: REST_HEADERS });
      const rows = await r.json();
      if (!Array.isArray(rows) || !rows[0]) return json({ error: 'cita no encontrada' }, 404);
      await fetch(`${SUPABASE_URL}/rest/v1/citas_podologia?id=eq.${encodeURIComponent(citaId)}`, {
        method: 'PATCH',
        headers: { ...REST_HEADERS, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ notas }),
      });
      await log(citaId, 'notas', notas ? `Observaciones actualizadas (${notas.length} chars)` : 'Observaciones eliminadas');
      return json({ ok: true, cita_id: citaId });
    }

    // ---- REPROGRAMAR ----
    if (action === 'reprogramar') {
      const citaId = String(body.cita_id || '');
      const citaAt = String(body.cita_at || '');
      if (!citaId || isNaN(Date.parse(citaAt))) return json({ error: 'cita_id y cita_at ISO obligatorios' }, 400);
      const r = await fetch(`${SUPABASE_URL}/rest/v1/citas_podologia?id=eq.${encodeURIComponent(citaId)}&select=id,cita_at,duracion_min,paciente_nombre,tratamiento,estado`, { headers: REST_HEADERS });
      const rows = await r.json();
      const cita = Array.isArray(rows) ? rows[0] : null;
      if (!cita) return json({ error: 'cita no encontrada' }, 404);
      if (['completada', 'cancelada'].includes(cita.estado)) return json({ ok: false, reason: `cita ${cita.estado}, no reprogramable` });

      const ini = Date.parse(citaAt);
      const fin = ini + (cita.duracion_min || 30) * 60000;
      const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(citaAt));
      const off = madridOffset(dia);
      const ocupadas = (await citasDelRango(`${dia}T00:00:00${off}`, `${dia}T23:59:59${off}`)).filter((c: any) => c.id !== citaId);
      const choca = ocupadas.some((c: any) => {
        const cIni = Date.parse(c.cita_at);
        return seSolapan(ini, fin, cIni, cIni + (c.duracion_min || 30) * 60000);
      });
      if (choca) return json({ ok: false, reason: 'hueco ocupado, elige otro' });

      await fetch(`${SUPABASE_URL}/rest/v1/citas_podologia?id=eq.${encodeURIComponent(citaId)}`, {
        method: 'PATCH',
        headers: { ...REST_HEADERS, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ cita_at: citaAt }),
      });
      await log(citaId, 'reprogramada', `${cita.cita_at} -> ${citaAt}`);
      await notificarGerente(`🔁 CITA REPROGRAMADA\nPaciente: ${cita.paciente_nombre}\nTratamiento: ${cita.tratamiento}\nNueva fecha: ${fmtMadrid(citaAt)}`);
      return json({ ok: true, cita_id: citaId, cita_at: citaAt, cuando: fmtMadrid(citaAt) });
    }

    return json({ error: 'action debe ser huecos, reservar, agenda, estado, notas, reprogramar, config-get, config-set, pacientes, paciente-get, paciente-set, tratamientos-list o tratamiento-set' }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
