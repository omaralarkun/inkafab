/* =====================================================
   INKAFAB - app.js
   Catálogo, analizador STL 3D, carrito, envío por peso y
   checkout por WhatsApp. Sin base de datos: solo JSON/CSV.
   ===================================================== */

/* ============ Ofuscación de datos sensibles ============
   base64 + scramble(reverse) + XOR con clave embebida.
   Oculta a simple vista; NO es criptografía segura (clave en JS). */
const _OBF_KEY = 'INKAFAB#2026!claveDeDifusion';
function _obfXor(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) ^ _OBF_KEY.charCodeAt(i % _OBF_KEY.length));
  return out;
}
function obfuscate(str) { return btoa(_obfXor(String(str))).split('').reverse().join(''); }
function deobfuscate(b64) {
  try { return _obfXor(atob(b64.split('').reverse().join(''))); } catch (e) { return ''; }
}

let CONFIG = {
  marca: 'INKAFAB',
  whatsapp: '51959127721',
  moneda: 'S/.',
  envioJuliaca: 15,
  /* ---- Parámetros de cotización (estimados pre-laminado) ---- */
  precioPorGramoBase: 0.20,      // respaldo si el material no tiene precio_g
  manoDeObraMinima: 5,           // piso de mano de obra (S/)
  velocidadImpresionCm3Hora: 8,  // cm³ de material impreso por hora (estimación)
  factorMaterialInfill: { 0.15: 0.30, 0.30: 0.42, 0.50: 0.58, 1.0: 1.00 }, // factor de utilización por infill
  potenciaImpresoraKW: 0.15,
  precioKWh: 0.70,
  costoMaquinaHora: 2.00,
  minutosPreparacion: 5,
  tarifaManoObraMinuto: 0.20,
  margen: 0.40,
  precioMinimo: 5.00,
  igv: 0.18,
  pedidoMinimo: 50.00,
  garantia: { reglas: [
    { maxPesoG: 50, meses: 1 },
    { maxPesoG: 500, meses: 6 },
    { maxPesoG: 1000000, meses: 12 }
  ] }
};

let MATERIALS = [];
let PRODUCTS = [];
let ENVIO = [];

let cart = [];
let activeFilter = 'all';
let searchQuery = '';
let quoteData = null;
let lastAnalyzedFile = null;

const formatPrice = v => 'S/. ' + Number(v).toFixed(2);
const fmtKg = v => Number(v).toFixed(3) + ' kg';

/* ============ Motor de cotización (ESTIMACIÓN pre-laminado) ============
   El STL por sí solo no permite conocer el peso ni el tiempo reales.
   Todos estos valores son ESTIMACIONES: el resultado final depende de
   altura de capa, perímetros, top/bottom layers, soportes y otros
   parámetros del slicer (Cura, PrusaSlicer, etc.).                 */

// Normaliza el infill a un valor entre 0 y 1.
// "15"->0.15 | "15%"->0.15 | "0.30"->0.30 | "1.0"/"100"->1.00
function normalizeInfill(value) {
  let n = Number(value);
  if (typeof value === 'string') {
    const t = value.trim();
    if (t.endsWith('%')) n = Number(t.slice(0, -1));
    n = Number(t);
  }
  if (!Number.isFinite(n)) return 0.30;
  if (n > 1) n = n / 100;
  return Math.min(Math.max(n, 0), 1);
}

// Factor de utilización de material según infill (ESTIMACIÓN).
// 15% → 0.30 | 30% → 0.42 | 50% → 0.58 | 100% → 1.00
// Interpola linealmente entre los puntos definidos en CONFIG.factorMaterialInfill.
function materialFactor(infill) {
  const v = normalizeInfill(infill);
  const f = CONFIG.factorMaterialInfill || {};
  const pares = Object.keys(f)
    .map(k => ({ inf: normalizeInfill(k), fac: Number(f[k]) }))
    .filter(p => Number.isFinite(p.inf) && Number.isFinite(p.fac))
    .sort((a, b) => a.inf - b.inf);
  if (!pares.length) return 0.42;
  if (v <= pares[0].inf) return pares[0].fac;
  if (v >= pares[pares.length - 1].inf) return pares[pares.length - 1].fac;
  for (let i = 0; i < pares.length - 1; i++) {
    const a = pares[i], b = pares[i + 1];
    if (v >= a.inf && v <= b.inf) {
      const t = (v - a.inf) / ((b.inf - a.inf) || 1);
      return a.fac + (b.fac - a.fac) * t;
    }
  }
  return pares[pares.length - 1].fac;
}

