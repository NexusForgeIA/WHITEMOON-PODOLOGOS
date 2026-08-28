/* =========================================================================
   WhiteMoon Podologia — interacciones
   Sin librerías externas. Respeta prefers-reduced-motion.
   ========================================================================= */
(() => {
  "use strict";
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));

  /* ---------- Scroll: un solo listener, agrupado en rAF ----------
     Antes habia dos listeners que leian scrollY/offsetTop y escribian clases
     en el mismo tick; Lighthouse lo marcaba como forced reflow (~220 ms).
     Ahora se lee una vez por frame y las medidas de seccion van en cache. */
  const nav = $("#nav");
  const onScrollFns = [];
  let ticking = false;
  const runScroll = () => {
    const y = window.scrollY;
    onScrollFns.forEach((fn) => fn(y));
    ticking = false;
  };
  window.addEventListener(
    "scroll",
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(runScroll);
    },
    { passive: true }
  );

  if (nav) onScrollFns.push((y) => nav.classList.toggle("scrolled", y > 20));

  /* ---------- Menú móvil ---------- */
  const burger = $("#burger");
  const menu = $("#mobileMenu");
  if (burger && menu) {
    const setMenu = (open) => {
      menu.classList.toggle("open", open);
      burger.setAttribute("aria-expanded", String(open));
      burger.setAttribute("aria-label", open ? "Cerrar menú" : "Abrir menú");
      document.body.style.overflow = open ? "hidden" : "";
    };
    burger.addEventListener("click", () => setMenu(!menu.classList.contains("open")));
    $$("a, .btn", menu).forEach((el) => el.addEventListener("click", () => setMenu(false)));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && menu.classList.contains("open")) setMenu(false);
    });
  }

  /* ---------- Scroll-spy del nav ----------
     Se queda la logica por offsetTop ("manda la ultima seccion rebasada")
     porque es la que da el resultado correcto tambien al final de la pagina,
     donde lo visible es el footer y no hay ninguna seccion en pantalla.
     Lo que se corrige es CUANDO se mide: hacerlo durante la ejecucion del
     script forzaba un layout sincrono del documento entero (~107 ms). Ahora
     la medida se toma en rAF, ya despues del primer pintado, y queda en
     cache: durante el scroll no se lee nada del layout. */
  const spy = $$("#navLinks a");
  const sections = $$("main section[id]");
  if (spy.length && sections.length) {
    let marks = [];
    let last = null;
    const measure = () => {
      marks = sections.map((s) => ({ id: s.id, top: s.offsetTop - 160 }));
    };
    const sync = (y) => {
      if (!marks.length) return;
      let current = marks[0].id;
      for (let i = 0; i < marks.length; i++) if (y >= marks[i].top) current = marks[i].id;
      if (current === last) return;
      last = current;
      spy.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + current));
    };
    const remeasure = () => { measure(); last = null; sync(window.scrollY); };
    requestAnimationFrame(remeasure);
    onScrollFns.push(sync);
    window.addEventListener("load", () => requestAnimationFrame(remeasure));
    let rt;
    const remeasureDebounced = () => { clearTimeout(rt); rt = setTimeout(remeasure, 150); };
    window.addEventListener("resize", remeasureDebounced, { passive: true });
    /* Con content-visibility las secciones aun sin pintar ocupan la altura
       estimada; al materializarse cambian de alto y los offsetTop cacheados
       se quedan viejos. El ResizeObserver vuelve a medir cuando eso pasa. */
    if ("ResizeObserver" in window) {
      new ResizeObserver(remeasureDebounced).observe(document.body);
    }
  }

  /* ---------- Marquee: duplicar para bucle continuo ---------- */
  const marquee = $("#marquee");
  if (marquee && !reduced) marquee.innerHTML += marquee.innerHTML;

  /* ---------- Palabra rotativa del hero ---------- */
  const rot = $("#rotWord");
  if (rot && !reduced) {
    const words = ["quiropodía", "uñas encarnadas", "plantillas a medida", "pie diabético", "podología deportiva"];
    let i = 0;
    setInterval(() => {
      rot.classList.add("out");
      setTimeout(() => {
        i = (i + 1) % words.length;
        rot.textContent = words[i];
        rot.classList.remove("out");
      }, 420);
    }, 2600);
  }

  /* ---------- Reveal al hacer scroll ---------- */
  const reveals = $$(".reveal");
  if (reveals.length && "IntersectionObserver" in window && !reduced) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e, n) => {
          if (!e.isIntersecting) return;
          e.target.style.transitionDelay = Math.min(n * 70, 280) + "ms";
          e.target.classList.add("in");
          io.unobserve(e.target);
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -6% 0px" }
    );
    reveals.forEach((el) => io.observe(el));

    /* Si se entra por un enlace profundo (#precios, #faq…), se restaura la
       posición de scroll o se salta de golpe, todo lo que queda por encima
       nunca llega a intersecar y se quedaría invisible para siempre.
       Revelamos de golpe lo que ya está en pantalla o por encima. */
    const revealPasados = () => {
      const limite = window.innerHeight * 0.94;
      /* Primero se lee todo, despues se escribe: intercalar lecturas de
         getBoundingClientRect con cambios de clase forzaba un reflow por
         elemento (~66 ms en el audit). */
      const pendientes = reveals.filter((el) => !el.classList.contains("in"));
      const tops = pendientes.map((el) => el.getBoundingClientRect().top);
      pendientes.forEach((el, i) => {
        if (tops[i] < limite) {
          el.style.transitionDelay = "0ms";
          el.classList.add("in");
          io.unobserve(el);
        }
      });
    };
    /* En rAF: medir aqui durante la ejecucion del script forzaba un layout
       sincrono del documento entero antes del primer pintado. */
    requestAnimationFrame(revealPasados);
    window.addEventListener("load", () => requestAnimationFrame(revealPasados));
    window.addEventListener("hashchange", () => setTimeout(revealPasados, 420));
  } else {
    reveals.forEach((el) => el.classList.add("in"));
  }

  /* ---------- Año del footer ---------- */
  const year = $("#year");
  if (year) year.textContent = new Date().getFullYear();

  /* ---------- Vídeo del hero: no cargarlo si no se va a ver ----------
     El CSS ya lo oculta en móvil y con movimiento reducido; aquí evitamos
     además la descarga del archivo en esos casos. */
  const video = $(".hero-video");
  if (video) {
    const skip = reduced || window.matchMedia("(max-width: 768px)").matches
      || (navigator.connection && navigator.connection.saveData);
    if (skip) {
      video.removeAttribute("autoplay");
      $$("source", video).forEach((s) => s.remove());
      video.load();
    }
  }

  /* ---------- Guardia anti-overflow horizontal ----------
     Solo en local: leer scrollWidth/clientWidth fuerza un layout sincrono
     (64.8 ms en el audit de produccion) y esto es una ayuda de desarrollo,
     no algo que deba pagar el visitante. */
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
    window.addEventListener("load", () => {
      requestIdleCallback(() => {
        const de = document.documentElement;
        if (de.scrollWidth > de.clientWidth) {
          console.warn("[layout] overflow horizontal:", de.scrollWidth, ">", de.clientWidth);
        }
      });
    });
  }
})();
