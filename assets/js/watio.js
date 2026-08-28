/* =========================================================================
   Marcos — Agente IA de WhiteMoon Podología (demo clínica podológica)

   Flujo: servicio -> nombre -> teléfono -> día -> hora -> confirmación.

   Los huecos NO se inventan en cliente: se piden a la Edge Function
   `podo-cita` (action 'huecos'), y al elegir hora se reserva de verdad
   (action 'reservar'), así la cita aparece en el panel de agenda.html.

   El lead se guarda SIEMPRE en leads_web (con cita_dia / cita_hora si las
   hay). El aviso por Telegram, en cambio, es uno solo por reserva:
     - con cita reservada  -> avisa `podo-cita` con su "📅 NUEVA CITA"
     - sin cita            -> avisa `podologos-notify` con el lead
   Así nunca salen dos mensajes por la misma solicitud.

   Nada de apikeys en cliente: la publishable key solo puede INSERT en
   leads_web vía RLS, y `podo-cita` / `podologos-notify` son verify_jwt:false
   con sus tokens en Secrets.

   Estilo de respuesta: máximo 3 frases por mensaje y UNA pregunta cada vez.
   ========================================================================= */
(() => {
  "use strict";

  const SUPABASE_URL = "https://mlaqtniujnvfxcvcourm.supabase.co";
  const SUPABASE_KEY = "sb_publishable_6no6BuOgiA_2nonTJntAuQ_DTqEgrcV";
  const NOTIFY_FN = SUPABASE_URL + "/functions/v1/podologos-notify";
  const PODO_FN = SUPABASE_URL + "/functions/v1/podo-cita";
  const LEADS_URL = SUPABASE_URL + "/rest/v1/leads_web";
  const ORIGEN = "podologia-demo";
  const SECTOR = "Clínica podológica";
  const TELEFONO = "643 199 580";

  /* Categorías: los `label` son EXACTAMENTE los data-servicio de los botones
     "Pedir cita" de las tarjetas, para que al entrar desde una tarjeta se
     salte la pregunta inicial.

     `trat` es el nombre del tratamiento tal y como existe en la agenda
     (tabla tratamientos_podologia), porque es lo que espera `reservar`.
     Varias categorías comerciales comparten tratamiento clínico: durezas se
     resuelve en una quiropodía, y micosis o infantil entran por primera
     visita porque hay que diagnosticar antes.

     `dur` es solo el valor por defecto: al abrir el chat se refresca con la
     duración real de la agenda, que el podólogo puede editar en el panel. */
  const WORKS = [
    { label: "Primera visita",            interes: "Primera visita / valoración",       trat: "Primera visita",                dur: 45 },
    { label: "Quiropodía",                interes: "Quiropodía",                        trat: "Quiropodia",                    dur: 30 },
    { label: "Uñas encarnadas",           interes: "Onicocriptosis / cirugía ungueal",  trat: "Uña encarnada",                 dur: 30, urgente: true },
    { label: "Papilomas plantares",       interes: "Papiloma plantar",                  trat: "Papiloma",                      dur: 30 },
    { label: "Durezas y callosidades",    interes: "Durezas y callosidades",            trat: "Quiropodia",                    dur: 30 },
    { label: "Estudio de la pisada",      interes: "Biomecánica",                       trat: "Estudio de la pisada",          dur: 60 },
    { label: "Plantillas personalizadas", interes: "Ortopodología / plantillas",        trat: "Plantillas (revisión/entrega)", dur: 30 },
    { label: "Pie diabético",             interes: "Pie diabético",                     trat: "Pie diabético",                 dur: 45, urgente: true },
    { label: "Micosis y hongos",          interes: "Micosis / onicomicosis",            trat: "Primera visita",                dur: 45 },
    { label: "Podología deportiva",       interes: "Podología deportiva",               trat: "Estudio de la pisada",          dur: 60 },
    { label: "Podología infantil",        interes: "Podología infantil",                trat: "Primera visita",                dur: 45 },
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

  /* ---------- fechas ---------- */
  const MESES_VISTA = 6;
  const DIAS_CORTOS = ["L", "M", "X", "J", "V", "S", "D"];
  const DIAS_LARGOS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

  const hoy = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const mismoDia = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  /* getDay() da domingo=0, que descoloca la rejilla: aqui lunes=0 */
  const diaSemanaLunes = (d) => (d.getDay() + 6) % 7;
  const formatoLargo = (d) =>
    d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const formatoCorto = (d) =>
    d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
  const isoLocal = (d) =>
    d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

  /* Los ISO que devuelve `huecos` ya vienen en hora de Madrid con su offset
     ("2026-08-31T09:30:00+02:00"). Se cortan a pelo en vez de pasar por Date
     para que el navegador no los reinterprete en su propia zona horaria. */
  const horaDe = (iso) => iso.slice(11, 16);
  const diaDe = (iso) => iso.slice(0, 10);

  /* Un dia es candidato si es laborable y no ha pasado. Es la misma regla que
     aplica podo-cita en `esLaborable`; sirve para no lanzar 30 peticiones por
     mes solo para pintar el calendario. Los huecos reales se piden al elegir. */
  const diaCandidato = (fecha) => diaSemanaLunes(fecha) <= 4 && fecha >= hoy();

  const $ = (s, c = document) => c.querySelector(s);
  const panel = $("#watio");
  if (!panel) return;
  const body = $(".watio-body", panel);
  const quick = $(".watio-quick", panel);
  const form = $(".watio-foot", panel);
  const input = $(".watio-foot input", panel);
  const sendBtn = $(".watio-foot button", panel);
  const btn = $("#watio-open");

  const lead = {
    servicio: "", interes: "", trat: "", dur: 30, urgente: false,
    nombre: "", telefono: "",
    dia: "", diaISO: "", hora: "", citaAt: "", citaId: "",
  };
  let step = "work";       // work -> name -> phone -> fecha -> hora -> done
  let started = false;
  let vista = null;        // mes que pinta el calendario
  let enviado = false;     // el lead solo se manda una vez

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

  /* Widget unico: se vuelve a pintar en el sitio en vez de apilar copias */
  const widget = (cls) => {
    let w = $("#watio-widget", body);
    if (!w) { w = document.createElement("div"); w.id = "watio-widget"; body.appendChild(w); }
    w.className = cls;
    w.innerHTML = "";
    scroll();
    return w;
  };
  const quitaWidget = () => { const w = $("#watio-widget", body); if (w) w.remove(); };

  /* ---------- llamadas a podo-cita ---------- */
  const podo = async (payload) => {
    try {
      const r = await fetch(PODO_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) console.warn("[marcos] podo-cita", r.status, data);
      return data;
    } catch (e) {
      console.warn("[marcos] podo-cita sin red:", e);
      return { _neterr: true };
    }
  };

  /* Duraciones reales de la agenda: el podologo puede cambiarlas desde el
     panel, y la duracion decide que huecos entran. Si falla, se siguen
     usando las de WORKS. */
  const sincronizaDuraciones = async () => {
    const res = await podo({ action: "tratamientos-list" });
    if (!res || !res.ok || !Array.isArray(res.tratamientos)) return;
    const porNombre = new Map(res.tratamientos.map((t) => [t.nombre, t]));
    WORKS.forEach((w) => {
      const t = porNombre.get(w.trat);
      if (t && t.duracion_min) w.dur = t.duracion_min;
    });
  };

  /* ---------- flujo ---------- */
  const start = async () => {
    if (started) return; started = true;
    setInput(false);
    sincronizaDuraciones();
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
    lead.trat = w.trat;
    lead.dur = w.dur;
    lead.urgente = !!w.urgente;
    clearQuick();
    const info = INFO[w.label];
    if (info) await botSay(info);
    askName();
  };

  const askName = async () => {
    step = "name";
    clearQuick();
    await botSay("Voy a buscarte hueco. ¿A nombre de quién pongo la cita?",
      () => setInput(true, "Tu nombre…"));
  };

  const askPhone = async () => {
    step = "phone";
    await botSay("Gracias, " + lead.nombre.split(" ")[0] + ". ¿A qué teléfono te llamamos si hay cualquier cambio?", () =>
      setInput(true, "Tu teléfono…")
    );
  };

  /* ---------- día ---------- */
  const askFecha = async () => {
    step = "fecha";
    clearQuick();
    if (!vista) { const t = hoy(); vista = new Date(t.getFullYear(), t.getMonth(), 1); }
    await botSay("Ya te tengo apuntado. ¿Qué día te viene bien? Atendemos de lunes a viernes.", () => {
      setInput(false, "Elige un día en el calendario");
      pintaCalendario();
    });
  };

  function pintaCalendario() {
    const box = widget("watio-cal");
    const t = hoy();
    const mesActual = new Date(t.getFullYear(), t.getMonth(), 1);
    const limite = new Date(t.getFullYear(), t.getMonth() + MESES_VISTA, 1);

    const nav = document.createElement("div");
    nav.className = "watio-cal__nav";
    const mk = (txt, aria, off, dis) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "watio-cal__btn"; b.textContent = txt;
      b.setAttribute("aria-label", aria); b.disabled = dis;
      b.addEventListener("click", () => {
        vista = new Date(vista.getFullYear(), vista.getMonth() + off, 1);
        pintaCalendario();
      });
      return b;
    };
    /* Sin retroceder del mes actual */
    nav.appendChild(mk("‹", "Mes anterior", -1, vista <= mesActual));
    const etiquetaMes = vista.toLocaleDateString("es-ES", { month: "long", year: "numeric" });
    const titulo = document.createElement("p");
    titulo.className = "watio-cal__mes";
    titulo.setAttribute("aria-live", "polite");
    /* es-ES da "agosto de 2026"; con capitalize saldria "Agosto De 2026" */
    titulo.textContent = etiquetaMes.charAt(0).toUpperCase() + etiquetaMes.slice(1);
    nav.appendChild(titulo);
    nav.appendChild(mk("›", "Mes siguiente", 1, vista >= limite));
    box.appendChild(nav);

    const grid = document.createElement("div");
    grid.className = "watio-cal__grid";
    grid.setAttribute("role", "group");
    grid.setAttribute("aria-label", "Días disponibles de " + etiquetaMes);
    DIAS_CORTOS.forEach((d, i) => {
      const c = document.createElement("span");
      c.className = "watio-cal__wd"; c.setAttribute("aria-hidden", "true");
      c.textContent = d; c.title = DIAS_LARGOS[i];
      grid.appendChild(c);
    });
    const primero = new Date(vista.getFullYear(), vista.getMonth(), 1);
    for (let h = 0; h < diaSemanaLunes(primero); h++) {
      const v = document.createElement("span");
      v.className = "watio-cal__day is-empty"; v.setAttribute("aria-hidden", "true");
      grid.appendChild(v);
    }
    const ultimo = new Date(vista.getFullYear(), vista.getMonth() + 1, 0).getDate();
    for (let n = 1; n <= ultimo; n++) {
      const fecha = new Date(vista.getFullYear(), vista.getMonth(), n);
      const b = document.createElement("button");
      b.type = "button"; b.className = "watio-cal__day"; b.textContent = String(n);
      if (mismoDia(fecha, new Date())) b.classList.add("is-today");
      if (!diaCandidato(fecha)) {
        b.disabled = true;
        b.setAttribute("aria-label", formatoLargo(fecha) + ", cerrado");
      } else {
        b.setAttribute("aria-label", formatoLargo(fecha));
        b.addEventListener("click", () => eligeFecha(fecha));
      }
      grid.appendChild(b);
    }
    box.appendChild(grid);

    const nota = document.createElement("p");
    nota.className = "watio-cal__nota";
    nota.textContent = "Lunes a viernes. Si es una urgencia, llámanos al " + TELEFONO + ".";
    box.appendChild(nota);

    /* Salida sin cita: se cierra igual y llamamos nosotros. */
    const salir = document.createElement("button");
    salir.type = "button"; salir.className = "watio-back";
    salir.textContent = "Prefiero que me llaméis vosotros";
    salir.addEventListener("click", () => {
      addMsg("Prefiero que me llaméis vosotros", "user");
      quitaWidget();
      cierreSinCita();
    });
    box.appendChild(salir);
  }

  const eligeFecha = async (fecha) => {
    lead.dia = formatoLargo(fecha);
    lead.diaISO = isoLocal(fecha);
    addMsg(formatoCorto(fecha), "user");
    quitaWidget();
    askHora(fecha);
  };

  /* ---------- hora: huecos REALES de la agenda ---------- */
  const askHora = async (fecha) => {
    step = "hora";
    const t = typing();
    const res = await podo({ action: "huecos", dia: lead.diaISO, duracion_min: lead.dur });
    t.remove();

    const huecos = res && res.ok && Array.isArray(res.huecos) ? res.huecos : [];
    if (!huecos.length) {
      const motivo = res && res._neterr
        ? "No he podido consultar la agenda ahora mismo."
        : "Ese día lo tenemos completo.";
      await botSay(motivo + " ¿Probamos con otro?", () => pintaSinHuecos());
      return;
    }
    await botSay("Perfecto. ¿A qué hora te viene mejor?", () => {
      setInput(false, "Elige una hora");
      pintaHoras(huecos, fecha);
    });
  };

  function pintaSinHuecos() {
    const box = widget("watio-slots");
    const atras = document.createElement("button");
    atras.type = "button"; atras.className = "watio-back";
    atras.textContent = "Elegir otro día";
    atras.addEventListener("click", () => { quitaWidget(); askFecha(); });
    box.appendChild(atras);
    const salir = document.createElement("button");
    salir.type = "button"; salir.className = "watio-back";
    salir.textContent = "Prefiero que me llaméis vosotros";
    salir.addEventListener("click", () => {
      addMsg("Prefiero que me llaméis vosotros", "user");
      quitaWidget();
      cierreSinCita();
    });
    box.appendChild(salir);
  }

  function pintaHoras(huecos, fecha) {
    const box = widget("watio-slots");
    /* La agenda abre en dos bloques (mañana y tarde); se agrupan por la hora
       del propio hueco en vez de repetir aquí los tramos del backend. */
    const manana = huecos.filter((h) => parseInt(horaDe(h), 10) < 14);
    const tarde = huecos.filter((h) => parseInt(horaDe(h), 10) >= 14);
    [["Mañana", manana], ["Tarde", tarde]].forEach(([etiqueta, lista]) => {
      if (!lista.length) return;
      const sep = document.createElement("p");
      sep.className = "watio-slots__sep";
      sep.textContent = etiqueta;
      box.appendChild(sep);
      lista.forEach((iso) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "watio-slot"; b.textContent = horaDe(iso);
        b.setAttribute("aria-label", horaDe(iso) + " del " + formatoCorto(fecha));
        b.addEventListener("click", () => eligeHora(iso, fecha));
        box.appendChild(b);
      });
    });
    const atras = document.createElement("button");
    atras.type = "button"; atras.className = "watio-back";
    atras.textContent = "Elegir otro día";
    atras.addEventListener("click", () => { addMsg("Prefiero otro día", "user"); quitaWidget(); askFecha(); });
    box.appendChild(atras);
  }

  const eligeHora = async (iso, fecha) => {
    lead.hora = horaDe(iso);
    lead.citaAt = iso;
    addMsg(lead.hora, "user");
    quitaWidget();
    reservar(fecha);
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

  /* ---------- reserva real contra la agenda ---------- */
  const reservar = async (fecha) => {
    setInput(false); clearQuick();
    const t = typing();
    const res = await podo({
      action: "reservar",
      paciente_nombre: lead.nombre,
      paciente_telefono: lead.telefono,
      tratamiento: lead.trat,
      duracion_min: lead.dur,
      cita_at: lead.citaAt,
    });
    t.remove();

    /* Se lo ha llevado otro entre que pintamos los huecos y confirmó */
    if (res && res.ok === false && res.reason) {
      await botSay("Vaya, ese hueco lo acaban de coger. Te enseño los que siguen libres ese día.");
      askHora(fecha);
      return;
    }

    if (!res || !res.ok) {
      /* La agenda no responde, pero el lead no se pierde: lo guardamos con la
         franja que pidió y que le llamen para confirmarla. */
      await cierreSinCita(true);
      return;
    }

    step = "done";
    lead.citaId = res.cita_id || "";
    await enviarLead();
    tarjetaExito("¡Listo! Cita confirmada para el " + lead.dia + " a las " + lead.hora + ".");
    setTimeout(
      () => addMsg(
        "Te esperamos para tu " + lead.servicio.toLowerCase() +
        ". Si necesitas cambiarla, llámanos al " + TELEFONO + ".", "bot"
      ),
      700
    );
  };

  /* Cierre sin hueco confirmado: el lead se guarda igual. */
  const cierreSinCita = async (conFranja) => {
    step = "done";
    setInput(false); clearQuick(); quitaWidget();
    const t = typing();
    if (!conFranja) { lead.dia = ""; lead.diaISO = ""; lead.hora = ""; }
    const ok = await enviarLead();
    t.remove();
    if (ok) {
      tarjetaExito("Anotado. Te llamamos al " + lead.telefono + " para cerrar el día y la hora.");
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
      lead.telefono = v; setInput(false); askFecha();
    }
  };

  form.addEventListener("submit", (e) => { e.preventDefault(); handleText(input.value); });

  /* Con nombre y teléfono ya tenemos un lead válido. Si se marcha en mitad
     del calendario, se manda igual al salir de la página: mejor un lead sin
     franja que ningún lead. */
  window.addEventListener("pagehide", () => {
    if (!enviado && lead.nombre && lead.telefono) enviarLead();
  });

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

  async function enviarLead() {
    if (enviado) return true;
    enviado = true;

    const cita = lead.diaISO && lead.hora ? " · Cita: " + lead.dia + " a las " + lead.hora : "";

    // 1) INSERT en leads_web (publishable key, solo INSERT vía RLS)
    const inserted = await post(LEADS_URL, {
      nombre: lead.nombre,
      telefono: lead.telefono,
      sector: SECTOR,
      interes: lead.interes,
      mensaje: "Motivo: " + lead.servicio + cita,
      origen: ORIGEN,
      cita_dia: lead.diaISO || null,
      cita_hora: lead.hora || null,
    }, { "Prefer": "return=minimal" });

    // 2) Aviso por Telegram SOLO si no ha habido reserva.
    //    Cuando `reservar` sale bien, podo-cita ya manda su "📅 NUEVA CITA":
    //    disparar aquí el aviso de lead dejaría dos Telegram por la misma
    //    reserva. Con cita_id el aviso ya está dado; sin él, este es el único.
    if (!lead.citaId) {
      await post(NOTIFY_FN, {
        nombre: lead.nombre,
        telefono: lead.telefono,
        motivo: lead.servicio,
        dia: lead.dia,
        hora: lead.hora,
        reservada: false,
        urgencia: lead.urgente,
        origen: ORIGEN,
      });
    }

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