// Cálculo completo de la cotización. Usado por showQuoteResult() y addCustomToCart().
// Devuelve costos internos (no mostrados) y un desglose PÚBLICO en el que el
// margen ya está distribuido entre los conceptos comerciales (nunca se muestra
// margen/utilidad/costo base).
function calculateQuote(mat, volRawCm, infill, qty) {
  qty = (Number(qty) && Number(qty) > 0) ? Number(qty) : 1;
  const infillN = normalizeInfill(infill);
  const densidad = Number(mat && mat.densidad_gcc) || 1.2;
  const precioG = Number(mat && mat.precio_g) || Number(CONFIG.precioPorGramoBase) || 0.20;
  const velocidad = Number(CONFIG.velocidadImpresionCm3Hora) || 8;      // cm³/h
  const potenciaKW = Number(CONFIG.potenciaImpresoraKW) || 0.15;
  const precioKWh = Number(CONFIG.precioKWh) || 0.70;
  const costoMaquinaHora = Number(CONFIG.costoMaquinaHora) || 2.00;
  const minutosPreparacion = Number(CONFIG.minutosPreparacion) || 5;
  const tarifaManoObraMinuto = Number(CONFIG.tarifaManoObraMinuto) || 0.20;
  const manoObraMinima = Number(CONFIG.manoDeObraMinima) || 5;
  const margen = Number(CONFIG.margen) || 0.40;
  const precioMinimo = Number(CONFIG.precioMinimo) || 5;

  const volumenCm3 = Number(volRawCm);
  const factor = materialFactor(infillN);

  // ESTIMACIÓN de peso (NO es el peso real del slicer)
  const pesoG = volumenCm3 * densidad * factor;

  // Volumen de material usado y tiempo estimado
  const volumenMaterialCm3 = pesoG / densidad;
  const tiempoHoras = Math.max(volumenMaterialCm3 / velocidad, 0.01);

  // Costos internos
  const costoMaterial = pesoG * precioG;                          // por unidad
  const costoElectricidadJob = potenciaKW * tiempoHoras * precioKWh * qty;
  const costoMaquinaJob = tiempoHoras * costoMaquinaHora * qty;
  const costoManoObraJob = Math.max(manoObraMinima, minutosPreparacion * tarifaManoObraMinuto);
  const costoBaseJob = costoMaterial * qty + costoElectricidadJob + costoMaquinaJob + costoManoObraJob;

  // Precio de venta interno (margen interno + precio mínimo)
  const precioUnitSinMargen = costoBaseJob / qty;
  const precioUnit = Math.max(precioUnitSinMargen * (1 + margen), precioMinimo);
  const total = precioUnit * qty;

  // ---- Desglose PÚBLICO (por unidad): margen/ajuste ya distribuido ----
  // Resta del piso de precio y del margen se reparte proporcionalmente y se
  // ajusta en "Preparación" para que los 4 conceptos sumen EXACTO al precio unitario.
  const materialBase = costoMaterial;
  const elecBase = costaBaseHelper(costoElectricidadJob, qty);
  const maqBase = costaBaseHelper(costoMaquinaJob, qty);
  const prepBase = costoManoObraJob / qty;
  const sumaBase = materialBase + elecBase + maqBase + prepBase;
  const distribuir = precioUnit - sumaBase;                         // margen + exceso de precio mínimo
  const share = k => sumaBase > 0 ? (k / sumaBase) : 0;

  const materialPub = materialBase + share(materialBase) * distribuir;
  const electricidadPub = elecBase + share(elecBase) * distribuir;
  const maquinaPub = maqBase + share(maqBase) * distribuir;
  const preparacionPub = precioUnit - (materialPub + electricidadPub + maquinaPub);

  return {
    factor, pesoG, tiempoHoras,
    // internos (no se muestran al cliente)
    costoMaterial, costoElectricidadJob, costoMaquinaJob, costoManoObraJob, costoBaseJob,
    margen, precioMinimo, precioUnit, precioUnitSinMargen, total,
    // IGV y consolidado final
    igv: Number(CONFIG.igv) || 0.18,
    subtotal: total,                                   // precio unitario × qty, sin IGV
    igvMonto: total * ((Number(CONFIG.igv) || 0.18)),
    totalConIgv: total * (1 + (Number(CONFIG.igv) || 0.18)),
    // públicos (conceptos comerciales; el desglose de costos internos NO se muestra)
    desglose: {
      material: materialPub,
      electricidad: electricidadPub,
      maquina: maquinaPub,
      preparacion: preparacionPub
    }
  };
}
function costaBaseHelper(costoJob, qty) { return (Number(costoJob) || 0) / (Number(qty) || 1); }

/* ============ Carga de datos ============ */
function parseCSV(txt) {
  const lineas = txt.split(/\r?\n/).filter(l => l.trim() !== '');
  if (!lineas.length) return [];
  const cab = lineas[0].split(';');
  return lineas.slice(1).map(l => {
    const c = l.split(';');
    const o = {};
    cab.forEach((k, i) => {
      const val = (c[i] || '').trim();
      o[k.trim()] = /^-?\d+(\.\d+)?$/.test(val) ? Number(val) : val;
    });
    return o;
  });
}

