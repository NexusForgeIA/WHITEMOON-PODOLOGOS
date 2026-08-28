import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// podologos-notify — aviso por Telegram de una nueva SOLICITUD DE CITA de la
// demo WhiteMoon Podología (asistente "Marcos").
//
// El lead ya se inserta en leads_web desde el cliente (origen='podologia-demo');
// esta función SOLO envía la notificación vía Telegram Bot API, manteniendo el
// token EXCLUSIVAMENTE server-side. En el JS de cliente no hay ninguna apikey
// del notificador: solo la publishable key de Supabase, que únicamente puede
// INSERT en leads_web vía RLS.
//
// Recibe (POST JSON): { nombre, telefono, motivo, dia, hora, reservada,
//                        urgencia, origen }
//
// Secrets usados (nunca en cliente):
//   - TELEGRAM_BOT_TOKEN : token del bot de Telegram
//   - TELEGRAM_CHAT_ID   : chat destino del aviso
//
// `reservada` distingue los dos casos: true = el hueco ya quedó escrito en la
// agenda vía `podo-cita` (que manda además su propio aviso de cita nueva);
// false = solo tenemos el lead y la clínica debe llamar para cerrar día y hora.
//
// Regla del proyecto: si el envío falla → console.warn, nunca interrumpe nada.
//
// Desplegar con:
//   supabase functions deploy podologos-notify --no-verify-jwt --project-ref mlaqtniujnvfxcvcourm

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  let payload: Record<string, unknown> = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const data = (payload.args ?? payload) as Record<string, unknown>;
  const nombre = String(data.nombre ?? "").trim();
  const telefono = String(data.telefono ?? "").trim();
  const motivo = String(data.motivo ?? "").trim();
  const dia = String(data.dia ?? "").trim();
  const hora = String(data.hora ?? "").trim();
  const origen = String(data.origen ?? "podologia-demo").trim();
  const esUrgencia = data.urgencia === true || data.urgencia === "Sí";
  const reservada = data.reservada === true || data.reservada === "Sí";

  // Guard de lead incompleto — estándar WhiteMoon.
  // Un lead solo es válido con nombre Y teléfono: sin ambos no se avisa.
  if (!nombre || !telefono) {
    return json({ ok: false, error: "lead incompleto" }, 400);
  }

  const message =
    (esUrgencia
      ? `🚨 URGENCIA PODOLÓGICA — ${origen}\n\n`
      : `🦶 NUEVA SOLICITUD DE CITA — ${origen}\n\n`) +
    `👤 ${nombre}\n` +
    `📱 ${telefono}\n` +
    `🩺 Motivo: ${motivo || "-"}\n` +
    (dia && hora ? `📅 ${dia} a las ${hora}\n` : "📅 Sin franja elegida\n") +
    `\n` +
    (reservada
      ? "✅ Hueco YA reservado en la agenda. No hay que llamar para cerrarlo.\n"
      : "⚠️ Solo tenemos el lead: hay que llamar para cerrar día y hora.\n") +
    `📲 CONTACTAR: https://wa.me/34${telefono.replace(/\D/g, "")}`;

  let notified = false;
  try {
    const tgToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const tgChat = Deno.env.get("TELEGRAM_CHAT_ID");
    if (tgToken && tgChat) {
      const r = await fetch(
        `https://api.telegram.org/bot${tgToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: tgChat, text: message }),
        },
      );
      notified = r.ok;
      if (!r.ok) {
        console.warn("[podologos-notify] Telegram falló:", r.status, await r.text());
      }
    } else {
      console.warn("[podologos-notify] sin TELEGRAM_BOT_TOKEN/CHAT_ID, mensaje:", message);
    }
  } catch (e) {
    console.warn("[podologos-notify] error enviando Telegram:", e);
  }

  return json({ ok: true, notified });
});
