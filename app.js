/* Transporte de Personal · Astillero — prototipo PWA (chofer + supervisor) */
(function () {
  var C = JSON.parse(JSON.stringify(window.CATALOGO)), CFG = Object.assign({}, window.APP_CONFIG), $app = document.getElementById("app");
  var state = { view: null, viaje: null, prefs: null, watchId: null, lastPos: null, supervisorOk: false, periodo: "7", remoto: null };

  /* ---------- utilidades ---------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmtHora(ts) { if (!ts) return "—"; var d = new Date(ts); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }
  function fmtFecha(ts) { if (!ts) return "—"; var d = new Date(ts); return d.toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short" }); }
  function fmtNum(n, d) { return (n == null || isNaN(n)) ? "—" : Number(n).toLocaleString("es-MX", { maximumFractionDigits: d == null ? 1 : d, minimumFractionDigits: 0 }); }
  function fmtMXN(n) { return (n == null || isNaN(n)) ? "—" : "$" + Number(n).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function num(v) { var n = parseFloat(String(v).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? null : n; }
  function minutosDesde(ts) { return Math.round((Date.now() - ts) / 60000); }
  function toast(msg, err) {
    var t = document.createElement("div"); t.className = "toast" + (err ? " err" : ""); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600);
  }
  function haversineKm(a, b) {
    var R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }
  function getPos() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(function (p) {
        resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy });
      }, function () { resolve(null); }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 });
    });
  }
  function metaMinutos(turno) {
    var h = (turno === "entrada" ? CFG.HORA_META_ENTRADA : CFG.HORA_META_SALIDA).split(":");
    return parseInt(h[0], 10) * 60 + parseInt(h[1], 10);
  }
  // Retraso en minutos del viaje respecto a la hora meta (negativo = adelantado)
  function retrasoMin(v) {
    var ts = v.turno === "entrada" ? v.llegada_ts : v.salida_ts;
    if (!ts) return null;
    var d = new Date(ts); return d.getHours() * 60 + d.getMinutes() - metaMinutos(v.turno);
  }
  function kmViaje(v) {
    if (v.odo_ini != null && v.odo_fin != null && v.odo_fin > v.odo_ini) return v.odo_fin - v.odo_ini;
    return v.km_gps || 0;
  }
  function guardarPrefs(p) { state.prefs = p; return DB.put("config", { id: "prefs", v: p }); }
  function dispositivo() { return (navigator.userAgent || "").slice(0, 80); }

  /* ---------- fotos ---------- */
  function leerFoto(file) {
    return new Promise(function (resolve) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var max = 1024, w = img.width, h = img.height, k = Math.min(1, max / Math.max(w, h));
        var cv = document.createElement("canvas"); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url); resolve(cv.toDataURL("image/jpeg", 0.7));
      };
      img.onerror = function () { resolve(null); };
      img.src = url;
    });
  }
  function fotoInput(id, label, fotoId) {
    return '<div class="photo" id="ph-' + id + '">' + (fotoId ? '<img alt="foto">' : esc(label)) +
      '<input type="file" accept="image/*" capture="environment" aria-label="' + esc(label) + '" data-foto="' + id + '"></div>';
  }
  function cargarPreview(id, fotoId) {
    if (!fotoId) return;
    DB.get("fotos", fotoId).then(function (f) { var el = document.querySelector("#ph-" + id + " img"); if (f && el) el.src = f.dataUrl; });
  }

  /* ---------- GPS en ruta ---------- */
  function iniciarSeguimiento() {
    if (!navigator.geolocation || state.watchId != null) return;
    state.watchId = navigator.geolocation.watchPosition(function (p) {
      var pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
      if (pos.acc > 60) return;
      if (state.lastPos && state.viaje) {
        var d = haversineKm(state.lastPos, pos);
        if (d > 0.015 && d < 3) { state.viaje.km_gps = Math.round(((state.viaje.km_gps || 0) + d) * 100) / 100; DB.put("viajes", state.viaje); var el = document.getElementById("kmgps"); if (el) el.textContent = fmtNum(state.viaje.km_gps); }
      }
      state.lastPos = pos;
    }, function () {}, { enableHighAccuracy: true, maximumAge: 5000 });
  }
  function detenerSeguimiento() { if (state.watchId != null) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; } state.lastPos = null; }

  /* ---------- navegación ---------- */
  function nav(v) { location.hash = "#" + v; }
  function render() {
    var h = (location.hash || "#inicio").slice(1);
    if (!/^[a-z-]+$/.test(h)) h = "inicio";
    if (state.viaje && (h === "inicio")) h = "viaje";
    if (!state.viaje && (h === "viaje" || h === "llegada")) h = "inicio";
    state.view = h;
    var views = { inicio: vInicio, viaje: vViaje, llegada: vLlegada, combustible: vCombustible, solicitud: vSolicitud, historial: vHistorial, supervisor: vSupervisor, configuracion: vConfiguracion };
    (views[h] || vInicio)();
  }
  function navBar(cur) {
    var items = [["viaje", "Viaje"], ["combustible", "Combustible"], ["solicitud", "Extra"], ["historial", "Historial"], ["supervisor", "Supervisor"]];
    return '<div class="tabs">' + items.map(function (i) {
      var k = i[0] === "viaje" && !state.viaje ? "inicio" : i[0];
      return '<button class="btn' + ((cur === i[0] || (i[0] === "viaje" && cur === "inicio")) ? " sel" : "") + '" data-nav="' + k + '">' + i[1] + '</button>';
    }).join("") + "</div>";
  }
  function hdr(sub, titulo, extra, badge) {
    return '<div class="hdr"><div class="row"><div class="sub">' + esc(sub) + '</div>' + (badge || "") + '</div><h1>' + esc(titulo) + '</h1><div class="sub">' + (extra || "") + '</div></div>';
  }
  function opts(list, sel, key, lab) {
    return list.map(function (o) { var v = key ? o[key] : o, l = lab ? o[lab] : o; return '<option value="' + esc(v) + '"' + (v === sel ? " selected" : "") + '>' + esc(l) + '</option>'; }).join("");
  }

  /* ---------- VISTA: inicio de viaje ---------- */
  function vInicio() {
    var p = state.prefs || {};
    var turno = p.turno || (new Date().getHours() < 12 ? "entrada" : "salida");
    $app.innerHTML = hdr("Chofer: " + (p.chofer_nombre || "sin asignar"), "Iniciar viaje", fmtFecha(Date.now()) + " · " + fmtHora(Date.now()) + ' · <span id="gpsst">buscando GPS…</span>') +
      '<div class="main">' + navBar("inicio") +
      '<div><label for="chofer">Chofer</label><select id="chofer">' + opts(C.choferes, p.chofer_id, "id", "nombre") + '</select></div>' +
      '<div><label for="unidad">Unidad</label><select id="unidad">' + opts(C.unidades, p.unidad_id, "id", "nombre") + '</select></div>' +
      '<div><label for="ruta">Ruta</label><select id="ruta">' + opts(C.rutas, p.ruta_id, "id", "nombre") + '</select></div>' +
      '<div><span class="lbl">Turno</span><div class="grp"><button class="btn' + (turno === "entrada" ? " sel" : "") + '" data-turno="entrada">Entrada</button><button class="btn' + (turno === "salida" ? " sel" : "") + '" data-turno="salida">Salida</button></div></div>' +
      '<div><label for="odo">Odómetro inicial (km)</label><input id="odo" class="big" inputmode="numeric" placeholder="148320"></div>' +
      '<div><span class="lbl">Foto del odómetro (opcional)</span>' + fotoInput("odoini", "Tomar foto", null) + '</div>' +
      '<div class="card"><h3>Se registra automáticamente</h3><div class="muted">Hora de salida · Ubicación GPS · Km recorridos por GPS</div></div>' +
      '</div><div class="foot"><button class="btn pri xl" id="btnIniciar">Iniciar viaje</button></div>';
    var sel = turno, fotoId = null;
    getPos().then(function (pos) { var el = document.getElementById("gpsst"); if (el) el.textContent = pos ? "GPS activo (±" + Math.round(pos.acc) + " m)" : "GPS no disponible"; });
    $app.querySelectorAll("[data-turno]").forEach(function (b) { b.onclick = function () { sel = b.dataset.turno; $app.querySelectorAll("[data-turno]").forEach(function (x) { x.classList.toggle("sel", x === b); }); }; });
    $app.querySelector('[data-foto="odoini"]').onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      leerFoto(f).then(function (du) { if (!du) return; fotoId = DB.uid(); DB.put("fotos", { id: fotoId, dataUrl: du, ts: Date.now() }); var ph = document.getElementById("ph-odoini"); ph.innerHTML = '<img src="' + du + '" alt="odómetro">' + ph.innerHTML.replace(/^[^<]*/, ""); });
    };
    document.getElementById("btnIniciar").onclick = function () {
      var ch = C.choferes.filter(function (c) { return c.id === document.getElementById("chofer").value; })[0];
      var un = C.unidades.filter(function (u) { return u.id === document.getElementById("unidad").value; })[0];
      var ru = C.rutas.filter(function (r) { return r.id === document.getElementById("ruta").value; })[0];
      var odo = num(document.getElementById("odo").value);
      this.disabled = true; this.textContent = "Registrando…";
      getPos().then(function (pos) {
        var v = {
          id: DB.uid(), chofer_id: ch.id, chofer: ch.nombre, unidad_id: un.id, capacidad: un.capacidad, ruta_id: ru.id, ruta: ru.nombre, turno: sel,
          salida_ts: Date.now(), salida_lat: pos ? pos.lat : null, salida_lng: pos ? pos.lng : null, odo_ini: odo, foto_odo_ini: fotoId,
          paradas: ru.paradas.map(function (n) { var nom = typeof n === "string" ? n : n.nombre; return { nombre: nom, ts: null, pax: 0, lat: null, lng: null, hora_prog: typeof n === "string" ? null : (sel === "entrada" ? n.h_ent : n.h_sal) || null }; }),
          pax_total: 0, km_gps: 0, km_odo: null, incidencias: [], estado: "en_ruta", synced: false, dispositivo: dispositivo()
        };
        return guardarPrefs({ chofer_id: ch.id, chofer_nombre: ch.nombre, unidad_id: un.id, ruta_id: ru.id, turno: sel }).then(function () { return DB.put("viajes", v); }).then(function () { state.viaje = v; iniciarSeguimiento(); nav("viaje"); });
      });
    };
    $app.querySelectorAll("[data-nav]").forEach(function (b) { b.onclick = function () { nav(b.dataset.nav); }; });
  }

  /* ---------- VISTA: viaje en curso ---------- */
  function vViaje() {
    var v = state.viaje, idx = v.paradas.findIndex(function (p) { return p.ts == null; });
    var html = hdr(v.unidad_id + " · " + v.ruta_id + " " + (v.turno === "entrada" ? "Entrada" : "Salida"),
      "Salió " + fmtHora(v.salida_ts) + " · " + minutosDesde(v.salida_ts) + " min en ruta",
      v.turno === "entrada" ? "Llegada programada al astillero: " + CFG.HORA_META_ENTRADA : "Salida programada del astillero: " + CFG.HORA_META_SALIDA,
      '<span class="badge">EN RUTA</span>') +
      '<div class="main"><div class="kpis"><div class="kpi"><div class="l">Pasajeros</div><div class="v">' + v.pax_total + ' <span class="s">/ ' + v.capacidad + '</span></div></div><div class="kpi"><div class="l">Km (GPS)</div><div class="v" id="kmgps">' + fmtNum(v.km_gps) + '</div></div></div>' +
      '<span class="lbl">Paradas</span>';
    v.paradas.forEach(function (p, i) {
      if (i === idx) {
        html += '<div class="card act"><div class="stop"><div class="dot act"></div><div class="t"><b>' + (i + 1) + '. ' + esc(p.nombre) + '</b><span>Ahora · ' + fmtHora(Date.now()) + (p.hora_prog ? ' · prog. ' + esc(p.hora_prog) : '') + '</span></div></div>' +
          '<div class="counter"><button class="btn sq" id="menos" aria-label="Quitar pasajero">−</button><div class="n" id="cnt">0</div><button class="btn sq pri" id="mas" aria-label="Agregar pasajero">+</button></div>' +
          '<button class="btn sel" style="width:100%" id="confirmar">Confirmar parada</button></div>';
      } else {
        html += '<div class="card"><div class="stop"><div class="dot' + (p.ts ? " ok" : "") + '"></div><div class="t"><b>' + (i + 1) + '. ' + esc(p.nombre) + '</b><span>' + (p.ts ? fmtHora(p.ts) + " · " + p.pax + " pax" : "Pendiente" + (p.hora_prog ? " · prog. " + esc(p.hora_prog) : "")) + '</span></div>' + (p.ts ? '<button class="link" data-edit="' + i + '">Editar</button>' : "") + '</div></div>';
      }
    });
    if (v.incidencias.length) html += '<div class="card warn"><h3>Incidencias</h3>' + v.incidencias.map(function (x) { return '<div class="small">' + fmtHora(x.ts) + " · " + esc(x.texto) + '</div>'; }).join("") + '</div>';
    html += '<div id="inc" style="display:none"><label for="inctxt">Describe la incidencia</label><textarea id="inctxt" placeholder="Ej. tráfico en puente, falla mecánica, pasajero sin credencial"></textarea><div class="grp" style="margin-top:8px"><button class="btn" id="incCancel">Cancelar</button><button class="btn pri" id="incSave">Guardar</button></div></div>';
    html += '</div><div class="foot"><button class="btn" style="flex:1" id="btnInc">Incidencia</button><button class="btn ok" style="flex:2;font-size:17px;font-weight:700" id="btnLlegar">' + (v.turno === "entrada" ? "Llegué al astillero" : "Llegué al destino") + '</button></div>';
    $app.innerHTML = html;
    var n = 0;
    if (idx >= 0) {
      document.getElementById("mas").onclick = function () { n++; document.getElementById("cnt").textContent = n; };
      document.getElementById("menos").onclick = function () { n = Math.max(0, n - 1); document.getElementById("cnt").textContent = n; };
      document.getElementById("confirmar").onclick = function () {
        var p = v.paradas[idx]; p.ts = Date.now(); p.pax = n; p.lat = state.lastPos ? state.lastPos.lat : null; p.lng = state.lastPos ? state.lastPos.lng : null;
        v.pax_total = v.paradas.reduce(function (s, x) { return s + (x.pax || 0); }, 0);
        if (v.pax_total > v.capacidad) toast("Atención: pasajeros superan la capacidad (" + v.capacidad + ")", true);
        DB.put("viajes", v).then(render);
      };
    }
    $app.querySelectorAll("[data-edit]").forEach(function (b) {
      b.onclick = function () { var i = +b.dataset.edit, p = v.paradas[i], nv = window.prompt("Pasajeros en " + p.nombre, p.pax); if (nv == null) return; p.pax = Math.max(0, parseInt(nv, 10) || 0); v.pax_total = v.paradas.reduce(function (s, x) { return s + (x.pax || 0); }, 0); DB.put("viajes", v).then(render); };
    });
    document.getElementById("btnInc").onclick = function () { document.getElementById("inc").style.display = "block"; document.getElementById("inctxt").focus(); };
    document.getElementById("incCancel").onclick = function () { document.getElementById("inc").style.display = "none"; };
    document.getElementById("incSave").onclick = function () { var t = document.getElementById("inctxt").value.trim(); if (!t) return; v.incidencias.push({ ts: Date.now(), texto: t }); DB.put("viajes", v).then(render); };
    document.getElementById("btnLlegar").onclick = function () { nav("llegada"); };
    iniciarSeguimiento();
  }

  /* ---------- VISTA: llegada ---------- */
  function vLlegada() {
    var v = state.viaje, pend = v.paradas.filter(function (p) { return !p.ts; }).length;
    $app.innerHTML = hdr(v.unidad_id + " · " + v.ruta_id, "Cerrar viaje", "Salida " + fmtHora(v.salida_ts) + " · " + v.pax_total + " pasajeros · " + fmtNum(v.km_gps) + " km GPS") +
      '<div class="main">' + (pend ? '<div class="card warn"><h3>' + pend + ' parada(s) sin confirmar</h3><div class="small">Se cerrarán con 0 pasajeros. Regresa si falta registrar.</div></div>' : "") +
      '<div><label for="odofin">Odómetro final (km)</label><input id="odofin" class="big" inputmode="numeric" placeholder="' + (v.odo_ini ? v.odo_ini + 25 : "148345") + '"></div>' +
      '<div><span class="lbl">Foto del odómetro (opcional)</span>' + fotoInput("odofin", "Tomar foto", null) + '</div>' +
      '<div class="card"><h3>Se registra automáticamente</h3><div class="muted">Hora de llegada · Ubicación GPS</div></div></div>' +
      '<div class="foot"><button class="btn" style="flex:1" id="volver">Volver</button><button class="btn ok" style="flex:2;font-size:17px;font-weight:700" id="cerrar">Confirmar llegada</button></div>';
    var fotoId = null;
    $app.querySelector('[data-foto="odofin"]').onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      leerFoto(f).then(function (du) { if (!du) return; fotoId = DB.uid(); DB.put("fotos", { id: fotoId, dataUrl: du, ts: Date.now() }); var ph = document.getElementById("ph-odofin"); ph.innerHTML = '<img src="' + du + '" alt="odómetro">' + ph.innerHTML.replace(/^[^<]*/, ""); });
    };
    document.getElementById("volver").onclick = function () { nav("viaje"); };
    document.getElementById("cerrar").onclick = function () {
      var odo = num(document.getElementById("odofin").value);
      if (odo != null && v.odo_ini != null && odo < v.odo_ini) { toast("El odómetro final no puede ser menor al inicial", true); return; }
      this.disabled = true; this.textContent = "Guardando…";
      getPos().then(function (pos) {
        v.llegada_ts = Date.now(); v.llegada_lat = pos ? pos.lat : null; v.llegada_lng = pos ? pos.lng : null; v.odo_fin = odo; v.foto_odo_fin = fotoId;
        v.km_odo = (odo != null && v.odo_ini != null) ? odo - v.odo_ini : null; v.estado = "cerrado";
        return DB.put("viajes", v);
      }).then(function () {
        detenerSeguimiento(); state.viaje = null;
        var r = retrasoMin(v); toast("Viaje cerrado · " + (r == null ? "" : (r <= CFG.TOLERANCIA_MIN ? "a tiempo" : "+" + r + " min")));
        SYNC.push().then(function (res) { if (res.ok && res.enviados) toast("Sincronizado: " + res.enviados + " registro(s)"); });
        nav("historial");
      });
    };
  }

  /* ---------- VISTA: combustible ---------- */
  function vCombustible() {
    var p = state.prefs || {};
    $app.innerHTML = hdr((p.unidad_id || "Unidad") + " · " + (p.chofer_nombre || "Chofer"), "Carga de combustible", fmtFecha(Date.now()) + " · " + fmtHora(Date.now())) +
      '<div class="main">' + navBar("combustible") +
      '<div class="grp"><div style="flex:1"><label for="litros">Litros</label><input id="litros" class="big" inputmode="decimal" placeholder="62.4"></div><div style="flex:1"><label for="importe">Importe (MXN)</label><input id="importe" class="big" inputmode="decimal" placeholder="1622.40"></div></div>' +
      '<div><label for="unidadc">Unidad</label><select id="unidadc">' + opts(C.unidades, p.unidad_id, "id", "nombre") + '</select></div>' +
      '<div><label for="estacion">Estación</label><select id="estacion">' + opts(C.estaciones) + '</select></div>' +
      '<div><label for="odoc">Odómetro (km)</label><input id="odoc" class="big" inputmode="numeric" placeholder="148410"></div>' +
      '<div><span class="lbl">Foto del ticket</span>' + fotoInput("ticket", "Tomar foto", null) + '</div>' +
      '<div class="card" id="rend" style="display:none"></div>' +
      '</div><div class="foot"><button class="btn pri xl" id="guardar">Guardar carga</button></div>';
    var fotoId = null;
    $app.querySelectorAll("[data-nav]").forEach(function (b) { b.onclick = function () { nav(b.dataset.nav); }; });
    $app.querySelector('[data-foto="ticket"]').onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      leerFoto(f).then(function (du) { if (!du) return; fotoId = DB.uid(); DB.put("fotos", { id: fotoId, dataUrl: du, ts: Date.now() }); var ph = document.getElementById("ph-ticket"); ph.innerHTML = '<img src="' + du + '" alt="ticket">' + ph.innerHTML.replace(/^[^<]*/, ""); });
    };
    document.getElementById("guardar").onclick = function () {
      var litros = num(document.getElementById("litros").value), importe = num(document.getElementById("importe").value), odo = num(document.getElementById("odoc").value);
      if (!litros || !importe) { toast("Captura litros e importe", true); return; }
      var un = document.getElementById("unidadc").value, btn = this; btn.disabled = true;
      getPos().then(function (pos) {
        var c = { id: DB.uid(), chofer_id: p.chofer_id || null, chofer: p.chofer_nombre || null, unidad_id: un, ts: Date.now(), litros: litros, importe: importe, estacion: document.getElementById("estacion").value, odo: odo, foto_ticket: fotoId, lat: pos ? pos.lat : null, lng: pos ? pos.lng : null, synced: false };
        return DB.put("cargas", c);
      }).then(function () { return DB.all("cargas"); }).then(function (cs) {
        var mismas = cs.filter(function (c) { return c.unidad_id === un && c.odo != null; }).sort(function (a, b) { return a.ts - b.ts; });
        if (mismas.length >= 2) { var a = mismas[mismas.length - 2], b = mismas[mismas.length - 1]; var km = b.odo - a.odo; if (km > 0) toast("Rendimiento desde última carga: " + fmtNum(km / b.litros, 2) + " km/L"); else toast("Carga guardada"); }
        else toast("Carga guardada");
        SYNC.push();
        nav("historial");
      });
    };
  }

  /* ---------- VISTA: solicitud de viaje extraordinario ---------- */
  var ESTADOS_SOL = { pendiente: ["Pendiente", "late"], asignada: ["Asignada", "run"], atendida: ["Atendida", "ok"], cancelada: ["Cancelada", "gris"] };
  function pillSol(e) { var x = ESTADOS_SOL[e] || [e, "gris"]; return '<span class="pill ' + x[1] + '">' + esc(x[0]) + '</span>'; }
  function aLocalInput(ts) { var d = new Date(ts - new Date(ts).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); }
  function vSolicitud() {
    var p = state.prefs || {}, destinos = C.destinos_extra || ["Pueblo Viejo", "Tampico"];
    var sugerida = Math.ceil((Date.now() + 3600000) / 900000) * 900000; // +1 h, redondeado a 15 min
    $app.innerHTML = hdr("Fuera del movimiento normal", "Viaje extraordinario", fmtFecha(Date.now()) + " · " + fmtHora(Date.now())) +
      '<div class="main">' + navBar("solicitud") +
      '<div><label for="req">Requisitor (nombre)</label><input id="req" value="' + esc(p.requisitor || "") + '" placeholder="Nombre de quien solicita" autocomplete="name"></div>' +
      '<div><label for="area">Área / departamento (opcional)</label><input id="area" value="' + esc(p.requisitor_area || "") + '" placeholder="Ej. Producción"></div>' +
      '<div><label for="hreq">Fecha y hora requerida</label><input id="hreq" type="datetime-local" value="' + aLocalInput(sugerida) + '"></div>' +
      '<div><span class="lbl">Cantidad de personas</span><div class="counter"><button class="btn sq" id="smenos" aria-label="Menos">−</button><div class="n" id="scnt">1</div><button class="btn sq" id="smas" aria-label="Más">+</button></div></div>' +
      '<div><span class="lbl">Destino</span><div class="grp">' + destinos.map(function (d, i) { return '<button class="btn' + (i === 0 ? " sel" : "") + '" data-dest="' + esc(d) + '">' + esc(d) + '</button>'; }).join("") + '</div></div>' +
      '<div><label for="motivo">Motivo / observaciones (opcional)</label><textarea id="motivo" placeholder="Ej. salida por tiempo extra, punto de recogida"></textarea></div>' +
      '<div id="missol"></div>' +
      '</div><div class="foot"><button class="btn pri xl" id="enviarSol">Registrar solicitud</button></div>';
    var n = 1, dest = destinos[0];
    $app.querySelectorAll("[data-nav]").forEach(function (b) { b.onclick = function () { nav(b.dataset.nav); }; });
    document.getElementById("smas").onclick = function () { n = Math.min(99, n + 1); document.getElementById("scnt").textContent = n; };
    document.getElementById("smenos").onclick = function () { n = Math.max(1, n - 1); document.getElementById("scnt").textContent = n; };
    document.getElementById("scnt").onclick = function () { var v = window.prompt("Cantidad de personas", n); if (v == null) return; var k = parseInt(v, 10); if (k > 0 && k < 1000) { n = k; this.textContent = n; } };
    $app.querySelectorAll("[data-dest]").forEach(function (b) { b.onclick = function () { dest = b.dataset.dest; $app.querySelectorAll("[data-dest]").forEach(function (x) { x.classList.toggle("sel", x === b); }); }; });
    DB.all("solicitudes").then(function (ss) {
      ss.sort(function (a, b) { return b.creado_ts - a.creado_ts; });
      var el = document.getElementById("missol"); if (!el || !ss.length) return;
      el.innerHTML = '<span class="lbl">Solicitudes registradas en este celular</span>' + ss.slice(0, 15).map(function (x) {
        return '<div class="card"><div class="stop"><div class="t"><b>' + fmtFecha(x.hora_req_ts) + " " + fmtHora(x.hora_req_ts) + " · " + esc(x.destino) + " · " + x.personas + ' pers.</b><span>' + esc(x.requisitor) + (x.unidad_id ? " · " + esc(x.unidad_id) : "") + (x.synced ? " · enviada" : "") + '</span></div>' + pillSol(x.estado) + '</div></div>';
      }).join("");
    });
    document.getElementById("enviarSol").onclick = function () {
      var req = document.getElementById("req").value.trim(), area = document.getElementById("area").value.trim();
      var hv = document.getElementById("hreq").value, hts = hv ? new Date(hv).getTime() : NaN;
      if (!req) { toast("Captura el nombre del requisitor", true); return; }
      if (isNaN(hts)) { toast("Captura la fecha y hora requerida", true); return; }
      if (hts < Date.now() - 15 * 60000) { toast("La hora requerida ya pasó", true); return; }
      var maxCap = Math.max.apply(null, C.unidades.map(function (u) { return u.capacidad || 0; }));
      if (maxCap && n > maxCap && !window.confirm(n + " personas superan la capacidad de una unidad (" + maxCap + "). ¿Registrar de todos modos?")) return;
      var btn = this; btn.disabled = true;
      var s = { id: DB.uid(), creado_ts: Date.now(), requisitor: req, area: area || null, hora_req_ts: hts, personas: n, destino: dest,
        motivo: document.getElementById("motivo").value.trim() || null, estado: "pendiente", unidad_id: null, chofer: null, actualizado_ts: Date.now(), dispositivo: dispositivo(), synced: false };
      var np = Object.assign({}, state.prefs || {}, { requisitor: req, requisitor_area: area });
      guardarPrefs(np).then(function () { return DB.put("solicitudes", s); }).then(function () {
        toast("Solicitud registrada: " + dest + " · " + fmtHora(hts) + " · " + n + " pers.");
        SYNC.push(); render();
      });
    };
  }

  /* ---------- VISTA: historial del chofer ---------- */
  function vHistorial() {
    Promise.all([DB.all("viajes"), DB.all("cargas"), DB.all("solicitudes")]).then(function (r) {
      var solicitudes = r[2];
      var viajes = r[0].sort(function (a, b) { return b.salida_ts - a.salida_ts; }), cargas = r[1].sort(function (a, b) { return b.ts - a.ts; });
      var pend = viajes.filter(function (v) { return v.estado === "cerrado" && !v.synced; }).length + cargas.filter(function (c) { return !c.synced; }).length + solicitudes.filter(function (x) { return !x.synced; }).length;
      var modo = SYNC.enabled() ? (pend ? '<span class="badge amb">' + pend + ' sin enviar</span>' : '<span class="badge">Sincronizado</span>') : '<span class="badge gris">Modo local</span>';
      var html = hdr("Historial", "Mis registros", viajes.length + " viajes · " + cargas.length + " cargas", modo) + '<div class="main">' + navBar("historial") +
        '<div class="grp">' + (SYNC.enabled() ? '<button class="btn pri" id="sync">Enviar ahora</button>' : "") + '<button class="btn" id="compartir">Compartir datos (JSON)</button></div>';
      viajes.slice(0, 30).forEach(function (v) {
        var r = retrasoMin(v), pill = v.estado !== "cerrado" ? '<span class="pill run">En ruta</span>' : (r == null ? "" : (r <= CFG.TOLERANCIA_MIN ? '<span class="pill ok">A tiempo</span>' : '<span class="pill late">+' + r + ' min</span>'));
        html += '<div class="card"><div class="stop"><div class="t"><b>' + fmtFecha(v.salida_ts) + " · " + esc(v.ruta_id) + " " + esc(v.turno) + " · " + esc(v.unidad_id) + '</b><span>' + fmtHora(v.salida_ts) + " → " + fmtHora(v.llegada_ts) + " · " + v.pax_total + " pax · " + fmtNum(kmViaje(v)) + " km" + (v.synced ? " · enviado" : "") + '</span></div>' + pill + '</div></div>';
      });
      if (cargas.length) { html += '<span class="lbl">Cargas</span>'; cargas.slice(0, 10).forEach(function (c) { html += '<div class="card"><div class="stop"><div class="t"><b>' + fmtFecha(c.ts) + " " + fmtHora(c.ts) + " · " + esc(c.unidad_id) + '</b><span>' + fmtNum(c.litros, 1) + " L · " + fmtMXN(c.importe) + " · " + esc(c.estacion) + '</span></div></div></div>'; }); }
      html += "</div>";
      $app.innerHTML = html;
      $app.querySelectorAll("[data-nav]").forEach(function (b) { b.onclick = function () { nav(b.dataset.nav); }; });
      var s = document.getElementById("sync"); if (s) s.onclick = function () { s.disabled = true; SYNC.push().then(function (res) { toast(res.ok ? "Enviados: " + res.enviados : "Error: " + res.error, !res.ok); render(); }); };
      document.getElementById("compartir").onclick = function () {
        var data = JSON.stringify({ exportado: new Date().toISOString(), viajes: viajes, cargas: cargas, solicitudes: solicitudes });
        var blob = new Blob([data], { type: "application/json" }), name = "transporte_" + new Date().toISOString().slice(0, 10) + ".json";
        var file = new File([blob], name, { type: "application/json" });
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: "Datos de transporte" }).catch(function () {}); }
        else { var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); }
      };
    });
  }

  /* ---------- VISTA: supervisor ---------- */
  function vSupervisor() {
    if (!state.supervisorOk) {
      $app.innerHTML = hdr("Acceso", "Supervisor", "Captura el PIN") + '<div class="main">' + navBar("supervisor") + '<div><label for="pin">PIN</label><input id="pin" class="big" type="password" inputmode="numeric"></div><button class="btn pri xl" id="entrar">Entrar</button></div>';
      $app.querySelectorAll("[data-nav]").forEach(function (b) { b.onclick = function () { nav(b.dataset.nav); }; });
      document.getElementById("entrar").onclick = function () { if (document.getElementById("pin").value === CFG.PIN_SUPERVISOR) { state.supervisorOk = true; render(); } else toast("PIN incorrecto", true); };
      return;
    }
    Promise.all([DB.all("viajes"), DB.all("cargas"), state.remoto ? Promise.resolve(state.remoto) : SYNC.pull(), DB.all("solicitudes")]).then(function (r) {
      var viajes = r[0], cargas = r[1], remoto = r[2], sols = r[3];
      if (remoto && remoto.solicitudes) { var sid = {}; sols.forEach(function (x) { sid[x.id] = x; }); remoto.solicitudes.forEach(function (x) { var l = sid[x.id]; if (!l) sols.push(x); else if ((x.actualizado_ts || 0) > (l.actualizado_ts || 0)) sols[sols.indexOf(l)] = x; }); }
      if (remoto) { state.remoto = remoto; var ids = {}; viajes.forEach(function (v) { ids[v.id] = 1; }); remoto.viajes.forEach(function (v) { if (!ids[v.id]) viajes.push(v); }); var cid = {}; cargas.forEach(function (c) { cid[c.id] = 1; }); remoto.cargas.forEach(function (c) { if (!cid[c.id]) cargas.push(c); }); }
      var dias = state.periodo === "todo" ? 36500 : parseInt(state.periodo, 10), desde = Date.now() - dias * 86400000;
      if (state.periodo === "hoy") { var d0 = new Date(); d0.setHours(0, 0, 0, 0); desde = d0.getTime(); }
      var V = viajes.filter(function (v) { return v.estado === "cerrado" && v.salida_ts >= desde; }).sort(function (a, b) { return b.salida_ts - a.salida_ts; });
      var K = cargas.filter(function (c) { return c.ts >= desde; });
      var SP = sols.filter(function (x) { return x.estado === "pendiente" || x.estado === "asignada" || x.hora_req_ts >= desde; }).sort(function (a, b) { var pa = a.estado === "pendiente" ? 0 : 1, pb = b.estado === "pendiente" ? 0 : 1; return pa - pb || a.hora_req_ts - b.hora_req_ts; });
      var n = V.length, aTiempo = V.filter(function (v) { var r = retrasoMin(v); return r != null && r <= CFG.TOLERANCIA_MIN; }).length;
      var pax = V.reduce(function (s, v) { return s + (v.pax_total || 0); }, 0), cap = V.reduce(function (s, v) { return s + (v.capacidad || 0); }, 0);
      var km = V.reduce(function (s, v) { return s + kmViaje(v); }, 0), litros = K.reduce(function (s, c) { return s + (c.litros || 0); }, 0), gasto = K.reduce(function (s, c) { return s + (c.importe || 0); }, 0);
      var unidades = {}; V.forEach(function (v) { unidades[v.unidad_id] = 1; });
      var porRuta = {}; V.forEach(function (v) { var o = porRuta[v.ruta_id] || (porRuta[v.ruta_id] = { pax: 0, cap: 0, n: 0, tarde: 0 }); o.pax += v.pax_total || 0; o.cap += v.capacidad || 0; o.n++; var r = retrasoMin(v); if (r != null && r > CFG.TOLERANCIA_MIN) o.tarde++; });
      function kpi(l, v, s, cls) { return '<div class="kpi"><div class="l">' + l + '</div><div class="v">' + v + '</div><div class="s ' + (cls || "") + '">' + s + '</div></div>'; }
      var html = hdr("Transporte de personal · Astillero", "Dashboard", (remoto ? "Datos de todos los choferes (Supabase)" : "Datos de este dispositivo" + (SYNC.enabled() ? " · sin conexión al servidor" : " · modo local")), '<span class="badge gris">Supervisor</span>') +
        '<div class="main">' + navBar("supervisor") +
        '<div class="tabs">' + [["hoy", "Hoy"], ["7", "7 días"], ["30", "30 días"], ["todo", "Todo"]].map(function (p) { return '<button class="btn' + (state.periodo === p[0] ? " sel" : "") + '" data-per="' + p[0] + '">' + p[1] + '</button>'; }).join("") + '</div>' +
        '<div class="kpis">' +
        kpi("Puntualidad", n ? Math.round(100 * aTiempo / n) + "%" : "—", n ? (n - aTiempo) + " viaje(s) tarde de " + n : "sin viajes", n && aTiempo / n >= 0.95 ? "ok" : (n ? "bad" : "")) +
        kpi("Ocupación", cap ? Math.round(100 * pax / cap) + "%" : "—", fmtNum(pax, 0) + " pasajeros / " + n + " viajes") +
        kpi("Km recorridos", fmtNum(km, 0), Object.keys(unidades).length + " unidad(es)") +
        kpi("Rendimiento", litros ? fmtNum(km / litros, 2) + ' <span class="s">km/L</span>' : "—", fmtNum(litros, 0) + " L cargados", "") +
        kpi("Costo / pasajero", pax && gasto ? fmtMXN(gasto / pax) : "—", "Combustible " + fmtMXN(gasto)) + '</div>' +
        '<div class="two"><div class="card"><h3>Ocupación por ruta</h3>' + (Object.keys(porRuta).length ? Object.keys(porRuta).map(function (r) { var o = porRuta[r], pct = o.cap ? Math.round(100 * o.pax / o.cap) : 0; return '<div class="rowb"><span>' + esc(r) + ' (' + o.n + ')</span><div class="bar"><div class="' + (pct < 60 ? 'amb' : '') + '" style="width:' + pct + '%"></div></div><b>' + pct + '%</b></div>'; }).join("") : '<div class="muted">Sin datos en el periodo</div>') + '</div>' +
        '<div class="card"><h3>Retrasos por ruta</h3>' + (Object.keys(porRuta).length ? Object.keys(porRuta).map(function (r) { var o = porRuta[r], pct = o.n ? Math.round(100 * o.tarde / o.n) : 0; return '<div class="rowb"><span>' + esc(r) + '</span><div class="bar"><div class="amb" style="width:' + pct + '%"></div></div><b>' + o.tarde + '</b></div>'; }).join("") : '<div class="muted">Sin datos en el periodo</div>') + '</div></div>' +
        '<div class="card"><div class="row" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h3 style="margin:0">Viajes</h3><div class="grp"><button class="link" id="csvV">Exportar CSV</button></div></div><div class="scroll"><table><thead><tr><th>Fecha</th><th>Unidad</th><th>Chofer</th><th>Ruta / turno</th><th>Salida</th><th>Llegada</th><th>Pax</th><th>Km</th><th>Estado</th></tr></thead><tbody>' +
        (V.length ? V.slice(0, 200).map(function (v) { var r = retrasoMin(v); return '<tr><td>' + fmtFecha(v.salida_ts) + '</td><td><b>' + esc(v.unidad_id) + '</b></td><td>' + esc(v.chofer) + '</td><td>' + esc(v.ruta_id) + " · " + esc(v.turno) + '</td><td>' + fmtHora(v.salida_ts) + '</td><td>' + fmtHora(v.llegada_ts) + '</td><td>' + v.pax_total + "/" + v.capacidad + '</td><td>' + fmtNum(kmViaje(v)) + '</td><td>' + (r == null ? "—" : (r <= CFG.TOLERANCIA_MIN ? '<span class="pill ok">A tiempo</span>' : '<span class="pill late">+' + r + ' min</span>')) + (v.incidencias && v.incidencias.length ? ' <span class="pill late">' + v.incidencias.length + ' inc.</span>' : "") + '</td></tr>'; }).join("") : '<tr><td colspan="9" class="muted">Sin viajes cerrados en el periodo</td></tr>') + '</tbody></table></div></div>' +
        '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><h3 style="margin:0">Cargas de combustible</h3><button class="link" id="csvC">Exportar CSV</button></div><div class="scroll"><table><thead><tr><th>Fecha</th><th>Unidad</th><th>Chofer</th><th>Litros</th><th>Importe</th><th>$/L</th><th>Odómetro</th><th>Estación</th></tr></thead><tbody>' +
        (K.length ? K.sort(function (a, b) { return b.ts - a.ts; }).map(function (c) { return '<tr><td>' + fmtFecha(c.ts) + " " + fmtHora(c.ts) + '</td><td><b>' + esc(c.unidad_id) + '</b></td><td>' + esc(c.chofer) + '</td><td>' + fmtNum(c.litros, 1) + '</td><td>' + fmtMXN(c.importe) + '</td><td>' + fmtMXN(c.importe / c.litros) + '</td><td>' + fmtNum(c.odo, 0) + '</td><td>' + esc(c.estacion) + '</td></tr>'; }).join("") : '<tr><td colspan="8" class="muted">Sin cargas en el periodo</td></tr>') + '</tbody></table></div></div>' +
        '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px"><h3 style="margin:0">Viajes extraordinarios</h3><button class="link" id="csvS">Exportar CSV</button></div>' +
        (SP.length ? '<div class="small" style="margin-bottom:8px"><b>' + SP.filter(function (x) { return x.estado === "pendiente"; }).length + '</b> pendiente(s) por atender</div>' : "") +
        '<div class="scroll"><table><thead><tr><th>Hora requerida</th><th>Destino</th><th>Pers.</th><th>Estado</th><th>Acción</th><th>Requisitor</th><th>Motivo</th><th>Unidad</th></tr></thead><tbody>' +
        (SP.length ? SP.map(function (x) { return '<tr><td><b>' + fmtFecha(x.hora_req_ts) + " " + fmtHora(x.hora_req_ts) + '</b></td><td>' + esc(x.destino) + '</td><td>' + x.personas + '</td><td>' + pillSol(x.estado) + '</td><td>' +
          (x.estado === "pendiente" ? '<button class="link" data-sol="' + esc(x.id) + '" data-acc="asignar">Asignar</button> · ' : "") +
          (x.estado === "pendiente" || x.estado === "asignada" ? '<button class="link" data-sol="' + esc(x.id) + '" data-acc="atendida">Atendida</button> · <button class="link" data-sol="' + esc(x.id) + '" data-acc="cancelada">Cancelar</button>' : "—") +
          '</td><td>' + esc(x.requisitor) + (x.area ? '<div class="small">' + esc(x.area) + '</div>' : "") + '</td><td>' + esc(x.motivo || "—") + '</td><td>' + esc(x.unidad_id || "—") + (x.chofer ? '<div class="small">' + esc(x.chofer) + '</div>' : "") + '</td></tr>'; }).join("") : '<tr><td colspan="8" class="muted">Sin solicitudes en el periodo</td></tr>') + '</tbody></table></div></div>' +
        '<div class="card"><h3>Importar datos de otro celular (JSON)</h3><div class="small" style="margin-bottom:8px">Útil en modo local: el chofer comparte su archivo y aquí se consolida.</div><input type="file" accept="application/json,.json" id="imp" style="height:auto;padding:10px"></div>' +
        '<div class="grp"><button class="btn pri" id="irConfig">Configuración (choferes, unidades, rutas, horarios)</button></div>' +
        '<button class="link" id="salir">Cerrar sesión de supervisor</button></div>';
      $app.innerHTML = html;
      $app.querySelectorAll("[data-nav]").forEach(function (b) { b.onclick = function () { nav(b.dataset.nav); }; });
      $app.querySelectorAll("[data-per]").forEach(function (b) { b.onclick = function () { state.periodo = b.dataset.per; render(); }; });
      document.getElementById("salir").onclick = function () { state.supervisorOk = false; nav("inicio"); };
      document.getElementById("irConfig").onclick = function () { nav("configuracion"); };
      document.getElementById("csvV").onclick = function () { descargarCSV("viajes", ["id", "fecha", "unidad", "chofer", "ruta", "turno", "salida", "llegada", "retraso_min", "pasajeros", "capacidad", "km", "km_gps", "odo_ini", "odo_fin", "paradas", "incidencias", "salida_lat", "salida_lng", "llegada_lat", "llegada_lng"], V.map(function (v) { return [v.id, new Date(v.salida_ts).toISOString().slice(0, 10), v.unidad_id, v.chofer, v.ruta_id, v.turno, fmtHora(v.salida_ts), fmtHora(v.llegada_ts), retrasoMin(v), v.pax_total, v.capacidad, kmViaje(v), v.km_gps, v.odo_ini, v.odo_fin, (v.paradas || []).map(function (p) { return p.nombre + ":" + p.pax; }).join(" | "), (v.incidencias || []).map(function (i) { return i.texto; }).join(" | "), v.salida_lat, v.salida_lng, v.llegada_lat, v.llegada_lng]; })); };
      document.getElementById("csvC").onclick = function () { descargarCSV("cargas", ["id", "fecha", "hora", "unidad", "chofer", "litros", "importe", "estacion", "odometro", "lat", "lng"], K.map(function (c) { return [c.id, new Date(c.ts).toISOString().slice(0, 10), fmtHora(c.ts), c.unidad_id, c.chofer, c.litros, c.importe, c.estacion, c.odo, c.lat, c.lng]; })); };
      document.getElementById("csvS").onclick = function () { descargarCSV("viajes_extraordinarios", ["id", "registrada", "fecha_requerida", "hora_requerida", "destino", "personas", "requisitor", "area", "motivo", "estado", "unidad", "chofer"], SP.map(function (x) { return [x.id, new Date(x.creado_ts).toLocaleString("es-MX"), new Date(x.hora_req_ts).toLocaleDateString("es-MX"), fmtHora(x.hora_req_ts), x.destino, x.personas, x.requisitor, x.area, x.motivo, x.estado, x.unidad_id, x.chofer]; })); };
      $app.querySelectorAll("[data-sol]").forEach(function (b) {
        b.onclick = function () {
          var x = sols.filter(function (y) { return y.id === b.dataset.sol; })[0]; if (!x) return;
          var acc = b.dataset.acc;
          if (acc === "asignar") {
            var u = window.prompt("Unidad asignada (" + C.unidades.map(function (q) { return q.id; }).join(", ") + ")", C.unidades[0] ? C.unidades[0].id : ""); if (u == null || !u.trim()) return;
            var ch = window.prompt("Chofer asignado (opcional)", ""); x.unidad_id = u.trim(); x.chofer = ch && ch.trim() ? ch.trim() : null; x.estado = "asignada";
          } else if (acc === "cancelada") { if (!window.confirm("¿Cancelar esta solicitud?")) return; x.estado = "cancelada"; }
          else x.estado = acc;
          x.actualizado_ts = Date.now(); x.synced = false;
          DB.put("solicitudes", x).then(function () { if (state.remoto) state.remoto = null; SYNC.push().then(render); });
        };
      });
      document.getElementById("imp").onchange = function (e) {
        var f = e.target.files[0]; if (!f) return; var rd = new FileReader();
        rd.onload = function () { try { var d = JSON.parse(rd.result), n = 0; var ops = []; (d.viajes || []).forEach(function (v) { if (v && v.id) { ops.push(DB.put("viajes", v)); n++; } }); (d.cargas || []).forEach(function (c) { if (c && c.id) { ops.push(DB.put("cargas", c)); n++; } }); (d.solicitudes || []).forEach(function (x) { if (x && x.id) { ops.push(DB.put("solicitudes", x)); n++; } }); Promise.all(ops).then(function () { toast("Importados " + n + " registros"); render(); }); } catch (err) { toast("Archivo no válido", true); } };
        rd.readAsText(f);
      };
    });
  }
  function descargarCSV(nombre, cols, filas) {
    var q = function (x) { x = x == null ? "" : String(x); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
    var csv = "﻿" + cols.join(",") + "\n" + filas.map(function (r) { return r.map(q).join(","); }).join("\n");
    var a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); a.download = nombre + "_" + new Date().toISOString().slice(0, 10) + ".csv"; a.click();
  }

  /* ---------- CONFIGURACIÓN (cuestionario de arranque dentro de la app) ---------- */
  function aplicarCatalogo(cat) {
    if (!cat) return;
    if (cat.choferes && cat.choferes.length) C.choferes = cat.choferes.map(function (c, i) { return { id: c.id || ("C" + (i + 1)), nombre: c.nombre || ("Chofer " + (i + 1)), telefono: c.telefono || "" }; });
    if (cat.unidades && cat.unidades.length) C.unidades = cat.unidades.map(function (u, i) { var cap = parseInt(u.capacidad, 10) || 20; return { id: u.id || ("U-0" + (i + 1)), nombre: (u.id || ("U-0" + (i + 1))) + " · " + cap + " pax" + (u.descripcion ? " · " + u.descripcion : ""), capacidad: cap, descripcion: u.descripcion || "", odometro: u.odometro || null }; });
    if (cat.rutas && cat.rutas.length) C.rutas = cat.rutas.map(function (r, i) { return { id: r.id || ("R" + (i + 1)), nombre: (r.id || ("R" + (i + 1))) + " · " + (r.nombre || "Ruta " + (i + 1)), origen: r.origen || "", paradas: (r.paradas || []).filter(function (p) { return p && p.nombre; }).map(function (p) { return { nombre: p.nombre, h_ent: p.h_ent || "", h_sal: p.h_sal || "" }; }) }; });
    if (cat.estaciones && cat.estaciones.length) C.estaciones = cat.estaciones.filter(Boolean);
  }
  function aplicarAjustes(a) {
    if (!a) return;
    if (a.hora_meta_entrada) CFG.HORA_META_ENTRADA = a.hora_meta_entrada;
    if (a.hora_meta_salida) CFG.HORA_META_SALIDA = a.hora_meta_salida;
    if (a.tolerancia != null && a.tolerancia !== "") CFG.TOLERANCIA_MIN = parseInt(a.tolerancia, 10) || 0;
    if (a.pin && /^\d{4}$/.test(a.pin)) CFG.PIN_SUPERVISOR = a.pin;
  }
  function borradorDesdeActual() {
    return {
      choferes: C.choferes.map(function (c) { return { id: c.id, nombre: c.nombre, telefono: c.telefono || "" }; }),
      unidades: C.unidades.map(function (u) { return { id: u.id, descripcion: u.descripcion || "", capacidad: u.capacidad, odometro: u.odometro || "" }; }),
      rutas: C.rutas.map(function (r) { return { id: r.id, nombre: r.nombre.replace(/^R\d+ · /, ""), origen: r.origen || "", paradas: r.paradas.map(function (p) { return typeof p === "string" ? { nombre: p, h_ent: "", h_sal: "" } : { nombre: p.nombre, h_ent: p.h_ent || "", h_sal: p.h_sal || "" }; }) }; }),
      estaciones: C.estaciones.slice(),
      ajustes: { hora_meta_entrada: CFG.HORA_META_ENTRADA, hora_meta_salida: CFG.HORA_META_SALIDA, tolerancia: CFG.TOLERANCIA_MIN, pin: "", dias: "", conteo: "parada", credencial: "no", dispositivo: "chofer", de_pie: "no", precio_litro: "", forma_pago: "", supervisor: "", supervisor_tel: "", reporte: "semanal", incidencias: "" }
    };
  }
  function vConfiguracion() {
    if (!state.supervisorOk) { nav("supervisor"); return; }
    var pend = DB.get("config", "ajustes").then(function (a) {
      if (!state.cfgDraft) { state.cfgDraft = borradorDesdeActual(); if (a && a.v) Object.assign(state.cfgDraft.ajustes, a.v, { pin: "" }); }
    });
    pend.then(function () {
      var d = state.cfgDraft, sec = state.cfgSec || "choferes";
      function inp(path, val, ph, type, extra) { return '<input data-p="' + path + '" type="' + (type || "text") + '" value="' + esc(val == null ? "" : val) + '" placeholder="' + esc(ph || "") + '" ' + (extra || "") + '>'; }
      function selIn(path, val, opciones) { return '<select data-p="' + path + '">' + opciones.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === val ? " selected" : "") + '>' + o[1] + '</option>'; }).join("") + '</select>'; }
      var tabs = [["choferes", "Choferes"], ["unidades", "Unidades"], ["rutas", "Rutas"], ["horarios", "Horarios"], ["reglas", "Reglas"]];
      var html = hdr("Configuración", "Datos del piloto", "Lo que captures aquí es lo que usa la app", '<span class="badge gris">Supervisor</span>') + '<div class="main">' +
        '<div class="tabs compact">' + tabs.map(function (t) { return '<button class="btn' + (sec === t[0] ? " sel" : "") + '" data-sec="' + t[0] + '">' + t[1] + '</button>'; }).join("") + '</div>';
      if (sec === "choferes") {
        html += '<div class="small">Un renglón por chofer. El celular Android es necesario para capturar viajes.</div>';
        d.choferes.forEach(function (c, i) {
          html += '<div class="card"><div class="grp"><div style="flex:2"><label>Nombre completo</label>' + inp("choferes." + i + ".nombre", c.nombre, "Nombre y apellidos") + '</div><div style="flex:1"><label>Clave</label>' + inp("choferes." + i + ".id", c.id, "C01") + '</div></div>' +
            '<div class="grp" style="margin-top:8px;align-items:flex-end"><div style="flex:1"><label>Teléfono / WhatsApp</label>' + inp("choferes." + i + ".telefono", c.telefono, "10 dígitos", "tel") + '</div><button class="btn" data-del="choferes.' + i + '" aria-label="Quitar chofer">Quitar</button></div></div>';
        });
        html += '<button class="btn sel" data-add="choferes">+ Agregar chofer</button>';
      }
      if (sec === "unidades") {
        html += '<div class="small">Capacidad = asientos para pasajeros. El odómetro actual arranca el control de kilómetros.</div>';
        d.unidades.forEach(function (u, i) {
          html += '<div class="card"><div class="grp"><div style="flex:1"><label>Clave</label>' + inp("unidades." + i + ".id", u.id, "U-01") + '</div><div style="flex:2"><label>Marca / modelo / placas</label>' + inp("unidades." + i + ".descripcion", u.descripcion, "Sprinter 2019 · ABC-123") + '</div></div>' +
            '<div class="grp" style="margin-top:8px;align-items:flex-end"><div style="flex:1"><label>Capacidad (pax)</label>' + inp("unidades." + i + ".capacidad", u.capacidad, "20", "number", 'inputmode="numeric"') + '</div><div style="flex:1"><label>Odómetro actual (km)</label>' + inp("unidades." + i + ".odometro", u.odometro, "148320", "number", 'inputmode="numeric"') + '</div><button class="btn" data-del="unidades.' + i + '" aria-label="Quitar unidad">Quitar</button></div></div>';
        });
        html += '<button class="btn sel" data-add="unidades">+ Agregar unidad</button>';
      }
      if (sec === "rutas") {
        html += '<div class="small">Hora programada = hora a la que la unidad debe estar en la parada (entrada y salida).</div>';
        d.rutas.forEach(function (r, i) {
          html += '<div class="card act"><div class="grp"><div style="flex:1"><label>Clave</label>' + inp("rutas." + i + ".id", r.id, "R1") + '</div><div style="flex:3"><label>Nombre de la ruta</label>' + inp("rutas." + i + ".nombre", r.nombre, "Centro → Astillero") + '</div></div>' +
            '<div style="margin-top:8px"><label>Punto de partida (origen)</label>' + inp("rutas." + i + ".origen", r.origen, "Plaza principal") + '</div>' +
            '<div class="lbl" style="margin-top:12px">Paradas en orden</div>';
          r.paradas.forEach(function (p, j) {
            html += '<div class="card" style="padding:10px;margin-bottom:8px"><div class="grp" style="align-items:flex-end"><div style="flex:1"><label>' + (j + 1) + '. Parada</label>' + inp("rutas." + i + ".paradas." + j + ".nombre", p.nombre, "Referencia clara") + '</div><button class="btn" style="padding:0 16px;flex:none" data-del="rutas.' + i + '.paradas.' + j + '" aria-label="Quitar parada">×</button></div><div class="grp" style="margin-top:8px"><div style="flex:1"><label>Hora prog. entrada</label>' + inp("rutas." + i + ".paradas." + j + ".h_ent", p.h_ent, "05:10", "time") + '</div><div style="flex:1"><label>Hora prog. salida</label>' + inp("rutas." + i + ".paradas." + j + ".h_sal", p.h_sal, "17:30", "time") + '</div></div></div>';
          });
          html += '<div class="grp"><button class="btn sel" data-add="rutas.' + i + '.paradas">+ Parada</button><button class="btn" data-del="rutas.' + i + '">Quitar ruta</button></div></div>';
        });
        html += '<button class="btn sel" data-add="rutas">+ Agregar ruta</button>';
      }
      if (sec === "horarios") {
        var a = d.ajustes;
        html += '<div class="small">Definen el indicador de puntualidad. Tolerancia = minutos de retraso que aún cuentan como "a tiempo".</div>' +
          '<div class="card"><div class="grp"><div style="flex:1"><label>Hora meta llegada al astillero (entrada)</label>' + inp("ajustes.hora_meta_entrada", a.hora_meta_entrada, "05:50", "time") + '</div><div style="flex:1"><label>Hora meta salida (turno salida)</label>' + inp("ajustes.hora_meta_salida", a.hora_meta_salida, "17:20", "time") + '</div></div>' +
          '<div class="grp" style="margin-top:8px"><div style="flex:1"><label>Tolerancia (min)</label>' + inp("ajustes.tolerancia", a.tolerancia, "5", "number", 'inputmode="numeric"') + '</div><div style="flex:2"><label>Días de operación</label>' + inp("ajustes.dias", a.dias, "L-V / L-S / turnos especiales") + '</div></div></div>' +
          '<div class="card"><h3>Combustible</h3><div><label>Estaciones (separadas por coma)</label>' + inp("estaciones", d.estaciones.join(", "), "Estación convenio, Otra") + '</div>' +
          '<div class="grp" style="margin-top:8px"><div style="flex:1"><label>Precio por litro (MXN)</label>' + inp("ajustes.precio_litro", a.precio_litro, "26.00", "number", 'inputmode="decimal" step="0.01"') + '</div><div style="flex:1"><label>Forma de pago</label>' + selIn("ajustes.forma_pago", a.forma_pago, [["", "—"], ["efectivo", "Efectivo"], ["vale", "Tarjeta de flotilla / vale"], ["credito", "Crédito con la estación"], ["otro", "Otro"]]) + '</div></div></div>';
      }
      if (sec === "reglas") {
        var g = d.ajustes;
        html += '<div class="card"><h3>Operación</h3>' +
          '<div><label>Conteo de pasajeros</label>' + selIn("ajustes.conteo", g.conteo, [["parada", "Por parada (recomendado)"], ["total", "Total al final del viaje"]]) + '</div>' +
          '<div style="margin-top:8px"><label>¿El personal tiene credencial con QR/código de barras?</label>' + selIn("ajustes.credencial", g.credencial, [["no", "No"], ["si", "Sí (podremos pasar lista)"], ["proceso", "En proceso"]]) + '</div>' +
          '<div style="margin-top:8px"><label>Dispositivo de captura</label>' + selIn("ajustes.dispositivo", g.dispositivo, [["chofer", "Celular del chofer"], ["fijo", "Tablet/celular fijo por unidad"]]) + '</div>' +
          '<div style="margin-top:8px"><label>¿Se permiten pasajeros de pie / sobre capacidad?</label>' + selIn("ajustes.de_pie", g.de_pie, [["no", "No, nunca"], ["si", "Sí, con límite"]]) + '</div>' +
          '<div style="margin-top:8px"><label>Incidencias más frecuentes</label>' + inp("ajustes.incidencias", g.incidencias, "tráfico, fallas, retardos…") + '</div></div>' +
          '<div class="card"><h3>Supervisión y accesos</h3>' +
          '<div class="grp"><div style="flex:2"><label>Supervisor responsable</label>' + inp("ajustes.supervisor", g.supervisor, "Nombre") + '</div><div style="flex:1"><label>WhatsApp</label>' + inp("ajustes.supervisor_tel", g.supervisor_tel, "", "tel") + '</div></div>' +
          '<div class="grp" style="margin-top:8px"><div style="flex:1"><label>Reporte deseado</label>' + selIn("ajustes.reporte", g.reporte, [["diario", "Diario"], ["semanal", "Semanal"], ["mensual", "Mensual"]]) + '</div><div style="flex:1"><label>Nuevo PIN (4 dígitos)</label>' + inp("ajustes.pin", g.pin, "dejar vacío = sin cambio", "password", 'inputmode="numeric" maxlength="4"') + '</div></div></div>';
      }
      html += '<div class="card"><div class="grp"><button class="btn" id="cfgCompartir">Compartir (JSON)</button><label class="btn" style="display:flex;align-items:center;justify-content:center;margin:0">Importar<input type="file" id="cfgImportar" accept="application/json,.json" style="display:none"></label></div><div class="small" style="margin-top:8px">Comparte el JSON por WhatsApp para que otro celular importe la misma configuración.</div></div>' +
        '<button class="link" id="cfgReset">Restablecer datos de ejemplo</button>' +
        '</div><div class="foot"><button class="btn" style="flex:1" id="cfgVolver">Dashboard</button><button class="btn ok" style="flex:2;font-size:17px;font-weight:700" id="cfgGuardar">Guardar configuración</button></div>';
      $app.innerHTML = html;

      function setPath(obj, path, val) { var ks = path.split("."), o = obj; for (var i = 0; i < ks.length - 1; i++) o = o[ks[i]]; o[ks[ks.length - 1]] = val; }
      function getPath(obj, path) { return path.split(".").reduce(function (o, k) { return o[k]; }, obj); }
      $app.querySelectorAll("[data-p]").forEach(function (el) {
        el.oninput = el.onchange = function () { if (el.dataset.p === "estaciones") d.estaciones = el.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean); else setPath(d, el.dataset.p, el.value); };
      });
      $app.querySelectorAll("[data-sec]").forEach(function (b) { b.onclick = function () { state.cfgSec = b.dataset.sec; render(); }; });
      $app.querySelectorAll("[data-add]").forEach(function (b) {
        b.onclick = function () {
          var k = b.dataset.add, arr = getPath(d, k), n = arr.length + 1;
          if (k === "choferes") arr.push({ id: "C" + (n < 10 ? "0" + n : n), nombre: "", telefono: "" });
          else if (k === "unidades") arr.push({ id: "U-" + (n < 10 ? "0" + n : n), descripcion: "", capacidad: 20, odometro: "" });
          else if (k === "rutas") arr.push({ id: "R" + n, nombre: "", origen: "", paradas: [{ nombre: "", h_ent: "", h_sal: "" }] });
          else arr.push({ nombre: "", h_ent: "", h_sal: "" });
          render();
        };
      });
      $app.querySelectorAll("[data-del]").forEach(function (b) {
        b.onclick = function () { var ks = b.dataset.del.split("."), idx = parseInt(ks.pop(), 10), arr = getPath(d, ks.join(".")); arr.splice(idx, 1); render(); };
      });
      document.getElementById("cfgVolver").onclick = function () { nav("supervisor"); };
      document.getElementById("cfgReset").onclick = function () { if (!window.confirm("¿Volver a los datos de ejemplo? Se pierde lo capturado aquí.")) return; C = JSON.parse(JSON.stringify(window.CATALOGO)); CFG = Object.assign({}, window.APP_CONFIG); state.cfgDraft = null; Promise.all([DB.del("config", "catalogo"), DB.del("config", "ajustes")]).then(function () { toast("Datos de ejemplo restablecidos"); render(); }); };
      document.getElementById("cfgGuardar").onclick = function () {
        var errores = [];
        var cat = {
          choferes: d.choferes.filter(function (c) { return c.nombre && c.nombre.trim(); }),
          unidades: d.unidades.filter(function (u) { return u.id && u.id.trim(); }),
          rutas: d.rutas.filter(function (r) { return r.nombre && r.nombre.trim(); }).map(function (r) { return Object.assign({}, r, { paradas: r.paradas.filter(function (p) { return p.nombre && p.nombre.trim(); }) }); }),
          estaciones: d.estaciones
        };
        if (!cat.choferes.length) errores.push("al menos 1 chofer con nombre");
        if (!cat.unidades.length) errores.push("al menos 1 unidad");
        if (!cat.rutas.length || cat.rutas.some(function (r) { return !r.paradas.length; })) errores.push("cada ruta con al menos 1 parada");
        if (d.ajustes.pin && !/^\d{4}$/.test(d.ajustes.pin)) errores.push("PIN de 4 dígitos");
        if (errores.length) { toast("Falta: " + errores.join(", "), true); return; }
        var aj = Object.assign({}, d.ajustes); if (!aj.pin) delete aj.pin;
        Promise.all([DB.put("config", { id: "catalogo", v: cat }), DB.put("config", { id: "ajustes", v: aj })]).then(function () {
          aplicarCatalogo(cat); aplicarAjustes(aj); d.ajustes.pin = "";
          toast("Configuración guardada: " + cat.choferes.length + " choferes, " + cat.unidades.length + " unidades, " + cat.rutas.length + " rutas");
        });
      };
      document.getElementById("cfgCompartir").onclick = function () {
        var copia = JSON.parse(JSON.stringify(d)); delete copia.ajustes.pin;
        var blob = new Blob([JSON.stringify({ tipo: "configuracion_transporte", exportado: new Date().toISOString(), config: copia })], { type: "application/json" });
        var name = "configuracion_transporte.json", file = new File([blob], name, { type: "application/json" });
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) navigator.share({ files: [file], title: "Configuración transporte" }).catch(function () {});
        else { var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); }
      };
      document.getElementById("cfgImportar").onchange = function (e) {
        var f = e.target.files[0]; if (!f) return; var rd = new FileReader();
        rd.onload = function () { try { var j = JSON.parse(rd.result); if (!j.config || !j.config.choferes) throw new Error("x"); state.cfgDraft = j.config; state.cfgDraft.ajustes = Object.assign(borradorDesdeActual().ajustes, j.config.ajustes || {}, { pin: "" }); toast("Configuración importada. Revisa y guarda."); render(); } catch (err) { toast("Archivo no válido", true); } };
        rd.readAsText(f);
      };
    });
  }

  /* ---------- arranque ---------- */
  function init() {
    Promise.all([DB.get("config", "prefs"), DB.all("viajes"), DB.get("config", "catalogo"), DB.get("config", "ajustes")]).then(function (r) {
      state.prefs = r[0] ? r[0].v : null;
      if (r[2] && r[2].v) aplicarCatalogo(r[2].v);
      if (r[3] && r[3].v) aplicarAjustes(r[3].v);
      state.viaje = r[1].filter(function (v) { return v.estado === "en_ruta"; }).sort(function (a, b) { return b.salida_ts - a.salida_ts; })[0] || null;
      if (state.viaje) iniciarSeguimiento();
      window.addEventListener("hashchange", render);
      window.addEventListener("online", function () { SYNC.push(); });
      render();
    }).catch(function (e) { $app.innerHTML = '<div class="main"><div class="card warn"><h3>No se pudo abrir el almacenamiento local</h3><div class="small">' + esc(e && e.message) + '</div></div></div>'; });
  }
  window.APP = { render: render, state: state };
  init();
})();