async function loadData() {
  const fallbackProductos = [
    { "id":1,"name":"Figura Articulada Dragonite","type":"decorativo","category":"figuras","material":"resina","price":45,"oldPrice":60,"stock":12,"peso":0.18,"resolucion":0.05,"image":"assets/img/ejemplos/dragonite.svg","features":["Resina","Alta detalle","Pintable"],"desc":"Figura coleccionable de alta precisión, ideal para detalles finos y pintado." },
    { "id":2,"name":"Organizador de Escritorio Modular","type":"organizacion","category":"organizacion","material":"pla","price":85,"oldPrice":95,"stock":8,"peso":0.42,"resolucion":0.2,"image":"assets/img/ejemplos/organizador.svg","features":["PLA","Modular"],"desc":"Organizador modular con compartimentos para lápiz, celular y notas." },
    { "id":3,"name":"Engranaje Mecánico","type":"mecanico","category":"mecanico","material":"abs","price":12,"stock":20,"peso":0.06,"resolucion":0.1,"image":"assets/img/ejemplos/engranaje.svg","features":["ABS","Precisión","Prototipo"],"desc":"Pieza mecánica de precisión, para prototipos y reparaciones." },
    { "id":4,"name":"Maceta Suculenta","type":"decorativo","category":"decorativo","material":"pla","price":28,"stock":15,"peso":0.2,"resolucion":0.2,"image":"assets/img/ejemplos/maceta.svg","features":["PLA","Color","Sostenible"],"desc":"Maceta con drenaje integrado, perfecta para decoración hogareña." },
    { "id":5,"name":"Clip de Escritorio Peques","type":"funcional","category":"funcional","material":"petg","price":45,"stock":10,"peso":0.03,"resolucion":0.1,"image":"assets/img/ejemplos/clip.svg","features":["PETG","Funcional","Gadget"],"desc":"Clip de escritorio que decora y funciona a la vez." },
    { "id":6,"name":"Robot Educativo","type":"mecanico","category":"mecanico","material":"tpu","price":150,"stock":5,"peso":0.8,"resolucion":0.2,"image":"assets/img/ejemplos/robot.svg","features":["TPU","Educativo","STEM"],"desc":"Kit educativo de robot, ideal para enseñar robótica." },
    { "id":7,"name":"Engranaje Decorativo","type":"decorativo","category":"decorativo","material":"pla","price":35,"stock":14,"peso":0.15,"resolucion":0.2,"image":"assets/img/ejemplos/engranaje-deco.svg","features":["PLA","Decorativo","Mecanismo"],"desc":"Pieza decorativa industrial con movimiento." },
    { "id":8,"name":"Banner Personalizado","type":"funcional","category":"personalizado","material":"resina","price":300,"stock":3,"peso":1.2,"resolucion":0.05,"image":"assets/img/ejemplos/banner.svg","features":["Resina","Personalizado","Logo"],"desc":"Imprime tu logo, nombre o diseño personalizado a medida." }
  ];
  const fallbackMateriales = [
    { id: 'pla', nombre: 'PLA', icono: '🌱', descripcion: 'Económico y ecológico', densidad_gcc: 1.24, precio_g: 0.20 },
    { id: 'petg', nombre: 'PETG', icono: '💧', descripcion: 'Resistente y duradero', densidad_gcc: 1.27, precio_g: 0.35 },
    { id: 'abs', nombre: 'ABS', icono: '🛡️', descripcion: 'Alta resistencia térmica', densidad_gcc: 1.04, precio_g: 0.30 },
    { id: 'tpu', nombre: 'TPU', icono: '🔧', descripcion: 'Flexible y maleable', densidad_gcc: 1.21, precio_g: 0.30 },
    { id: 'resina', nombre: 'Resina', icono: '✨', descripcion: 'Alto nivel de detalle', densidad_gcc: 1.20, precio_g: 0.50 }
  ];
  try { const r = await fetch('data/config.json'); if (r.ok) { const j = await r.json(); CONFIG = { ...CONFIG, ...j, whatsapp: j.whatsapp ? deobfuscate(j.whatsapp) : CONFIG.whatsapp }; } } catch (e) {}
  try { const r = await fetch('data/productos.json'); if (r.ok) PRODUCTS = await r.json(); } catch (e) { PRODUCTS = fallbackProductos; }
  try { const r = await fetch('data/materiales.json'); if (r.ok) MATERIALS = await r.json(); } catch (e) { MATERIALS = fallbackMateriales; }
  try { const r = await fetch('data/envio.csv'); if (r.ok) ENVIO = parseCSV(await r.text()); } catch (e) { ENVIO = []; }
  if (!Array.isArray(PRODUCTS) || !PRODUCTS.length) PRODUCTS = fallbackProductos;
}

/* ============ Materiales ============ */
function renderMaterials() {
  const grid = document.getElementById('materialsGrid');
  if (!grid) return;
  grid.innerHTML = MATERIALS.map(m => `
    <div class="material-card" data-material="${m.id}">
      <div class="material-icon">${m.icono}</div>
      <div class="material-name">${m.nombre}</div>
      <div class="material-desc">${m.descripcion}</div>
    </div>`).join('');
}

/* ============ Catálogo ============ */
function getFilteredProducts() {
  let r = PRODUCTS;
  if (activeFilter !== 'all') r = r.filter(p => p.type === activeFilter);
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    r = r.filter(p => (p.name||'').toLowerCase().includes(q) || (p.category||'').toLowerCase().includes(q) || (p.material||'').toLowerCase().includes(q));
  }
  return r;
}

function renderCatalog() {
  const grid = document.getElementById('catalogGrid');
  if (!grid) return;
  const noResults = document.getElementById('noResults');
  const products = getFilteredProducts();
  if (!products.length) {
    grid.innerHTML = '';
    if (noResults) noResults.style.display = 'block';
    return;
  }
  if (noResults) noResults.style.display = 'none';
  grid.innerHTML = products.map(p => {
    const soldOut = !p.stock || Number(p.stock) <= 0;
    return `
    <div class="product-card" data-id="${p.id}">
      <img class="product-image" src="${p.image || 'assets/img/ejemplos/placeholder.jpg'}" alt="${p.name}" loading="lazy">
      ${soldOut ? '<span class="product-badge">Agotado</span>' : ''}
      <div class="product-info">
        <div class="product-category">${p.category || ''}</div>
        <div class="product-title">${p.name}</div>
        <div class="product-desc">${p.desc || ''}</div>
        <div class="product-price">${formatPrice(p.price)}${p.oldPrice ? `<span class="product-price-old"> ${formatPrice(p.oldPrice)}</span>` : ''}</div>
        <div class="product-features">${(p.features||[]).map(f => `<span class="feature-tag">${f}</span>`).join('')}</div>
        <div class="product-meta">Peso: ${Number(p.peso||0).toFixed(2)} kg · Stock: ${p.stock ?? 0}</div>
      </div>
      <div class="product-actions">
        <button class="btn btn-primary" onclick="addToCart(${p.id},'direct')">Comprar</button>
        <a class="btn btn-outline" target="_blank" rel="noopener" href="https://wa.me/${CONFIG.whatsapp}?text=${encodeURIComponent('Hola, me interesa el producto *' + p.name + '* (' + formatPrice(p.price) + '). ¿Está disponible?')}">WhatsApp</a>
      </div>
    </div>`;
  }).join('');
}

