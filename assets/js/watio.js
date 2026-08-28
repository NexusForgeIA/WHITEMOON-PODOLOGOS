/* =========================================================================
   Marcos — Agente IA de WhiteMoon Podología (demo clínica podológica)
   Flujo del brief: servicio -> nombre -> teléfono -> cierre.
   Lead -> Supabase leads_web (sector=Clínica podológica, origen=podologia-demo)
        -> Edge Function podologos-notify (aviso por Telegram al equipo).

   La publishable key va en cliente porque solo puede INSERT en leads_web vía
   RLS. El token de Telegram NUNCA está aquí: vive en los Secrets de la Edge
   Function. Aquí no hay ninguna apikey de CallMeBot ni de notificación.

   Estilo de respuesta: máximo 3 frases por mensaje y UNA pregunta cada vez.
   ========================================================================= */
(() => {
  "use strict";

  const SUPABASE_URL = "https://mlaqtniujnvfxcvcourm.supabase.co";
  const SUPABASE_KEY = "sb_publishable_6no6BuOgiA_2nonTJntAuQ_DTqEgrcV";
  const NOTIFY_FN = SUPABASE_URL + "/functions/v1/podologos-notify";
  const LEADS_URL = SUPABASE_URL + "/rest/v1/leads_web";
  const ORIGEN = "podologia-demo";
  const SECTOR = "Clínica podológica";
  const TELEFONO = "643 199 580";

  /* Categorías: los `label` son EXACTAMENTE los data-servicio de los botones
     "Pedir cita" de las tarjetas, para que al entrar desde una tarjeta se
     salte la pregunta inicial. */
  const WORKS = [
    { label: "Primera visita",           interes: "Primera visita / valoración" },
    { label: "Quiropodía",               interes: "Quiropodía" },
    { label: "Uñas encarnadas",          interes: "Onicocriptosis / cirugía ungueal", urgente: true },
    { label: "Papilomas plantares",      interes: "Papiloma plantar" },
    { label: "Durezas y callosidades",   interes: "Durezas y callosidades" },
    { label: "Estudio de la pisada",     interes: "Biomecánica" },
    { label: "Plantillas personalizadas", interes: "Ortopodología / plantillas" },
    { label: "Pie diabético",            interes: "Pie diabético", urgente: true },
    { label: "Micosis y hongos",         interes: "Micosis / onicomicosis" },
    { label: "Podología deportiva",      interes: "Podología deportiva" },
    { label: "Podología infantil",       interes: "Podología infantil" },
  ];

  /* Qué incluye cada tratamiento — se cuenta antes de pedir los datos.
     Máximo 3 frases, sin preguntas: la pregunta va siempre aparte. */
  const INFO = {
    "Primera visita": "La primera visita es sin compromiso: exploramos el pie en camilla, vemos cómo apoyas y te explicamos qué está pasando. Salgas con tratamiento o sin él, te llevas el plan explicado y por escrito.",
    "Quiropodía": "Es el mantenimiento del pie sano: uñas, durezas y callosidades en una sola sesión de 30-45 minutos. Sales caminando cómodo el mismo día. Orientativo desde 35 €.",
    "Uñas encarnadas": "Liberamos el borde clavado con anestesia local, así que durante la sesión no duele. Si se te repite, valoramos cirugía ungueal para resolverlo de forma definitiva. Orientativo desde 60 €, cirugía desde 220 €.",
    "Papilomas plantares": "Las verrugas plantares las causa el VPH y suelen necesitar varias sesiones. Tras verla te decimos cuántas hacen falta en tu caso. Orientativo desde 60 € por sesión.",
    "Durezas y callosidades": "Retiramos la hiperqueratosis y los helomas, y buscamos por qué se te forman: casi siempre es apoyo o calzado. Si no se corrige la causa, vuelven. Orientativo desde 35 €.",
    "Estudio de la pisada": "Exploración biomecánica en camilla y análisis de la marcha. Te enseñamos cómo apoyas y de dónde sale el dolor de rodilla, talón o metatarso. Orientativo desde 60 €.",
    "Plantillas personalizadas": "Se fabrican a partir de tu molde y tu estudio, no de una talla estándar. Tardan entre 7 y 10 días e incluyen revisión de adaptación. Orientativo desde 180 € el par.",
    "Pie diabético": "Revisamos sensibilidad y riego, y tratamos uñas y durezas sin agredir la piel. Es un pie que avisa poco, por eso pautamos revisiones periódicas. Orientativo desde 45 €.",
    "Micosis y hongos": "Antes de tratar confirmamos que sea hongo, porque no todo lo que amarillea la uña lo es. Después hacemos seguimiento del crecimiento de la uña. Orientativo desde 40 €.",
    "Podología deportiva": "Fascitis, metatarsalgias, ampollas de repetición y elección de zapatilla. Lo adaptamos a tu deporte y a los kilómetros que hagas. Orientativo desde 60 €.",
    "Podología infantil": "Pie plano, marcha con las puntas hacia dentro, verrugas y uñas. Revisar mientras el pie crece es cuando más margen hay para corregir. Orientativo desde 35 €.",
  };

  const $ = (s, c = document) => c.querySelector(s);
  const panel = $("#watio");
  if (!panel) return;
  const body = $(".watio-body", panel);
  const quick = $(".watio-quick", panel);
  const form = $(".watio-foot", panel);
  const input = $(".watio-foot input", panel);
  const sendBtn = $(".watio-foot button", panel);
  const btn = $("#watio-open");

  const lead = { servicio: "", interes: "", urgente: false, nombre: "", telefono: "" };
  let step = "work";       // work -> name -> phone -> done
  let started = false;

  /* ---------- helpers UI ---------- */
  const scroll = () => { body.scrollTop = body.scrollHeight; };
  const addMsg = (text, who = "bot") => {
    const el = document.createElement("div");
    el.className = "watio-msg " + who;
    el.textContent = text;
    body.appendChild(el); scroll();
  };
  const typing = () => {
    const t = document.createElement("div");
    t.className = "watio-typing";
    t.innerHTML = "<span></span><span></span><span></span>";
    body.appendChild(t); scroll();
    return t;
  };
  const botSay = (text, after) =>
    new Promise((res) => {
      const t = typing();
      setTimeout(() => {
        t.remove(); addMsg(text, "bot");
        if (after) after();
        res();
      }, Math.min(900, 340 + text.length * 8));
    });
  const clearQuick = () => { quick.innerHTML = ""; };
  const setQuick = (items, onPick) => {
    clearQuick();
    items.forEach((it) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = it.label || it;
      b.addEventListener("click", () => onPick(it));
      quick.appendChild(b);
    });
  };
  const setInput = (enabled, placeholder) => {
    input.disabled = !enabled; sendBtn.disabled = !enabled;
    input.placeholder = placeholder || "Escribe tu respuesta…";
    if (enabled) setTimeout(() => input.focus(), 60);
  };

  /* ---------- flujo: servicio -> nombre -> teléfono -> cierre ---------- */
  const start = async () => {
    if (started) return; started = true;
    setInput(false);
    await botSay("Hola, soy Marcos, el asistente de WhiteMoon Podología. Te ayudo a pedir tu cita sin compromiso en un minuto.");
    await botSay("¿Qué te trae por aquí?", () => {
      setQuick(WORKS, (w) => { addMsg(w.label, "user"); pickWork(w.label); });
    });
  };

  /* Elegido el tratamiento: primero cuenta qué incluye, luego pide el nombre. */
  const pickWork = async (label) => {
    const w = WORKS.find((x) => x.label === label) || WORKS[0];
    lead.servicio = w.label;
    lead.interes = w.interes;
    lead.urgente = !!w.urgente;
    clearQuick();
    const info = INFO[w.label];
    if (info) await botSay(info);
    askName();
  };

  const askName = async () => {
    step = "name";
    clearQuick();
    await botSay("Te llamamos para cerrar el día y la hora que mejor te venga. ¿A nombre de quién pongo la cita?",
      () => setInput(true, "Tu nombre…"));
  };

  const askPhone = async () => {
    step = "phone";
    await botSay("Gracias, " + lead.nombre.split(" ")[0] + ". ¿A qué teléfono te llamamos?", () =>
      setInput(true, "Tu teléfono…")
    );
  };

  /* Tarjeta de exito: el SVG del check es decorativo (aria-hidden), el texto
     es quien transmite el resultado. */
  const tarjetaExito = (texto) => {
    const el = document.createElement("div");
    el.className = "watio-ok";
    el.setAttribute("role", "status");
    const ic = document.createElement("span");
    ic.className = "watio-ok__ic";
    ic.setAttribute("aria-hidden", "true");
    ic.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    const p = document.createElement("p");
    p.textContent = texto;
    el.append(ic, p);
    body.appendChild(el);
    scroll();
  };

  const finish = async () => {
    step = "done";
    setInput(false); clearQuick();
    const t = typing();
    const ok = await submitLead();
    t.remove();
    if (ok) {
      tarjetaExito("¡Listo! Tenemos todos tus datos. Te llamamos para cerrar tu cita de " + lead.servicio.toLowerCase() + ". ¡Gracias!");
      setTimeout(
        () => addMsg(
          "Si te duele mucho o no puedes esperar, llámanos directamente al " + TELEFONO + ".", "bot"
        ),
        700
      );
    } else {
      addMsg(
        "He guardado tus datos pero hubo un problema de conexión. Para no esperar, llámanos al " + TELEFONO + " y te atendemos al momento.",
        "bot"
      );
    }
  };

  /* ---------- entrada de texto ---------- */
  /* Guard: mínimo 9 dígitos reales (admite prefijo +34 / 0034 y separadores). */
  const isPhone = (v) => {
    const d = String(v).replace(/\D/g, "").replace(/^(?:0034|34)(?=[6-9]\d{8})/, "");
    return d.length >= 9 && /^[6-9]\d{8,}$/.test(d);
  };
  const handleText = (raw) => {
    const v = raw.trim();
    if (!v) return;
    addMsg(v, "user");
    input.value = "";
    if (step === "name") {
      if (v.length < 2) { botSay("¿Me dices tu nombre, por favor?"); return; }
      lead.nombre = v; setInput(false); askPhone();
    } else if (step === "phone") {
      if (!isPhone(v)) { botSay("Ese teléfono no parece válido. Escríbelo con 9 dígitos, por favor."); return; }
      lead.telefono = v; finish();
    }
  };

  form.addEventListener("submit", (e) => { e.preventDefault(); handleText(input.value); });

  /* ---------- envío del lead ----------
     fetch con keepalive (sobrevive a que se cierre la pestaña) y, si falla,
     sendBeacon con la apikey en query string como último recurso. */
  const beacon = (url, payload) => {
    if (!navigator.sendBeacon) return false;
    try {
      const sep = url.includes("?") ? "&" : "?";
      return navigator.sendBeacon(
        url + sep + "apikey=" + encodeURIComponent(SUPABASE_KEY),
        new Blob([JSON.stringify(payload)], { type: "application/json" })
      );
    } catch (e) { return false; }
  };

  const post = async (url, payload, extraHeaders) => {
    try {
      const r = await fetch(url, {
        method: "POST",
        keepalive: true,
        headers: Object.assign({
          "apikey": SUPABASE_KEY,
          "Authorization": "Bearer " + SUPABASE_KEY,
          "Content-Type": "application/json",
        }, extraHeaders || {}),
        body: JSON.stringify(payload),
      });
      if (r.ok) return true;
      console.warn("[marcos]", url, r.status, await r.text());
      return beacon(url, payload);
    } catch (e) {
      console.warn("[marcos] error de red:", e);
      return beacon(url, payload);
    }
  };

  async function submitLead() {
    // 1) INSERT en leads_web (publishable key, solo INSERT vía RLS)
    const inserted = await post(LEADS_URL, {
      nombre: lead.nombre,
      telefono: lead.telefono,
      sector: SECTOR,
      interes: lead.interes,
      mensaje: "Motivo: " + lead.servicio,
      origen: ORIGEN,
    }, { "Prefer": "return=minimal" });

    // 2) Aviso por Telegram vía Edge Function. El token vive en los Secrets.
    await post(NOTIFY_FN, {
      nombre: lead.nombre,
      telefono: lead.telefono,
      motivo: lead.servicio,
      urgencia: lead.urgente,
      origen: ORIGEN,
    });

    return inserted;
  }

  /* ---------- abrir / cerrar ---------- */
  const open = (servicio) => {
    panel.classList.add("open");
    /* Cerrado el panel es invisible pero sus botones seguirian siendo
       enfocables con el teclado: inert los saca del recorrido de tabulacion. */
    panel.removeAttribute("inert");
    if (btn) btn.style.display = "none";
    start();
    /* Si vienen de una tarjeta de servicio, saltamos la elección de categoría. */
    if (servicio && step === "work") {
      setTimeout(() => {
        if (step !== "work") return;
        addMsg(servicio, "user");
        pickWork(servicio);
      }, 900);
    }
  };
  const close = () => {
    panel.classList.remove("open");
    panel.setAttribute("inert", "");
    if (btn) btn.style.display = "";
    if (btn) btn.focus();
  };
  btn && btn.addEventListener("click", () => open());
  $(".watio-head__close", panel).addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.classList.contains("open")) close();
  });
  document.querySelectorAll("[data-watio]").forEach((el) =>
    el.addEventListener("click", (e) => { e.preventDefault(); open(el.dataset.servicio); })
  );
})();