/* ============ Garantía, testimonios, FAQ ============ */
function calcWarranty(pesoKg) {
  const pesoG = pesoKg * 1000;
  const reglas = (CONFIG.garantia && CONFIG.garantia.reglas) || [];
  let meses = 1;
  for (const r of reglas) { if (pesoG <= Number(r.maxPesoG)) { meses = r.meses; break; } }
  return meses;
}

function renderGarantia() {
  const el = document.getElementById('garantiaContent');
  if (!el) return;
  const reglas = (CONFIG.garantia && CONFIG.garantia.reglas) || [];
  el.innerHTML = `
    <div class="garantia-card">
      <h3>Garantía por resolución y peso</h3>
      <p>Nuestra garantía se calcula según el peso y la resolución del modelo. A mayor tamaño y robustez, mayor cobertura.</p>
      <ul>${reglas.map(r => `<li>Hasta ${r.maxPesoG >= 1000000 ? '500 g+' : r.maxPesoG + ' g'}: <strong>${r.meses}</strong> meses de garantía</li>`).join('')}</ul>
    </div>`;
}

function renderTestimonios() {
  const el = document.getElementById('testimonialsGrid');
  if (!el) return;
  const t = [
    { n: 'Carlos M.', c: 'Lima', d: 'Excelente calidad en las piezas. El robot educativo quedó perfecto y llegó rápido por Olva.' },
    { n: 'María F.', c: 'Arequipa', d: 'Pedí un modelo personalizado. La cotización fue instantánea y el acabado, de primera.' },
    { n: 'Jorge R.', c: 'Cusco', d: 'La garantía por peso es justa. Si una pieza falla, sabes que está cubierta.' }
  ];
  el.innerHTML = t.map(x => `
    <div class="testimonial-card">
      <div class="testi-stars">★★★★★</div>
      <p>"${x.d}"</p>
      <div class="testi-author">— ${x.n} · ${x.c}</div>
    </div>`).join('');
}

function renderFaq() {
  const el = document.getElementById('faqList');
  if (!el) return;
  const f = [
    { q: '¿Cómo calculan el precio?', a: 'Según el volumen del modelo, el material y el relleno elegidos.' },
    { q: '¿Qué métodos de pago aceptan?', a: 'Yape y Plin. Al pedir, adjunta la constancia de pago por WhatsApp para confirmar.' },
    { q: '¿Cómo envían a provincia?', a: 'Por Serpost u Olva. El costo se calcula según el peso total del pedido.' },
    { q: '¿Qué archivos puedo subir?', a: '.stl, .obj y .3mf de hasta 50MB.' }
  ];
  el.innerHTML = f.map((x, i) => `
    <div class="faq-item">
      <button class="faq-question" onclick="toggleFaq(${i})">${x.q}<span class="faq-chevron">▾</span></button>
      <div class="faq-answer" id="faqAns${i}" style="display:none">${x.a}</div>
    </div>`).join('');
}
function toggleFaq(i) {
  const a = document.getElementById('faqAns' + i);
  if (a) a.style.display = a.style.display === 'none' ? 'block' : 'none';
}

/* ============ Analizador 3D (STL) ============ */
function isLikelyBinary(buf) {
  const len = buf.byteLength;
  if (len <= 84) return false;
  const dv = new DataView(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  const count = dv.getUint32(80, true);
  if (!(count >= 1 && count < 100000000)) return false;
  // Cada triángulo binario ocupa 12 floats + 2 bytes = 50 bytes
  const expected = 84 + count * 50;
  return expected <= len && len - expected < 128; // permite algún pad
}
function detectSTLType(buf) {
  if (isLikelyBinary(buf)) return 'binary';
  const head = new TextDecoder().decode(buf.slice(0, 4000));
  return /solid|facet|outer loop|vertex/i.test(head) ? 'ascii' : 'binary';
}

function computeVolumeAscii(txt) {
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/gi;
  const verts = [];
  let m;
  while ((m = re.exec(txt)) !== null) verts.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
  return finishMeshVolume(verts);
}
function computeVolumeBinary(buf) {
  const dv = new DataView(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  const count = dv.getUint32(80, true);
  let offset = 84, verts = [];
  for (let t = 0; t < count; t++) {
    if (offset + 50 > buf.byteLength) break;
    const readV = () => {
      const r = [dv.getFloat32(offset, true), dv.getFloat32(offset+4, true), dv.getFloat32(offset+8, true)];
      offset += 12; return r;
    };
    readV(); // normal (12 bytes) se descarta
    const a = readV(), b = readV(), c = readV();
    verts.push(a, b, c);
    offset += 2; // atributo de color
  }
  return finishMeshVolume(verts);
}
function finishMeshVolume(verts) {
  _meshVerts = verts;
  let vol = 0;
  for (let i = 0; i + 2 < verts.length; i += 3) {
    const a = verts[i], b = verts[i+1], c = verts[i+2];
    vol += a[0]*(b[1]*c[2]-c[1]*b[2])
         + b[0]*(c[1]*a[2]-a[1]*c[2])
         + c[0]*(a[1]*b[2]-b[1]*a[2]);
  }
  return Math.abs(vol) / 6;
}
let _meshVerts = [];

function handleFileUpload(file) {
  if (!file) { alert('No seleccionaste archivo.'); return; }
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!['stl','obj','3mf'].includes(ext)) { alert('Formato no soportado. Usa .stl, .obj o .3mf'); return; }
  file.arrayBuffer().then(arrayBuf => {
    try {
      const arr = new Uint8Array(arrayBuf);
      const tipo = detectSTLType(arr);
      let vol;
      if (tipo === 'ascii') {
        vol = computeVolumeAscii(new TextDecoder().decode(arr));
        // Fallback: si el "ASCII" no dio caras, puede ser un binario con header "solid"
        if (!vol || isNaN(vol) || vol <= 0) vol = computeVolumeBinary(arr);
      } else {
        vol = computeVolumeBinary(arr);
        if (!vol || isNaN(vol) || vol <= 0) vol = computeVolumeAscii(new TextDecoder().decode(arr));
      }
      if (!vol || isNaN(vol) || vol <= 0) {
        throw new Error('Volumen no válido o STL abierto (no es una superficie cerrada). Verifica que el archivo tenga triángulos válidos.');
      }
      lastAnalyzedFile = {
        name: file.name, ext, volumen: vol,
        material: document.getElementById('customMaterial').value,
        color: document.getElementById('customColor').value,
        infill: parseFloat(document.getElementById('customInfill').value) || 0.3,
        unit: document.getElementById('stlUnit').value || 'mm',
        qty: parseInt(document.getElementById('customQuantity').value) || 1
      };
      showQuoteResult();
    } catch (e) { alert('No se pudo analizar el STL: ' + e.message); }
  }).catch(() => alert('Error leyendo el archivo.'));
}

function showQuoteResult() {
  const el = document.getElementById('quoteResult');
  const cf = lastAnalyzedFile;
  if (!el || !cf) return;
  // Releer los valores actuales del formulario para precios en vivo
  cf.material = document.getElementById('customMaterial').value;
  cf.color = document.getElementById('customColor').value;
  cf.infill = parseFloat(document.getElementById('customInfill').value);
  cf.unit = document.getElementById('stlUnit').value || 'mm';
  cf.qty = parseInt(document.getElementById('customQuantity').value) || 1;
  const mat = MATERIALS.find(m => m.id === cf.material);
  if (!mat) { alert('Elige un material'); return; }
  const volRawCm = cf.unit === 'cm' ? cf.volumen : cf.volumen / 1000;
  const q = calculateQuote(mat, volRawCm, cf.infill, cf.qty);

  quoteData = {
    tipo: 'custom', id: 'c' + Date.now(),
    name: 'Custom "' + cf.name.replace(/\.[^.]+$/, '') + '"',
    material: (mat.nombre || mat.id), color: cf.color, infill: cf.infill,
    pesoKg: (q.pesoG * cf.qty) / 1000, price: q.precioUnit, qty: cf.qty, total: q.total,
    file: cf.name
  };

  el.style.display = 'block';
  const precioUnitFinal = q.totalConIgv / cf.qty;   // precio unitario FINAL (IGV incluido)
  el.innerHTML = `
    <div class="quote-card">
      <h3>📐 Análisis STL</h3>
      <table>
        <tr><td>Modelo</td><td>${cf.name}</td></tr>
        <tr><td>Volumen sólido</td><td>${volRawCm.toFixed(2)} cm³</td></tr>
        <tr><td>Material</td><td>${mat.nombre} (${mat.densidad_gcc} g/cm³)</td></tr>
        <tr><td>Infill</td><td>${(cf.infill*100).toFixed(0)}%</td></tr>
      </table>
      <table class="quote-costs">
        <tr><td>Precio unidad</td><td><b>${formatPrice(precioUnitFinal)}</b></td></tr>
        <tr><td>Cantidad</td><td>${cf.qty}</td></tr>
        <tr class="total"><td>TOTAL</td><td><b>${formatPrice(q.totalConIgv)}</b></td></tr>
      </table>
      <p class="warranty-note">Garantía: ${calcWarranty(q.pesoG/1000)} meses (según peso).</p>
      <button class="btn btn-primary btn-full" onclick="addCustomToCart()">Agregar al carrito</button>
    </div>`;
  renderSTLPreview();
}

/* Vista previa 3D: proyección wireframe del STL en un <canvas> (auto-rotación).
   No depende de three.js; se dibuja siempre. */
function renderSTLPreview() {
  const wrap = document.getElementById('stlPreviewWrap');
  if (!wrap || !_meshVerts || _meshVerts.length < 3) return;
  wrap.style.display = 'block';
  wrap.innerHTML = '<canvas id="stlPreviewCanvas" width="280" height="240"></canvas><p class="stl-preview-note">Vista previa 3D sólida · girando</p>';
  const cv = document.getElementById('stlPreviewCanvas');
  const cvs = cv.getContext('2d');
  let ang = 0;
  const draw = () => {
    const W = 280, H = 240;
    cvs.clearRect(0, 0, W, H);
    ang += 0.008;

    // Rotación (Y y luego inclinación X); las 3 coordenadas se conservan
    // (x1, y1, z2) para poder calcular normales y profundidad.
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const cb = Math.cos(0.6), sb = Math.sin(0.6);
    const pts = _meshVerts.map(v => {
      const x1 = v[0]*ca + v[2]*sa;
      const z1 = -v[0]*sa + v[2]*ca;
      const y1 = v[1]*cb - z1*sb;
      const z2 = v[1]*sb + z1*cb;
      return [x1, y1, z2];
    });

    let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
    pts.forEach(p => { if(p[0]<minX)minX=p[0]; if(p[0]>maxX)maxX=p[0]; if(p[1]<minY)minY=p[1]; if(p[1]>maxY)maxY=p[1]; });
    const sc = Math.min(W/((maxX-minX)||1)*0.8, H/((maxY-minY)||1)*0.8);
    const cx = (minX+maxX)/2, cy = (minY+maxY)/2;
    const P = p => [W/2 + (p[0]-cx)*sc, H/2 - (p[1]-cy)*sc];

    // Caras con profundidad media para el algoritmo del pintor (atrás → frente)
    const caras = [];
    for (let i=0;i+2<pts.length;i+=3) {
      caras.push({ a: pts[i], b: pts[i+1], c: pts[i+2], depth: (pts[i][2]+pts[i+1][2]+pts[i+2][2])/3 });
    }
    caras.sort((x,y) => x.depth - y.depth);

    // Luz suave desde la cámara (arriba-izquierda)
    const lx = 0.4, ly = 0.5, lz = 1.0;
    caras.forEach(f => {
      const a=f.a, b=f.b, c=f.c;
      // normal = producto cruzado (b-a)×(c-a)
      const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
      const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
      let nx = uy*vz - uz*vy;
      let ny = uz*vx - ux*vz;
      let nz = ux*vy - uy*vx;
      const nl = Math.sqrt(nx*nx+ny*ny+nz*nz);
      if (!nl) return;
      nx/=nl; ny/=nl; nz/=nl;
      let i = (nx*lx + ny*ly + nz*lz);          // coseno con la luz
      i = 0.35 + 0.65 * Math.max(0, i);          // sombreado mínimo 35%
      const col = 'rgb(' + Math.round(74*i) + ',' + Math.round(125*i) + ',' + Math.round(255*i) + ')';
      cvs.fillStyle = col;
      cvs.strokeStyle = col;
      cvs.lineWidth = 0.5;                        // contorno mismo color: evita huecos
      const pa=P(a), pb=P(b), pc=P(c);
      cvs.beginPath();
      cvs.moveTo(pa[0],pa[1]);
      cvs.lineTo(pb[0],pb[1]);
      cvs.lineTo(pc[0],pc[1]);
      cvs.closePath();
      cvs.fill();
      cvs.stroke();
    });
  };
  draw();
  if (window.__stlTimer) clearInterval(window.__stlTimer);
  window.__stlTimer = setInterval(draw, 90);
}

function addCustomToCart() {
  if (!lastAnalyzedFile) return;
  const mat = MATERIALS.find(m => m.id === lastAnalyzedFile.material);
  const cf = lastAnalyzedFile;
  const volRawCm = cf.unit === 'cm' ? cf.volumen : cf.volumen / 1000;
  const q = calculateQuote(mat, volRawCm, cf.infill, cf.qty);
  const item = {
    tipo: 'custom', id: 'c' + Date.now(),
    name: 'Customizado + ' + cf.name.replace(/\.[^.]+$/, ''),
    material: (mat.nombre || mat.id), color: cf.color, infill: cf.infill,
    peso: q.pesoG * cf.qty / 1000, price: q.totalConIgv / cf.qty, qty: cf.qty, file: cf.name
  };
  cart.push(item);
  updateCartUI(); openCart();
}

/* ============ Envío ============ */
function getCartWeight() {
  return cart.reduce((s, i) => s + (Number(i.peso) || 0), 0);
}
function calcShipping(method, pesoKg) {
  if (method === 'recogida') return 0;
  if (method === 'delivery_juliaca') return Number(CONFIG.envioJuliaca) || 15;
  const fila = ENVIO.find(e => e.metodo === method && pesoKg >= e.min_kg && pesoKg <= e.max_kg);
  return fila ? Number(fila.precio) : 0;
}

/* ============ Carrito ============ */
function addToCart(productId, mode) {
  const p = PRODUCTS.find(x => x.id === Number(productId));
  if (!p) return;
  const ex = cart.find(i => i.id === p.id);
  if (ex) ex.qty++;
  else cart.push({ ...p, qty: 1, price: p.price });
  updateCartUI();
  if (mode === 'direct') openCart();
}
function changeQty(id, delta) {
  const it = cart.find(i => String(i.id) === String(id));
  if (!it) return;
  it.qty += delta;
  if (it.qty <= 0) cart = cart.filter(i => String(i.id) !== String(id));
  updateCartUI();
}
function removeFromCart(id) { cart = cart.filter(i => String(i.id) !== String(id)); updateCartUI(); }
function clearCart() { cart = []; updateCartUI(); }
function getCartSubtotal() { return cart.reduce((s, i) => s + i.price * i.qty, 0); }

function updateCartUI() {
  const countEl = document.getElementById('cartCount');
  if (countEl) countEl.textContent = cart.reduce((n, i) => n + i.qty, 0);

  const itemsEl = document.getElementById('cartItems');
  if (itemsEl) {
    if (!cart.length) {
      itemsEl.innerHTML = `<div class="cart-empty">Tu cotización está vacía.<br>Agrega modelos para solicitar tu pedido.</div>`;
    } else {
      itemsEl.innerHTML = cart.map(it => `
        <div class="cart-item">
          <div class="cart-item-top">
            <div>
              <div class="cart-item-name">${it.name}</div>
              <div class="cart-item-config">${it.material || ''} · ${it.qty} pza${it.file ? ' · ' + it.file : ''}</div>
            </div>
            <div class="text-price">${formatPrice(it.price * it.qty)}</div>
          </div>
          <div class="cart-item-actions">
            <button onclick="changeQty('${it.id}',-1)">−</button><span>${it.qty}</span>
            <button onclick="changeQty('${it.id}',1)">+</button>
            <button class="remove" onclick="removeFromCart('${it.id}')">Eliminar</button>
          </div>
        </div>`).join('');
    }
  }

  const subtotal = getCartSubtotal();            // total de productos (precio final)
  const peso = getCartWeight();
  const metodo = (document.getElementById('deliveryMethod') || {}).value || 'recogida';
  const envio = calcShipping(metodo, peso);
  const total = subtotal + envio;

  setText('shipping', formatPrice(envio));
  setText('total', formatPrice(total));

  // ---- Pedido mínimo (se evalúa sobre el total de PRODUCTOS, sin envío) ----
  const pedidoMinimo = Number(CONFIG.pedidoMinimo);
  const totalProductos = subtotal;
  const alcanzado = totalProductos >= pedidoMinimo;
  const falta = Math.max(pedidoMinimo - totalProductos, 0);

  const me = document.getElementById('minOrderBlock');
  if (me) {
    if (alcanzado) {
      me.innerHTML = `<div class="min-order-ok">✓ ¡Pedido mínimo alcanzado!<br>Ya puedes continuar con tu pedido.</div>`;
    } else {
      const pct = Math.min(totalProductos / pedidoMinimo, 1);
      me.innerHTML = `<div class="min-order-block">
        <div class="min-order-title">🔒 Pedido mínimo: ${formatPrice(pedidoMinimo)}</div>
        <div class="progress"><div class="progress-fill" style="width:${(pct*100).toFixed(1)}%"></div></div>
        <div class="min-order-msg">Te faltan <b>${formatPrice(falta)}</b> para completar tu pedido.<br>Agrega algunos productos más para continuar.</div>
      </div>`;
    }
  }

  const minSuggest = document.getElementById('minSuggestions');
  if (minSuggest) {
    if (alcanzado || !cart.length) {
      minSuggest.innerHTML = '';
    } else {
      const sugeridos = (PRODUCTS || []).slice(0, 6);
      minSuggest.innerHTML = `<div class="min-suggest-title">¿Quieres completar tu pedido?</div>
        <div class="min-suggest-grid">
          ${sugeridos.map(p => `
            <div class="min-sug-card">
              <img src="${p.image}" alt="${p.name}">
              <div class="min-sug-name">${p.name}</div>
              <div class="min-sug-price">${formatPrice(p.price)}</div>
              <button class="btn btn-outline btn-sm" onclick="addToCart(${p.id},'direct')">+ Agregar</button>
            </div>`).join('')}
        </div>`;
    }
  }

  const submitBtn = document.getElementById('submitOrder');
  if (submitBtn) submitBtn.disabled = !alcanzado;
}
function setText(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }

function openCart() {
  const sb = document.getElementById('cartSidebar'), ov = document.getElementById('cartOverlay');
  if (sb) sb.classList.add('show'); if (ov) ov.classList.add('show'); document.body.style.overflow = 'hidden';
}
function closeCart() {
  const sb = document.getElementById('cartSidebar'), ov = document.getElementById('cartOverlay');
  if (sb) sb.classList.remove('show'); if (ov) ov.classList.remove('show'); document.body.style.overflow = '';
}

/* ============ Checkout WhatsApp ============ */
async function checkoutFormSubmit(event) {
  event.preventDefault();
  const subtotalPrev = getCartSubtotal();
  const pedidoMinimo = Number(CONFIG.pedidoMinimo);
  if (subtotalPrev < pedidoMinimo) {
    return alert('El pedido aún no alcanza el mínimo de ' + formatPrice(pedidoMinimo) + '.');
  }
  const name = document.getElementById('customerName').value.trim();
  const phone = (document.getElementById('customerPhone').value || '').replace(/[^0-9]/g, '');
  const pago = document.getElementById('paymentMethod').value;
  const metodo = document.getElementById('deliveryMethod').value;
  const address = document.getElementById('customerAddress').value.trim();

  if (!name || !phone) return alert('Completa tu nombre y WhatsApp.');
  if (!/^9\d{8}$/.test(phone)) return alert('WhatsApp inválido: 9 dígitos (ej. 912345678).');
  if ((metodo === 'serpost' || metodo === 'olva') && !address) return alert('Indica tu ciudad/departamento y dirección.');

  const subtotal = getCartSubtotal();
  const peso = getCartWeight();
  const envio = calcShipping(metodo, peso);
  const total = subtotal + envio;

  const listado = cart.map(i => `• ${i.name} x${i.qty} = ${formatPrice(i.price * i.qty)}`).join('\n');
  const deliveryName = { recogida:'Recojo en taller', delivery_juliaca:'Delivery Juliaca', serpost:'Serpost', olva:'Olva' }[metodo] || metodo;

  // Nº de pedido generado en el cliente (sin servidor)
  const seq = parseInt(localStorage.getItem('inkafab_orden_seq') || '0', 10) + 1;
  localStorage.setItem('inkafab_orden_seq', String(seq));
  const orden = 'INKAFAB-' + String(seq).padStart(4, '0');

  // Guardar venta ofuscada en localStorage
  const venta = {
    orden, fecha: new Date().toLocaleString('es-PE', { hour12: false }),
    cliente: name, whatsapp: phone, pago: { yape: 'yape', plin: 'plin' }[pago] || pago,
    metodo_envio: metodo, direccion: address,
    items: cart.map(i => ({ name: i.name, qty: i.qty })),
    peso_kg: peso.toFixed(3), subtotal: subtotal.toFixed(2), envio: envio.toFixed(2), total: total.toFixed(2),
    estado: 'pendiente'
  };
  try {
    const arr = JSON.parse(localStorage.getItem('inkafab_ventas') || '[]');
    arr.push(obfuscate(JSON.stringify(venta)));
    localStorage.setItem('inkafab_ventas', JSON.stringify(arr));
  } catch (e) {}

  let msg = `Bienvenido a ${CONFIG.marca || 'INKAFAB'}.\n\n`;
  msg += `Usted lleva:\n${listado}\n\n`;
  msg += `Envío (${deliveryName}): ${envio ? formatPrice(envio) : 'Gratis'}\n`;
  msg += `COSTO TOTAL: ${formatPrice(total)}\n\n`;
  msg += `Entrega: ${deliveryName}${address ? ' · ' + address : ''}\n`;
  msg += `Contacto: ${phone} · Pago: ${pago.toUpperCase()}\n`;
  msg += `N de pedido: ${orden || 'por confirmar'}\n\n`;
  msg += `Después de enviar este mensaje, adjunte su constancia de pago por ${pago.toUpperCase()} (captura) para confirmar su pedido.`;

  clearCart(); closeCart();
  openModal('modalSuccess', orden ? `Pedido ${orden} registrado. Revisa WhatsApp para enviar tu constancia de pago.` : 'Pedido listo. Revisa WhatsApp.');
  const url = `https://wa.me/${CONFIG.whatsapp}?text=${encodeURIComponent(msg)}`;
  setTimeout(() => window.open(url, '_blank'), 1200);
}

/* ============ Modal ============ */
function openModal(id, msg) {
  const m = document.getElementById(id);
  if (!m) return;
  const t = document.getElementById('modalSuccessMsg');
  if (t && msg) t.textContent = msg;
  m.classList.add('show');
}
function closeModal(id) { const m = document.getElementById(id); if (m) m.classList.remove('show'); }

/* ============ Init ============ */
async function init() {
  await loadData();
  renderMaterials(); renderCatalog(); renderGarantia(); renderTestimonios(); renderFaq(); updateCartUI();
  const sm = document.getElementById('customMaterial');
  if (sm && MATERIALS.length) sm.innerHTML = MATERIALS.map(m => `<option value="${m.id}">${m.nombre} - ${m.descripcion}</option>`).join('');
}
init();

/* ============ Eventos ============ */
document.addEventListener('DOMContentLoaded', function () {
  const gid = id => document.getElementById(id);

  (function(){ const e = gid('cartToggle'); if (e) e.addEventListener('click', openCart); })();
  gid('cartClose')?.addEventListener('click', closeCart);
  gid('cartOverlay')?.addEventListener('click', closeCart);

  gid('resetFilters')?.addEventListener('click', () => {
    activeFilter = 'all'; searchQuery = '';
    const si = gid('searchInput'); if (si) si.value = '';
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
    renderCatalog();
  });

  const search = gid('searchInput');
  if (search) search.addEventListener('input', () => { searchQuery = search.value; renderCatalog(); });

  document.querySelectorAll('.filter-btn').forEach(btn => btn.addEventListener('click', () => {
    activeFilter = btn.dataset.filter;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === activeFilter));
    renderCatalog();
  }));

  const fileInput = gid('fileInput');
  if (fileInput) fileInput.addEventListener('change', e => handleFileUpload(e.target.files[0]));
  const fu = gid('fileUpload');
  if (fu) {
    fu.addEventListener('click', () => fileInput && fileInput.click());
    fu.addEventListener('dragover', e => { e.preventDefault(); fu.style.borderColor = 'var(--accent)'; });
    fu.addEventListener('dragleave', () => fu.style.borderColor = 'var(--primary)');
    fu.addEventListener('drop', e => { e.preventDefault(); fu.style.borderColor = 'var(--primary)'; if (e.dataTransfer.files[0]) handleFileUpload(e.dataTransfer.files[0]); });
  }

  gid('getQuote')?.addEventListener('click', () => {
    if (!lastAnalyzedFile) { alert('Primero sube un archivo STL.'); return; }
    showQuoteResult();
  });

  gid('checkoutForm')?.addEventListener('submit', checkoutFormSubmit);

  gid('deliveryMethod')?.addEventListener('change', () => {
    const dm = gid('deliveryMethod'); const ag = gid('addressGroup');
    const show = ['serpost','olva'].includes(dm.value);
    if (ag) {
      ag.style.display = show ? 'block' : 'none';
      const ta = ag.querySelector('textarea');
      if (ta) show ? ta.setAttribute('required','') : ta.removeAttribute('required');
    }
    updateCartUI();
  });

  ['customInfill','customMaterial','customColor','stlUnit'].forEach(id => {
    gid(id)?.addEventListener('change', () => { if (lastAnalyzedFile) showQuoteResult(); });
  });
  const cq = gid('customQuantity');
  if (cq) cq.addEventListener('change', () => { if (lastAnalyzedFile) showQuoteResult(); });
});