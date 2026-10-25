'use strict';
/* Painel de apuração 2026: 2º turno × 1º turno na mesma porcentagem de seções totalizadas.
   Nenhum valor é inventado: todas as curvas vêm de arquivos do TSE ou de registros públicos dele;
   valores entre dois registros são interpolados e marcados com "≈". */

const UFS = {
  br: 'Brasil (todo o país)', ac: 'Acre', al: 'Alagoas', ap: 'Amapá', am: 'Amazonas', ba: 'Bahia', ce: 'Ceará',
  df: 'Distrito Federal', es: 'Espírito Santo', go: 'Goiás', ma: 'Maranhão', mt: 'Mato Grosso',
  ms: 'Mato Grosso do Sul', mg: 'Minas Gerais', pa: 'Pará', pb: 'Paraíba', pr: 'Paraná', pe: 'Pernambuco',
  pi: 'Piauí', rj: 'Rio de Janeiro', rn: 'Rio Grande do Norte', rs: 'Rio Grande do Sul', ro: 'Rondônia',
  rr: 'Roraima', sc: 'Santa Catarina', sp: 'São Paulo', se: 'Sergipe', to: 'Tocantins', zz: 'Exterior'
};
const URL_T1 = (tipo, uf) => `data/turno1/${tipo}/${uf}.json`;
const URL_COLETOR = uf => `https://raw.githubusercontent.com/FccGith/apuracao-eleicoes-2026/dados/turno2/${uf}.json`;
const URL_TSE2 = uf => `https://resultados.tse.jus.br/oficial/ele2026/6258/dados/${uf}/${uf}-c0001-e006258-u.json`;
const URL_PLACAR2 = uf => `https://placardovoto.com/api/public/v1/historico/2026/2/presidente/${uf}/`;
const INTERVALO = 30000;
const LACUNA_MAX = 5; // p.p. de seções: acima disso não interpola nem liga a linha
const PRINCIPAIS = ['22', '13'];

const $ = id => document.getElementById(id);
const nf = (d) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const f2 = nf(2), f1 = nf(1), f0 = nf(0);
const pct = (x, d = 2) => (x == null || !isFinite(x)) ? '—' : (d === 2 ? f2 : d === 1 ? f1 : f0).format(x) + '%';
const hora = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const estado = {
  uf: 'br', t1: {}, t2: null, fontes: {}, x: 100, xManual: false,
  ultima: null, proxima: 0, carregando: false
};

/* ---------- rede ---------- */
async function getJSON(url, { timeout = 12000, nocache = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const u = nocache ? url + (url.includes('?') ? '&' : '?') + 'nocache=' + Date.now() : url;
  try {
    const r = await fetch(u, { signal: ctrl.signal, cache: 'no-store' });
    if (r.status === 404) { const e = new Error('ainda não publicado (HTTP 404)'); e.vazio = true; throw e; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = await r.text();
    if (!txt.trim()) { const e = new Error('resposta vazia'); e.vazio = true; throw e; }
    try { return JSON.parse(txt); } catch { throw new Error('JSON inválido'); }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('tempo esgotado (' + timeout / 1000 + ' s)');
    if (e instanceof TypeError) throw new Error('fonte indisponível ou bloqueada (rede/CORS)');
    throw e;
  } finally { clearTimeout(timer); }
}

/* ---------- normalização: série = {cands:[{numero,nome}], pontos:[{x,st,ts,vv,v:{n:votos},t,fonte}]} ---------- */
function deArquivo(doc, fonte) {
  if (!doc || !Array.isArray(doc.pontos) || !Array.isArray(doc.candidatos)) throw new Error('formato inesperado');
  const nums = doc.candidatos.map(c => String(c.numero));
  const ts = doc.secoes;
  const pontos = doc.pontos.map(p => {
    const v = {};
    nums.forEach((n, i) => { v[n] = Number(p.v[i]) || 0; });
    const tot = p.ts || ts;
    return { x: tot ? 100 * p.st / tot : p.pst, st: p.st, ts: tot, vv: p.vv, v, t: p.t, fonte: p.fonte || fonte, arquivo: p.arquivo, ...extras(p) };
  });
  return { cands: doc.candidatos.map(c => ({ numero: String(c.numero), nome: c.nome })), pontos: valida(pontos) };
}

function valida(pontos) {
  return pontos.filter(p => Number.isFinite(p.x) && p.st > 0 && p.ts > 0 && p.st <= p.ts && p.vv >= 0 &&
    Math.abs(Object.values(p.v).reduce((a, b) => a + b, 0) - p.vv) <= Math.max(1, p.vv * 1e-6))
    .sort((a, b) => a.st - b.st);
}

// eleitorado das seções totalizadas, comparecimento, abstenção, brancos, nulos: só quando a fonte informa
function extras(p) {
  const o = {};
  for (const k of ['apt', 'c', 'a', 'b', 'n']) if (Number.isFinite(p[k]) && p[k] >= 0) o[k] = p[k];
  return (o.c > 0 && 'a' in o && 'b' in o && 'n' in o && o.c >= p.vv + o.b + o.n - 1) ? o : {};
}

const inteiro = x => parseInt(String(x ?? 0).replace(/\./g, ''), 10) || 0;

function deTSE(d) {
  if (!d || !Array.isArray(d.carg) || d.ele !== '6258') throw new Error('formato inesperado');
  const cands = [], v = {};
  for (const a of d.carg[0].agr || []) for (const p of a.par || []) for (const c of p.cand || []) {
    if (c.dvt && c.dvt !== 'Válido') continue;
    const nome = (c.nmu || c.nm || '').toLowerCase().replace(/(^|\s)\S/g, s => s.toUpperCase());
    cands.push({ numero: String(c.n), nome });
    v[c.n] = inteiro(c.vap);
  }
  const st = inteiro(d.s?.st), ts = inteiro(d.s?.ts), vv = inteiro(d.v?.vv);
  let t = null;
  if (d.dt && d.ht) { const [dd, mm, aa] = d.dt.split('/'); t = `${aa}-${mm}-${dd}T${d.ht}-03:00`; }
  const ponto = { x: ts ? 100 * st / ts : 0, st, ts, vv, v, t, fonte: 'tse',
    ...extras({ vv, apt: inteiro(d.e?.est), c: inteiro(d.e?.c), a: inteiro(d.e?.a), b: inteiro(d.v?.vb), n: inteiro(d.v?.tvn) }) };
  return { cands, ponto, ts, finalizado: d.tf === 's', geradoEm: d.dg && d.hg ? d.dg + ' ' + d.hg : null };
}

function dePlacar(d, uf) {
  const r = d?.result;
  if (!r || String(r.election) !== '6258' || r.turn !== 2 || String(r.uf) !== uf) throw new Error('formato inesperado');
  const ts = Number(r.sections) || 0;
  const conv = (h, votos) => ({
    x: ts ? 100 * h.counted / ts : 0, st: Number(h.counted) || 0, ts: Number(h.sections) || ts,
    vv: Number(h.validVotes) || 0, v: votos, t: h.updatedAt ? new Date(h.updatedAt).toISOString() : null, fonte: 'placar'
  });
  const pts = (d.history || []).filter(h => h && h.votes && typeof h.votes === 'object')
    .map(h => conv(h, Object.fromEntries(Object.entries(h.votes).map(([k, x]) => [String(k), Number(x) || 0]))));
  if (Array.isArray(r.candidates)) {
    pts.push(conv(r, Object.fromEntries(r.candidates.filter(c => c.valid !== false).map(c => [String(c.number), Number(c.votes) || 0]))));
  }
  return valida(pts);
}

/* ---------- 2º turno: junta as fontes, sem duplicar contagens de seções ---------- */
const chaveLocal = uf => 'apuracao2026:t2:' + uf;
function lerLocal(uf) {
  try { const a = JSON.parse(localStorage.getItem(chaveLocal(uf)) || '[]'); return valida(Array.isArray(a) ? a : []); } catch { return []; }
}
function gravarLocal(uf, pontos) {
  try { localStorage.setItem(chaveLocal(uf), JSON.stringify(pontos.filter(p => p.fonte === 'tse').slice(-3000))); } catch { /* cota cheia: ignora */ }
}

async function carregarT2(uf) {
  const prioridade = { tse: 4, coletor: 3, placar: 2, local: 1 };
  const porSt = new Map();
  const add = (p, fonte) => {
    const q = { ...p, fonte: p.fonte === 'tse' ? 'tse' : fonte };
    const atual = porSt.get(q.st);
    if (!atual || prioridade[q.fonte] > prioridade[atual.fonte]) porSt.set(q.st, q);
  };
  const fontes = {};
  let cands = null, ao = null;

  const [rTse, rCol, rPla] = await Promise.allSettled([
    getJSON(URL_TSE2(uf), { nocache: true }), getJSON(URL_COLETOR(uf), { nocache: true }), getJSON(URL_PLACAR2(uf))
  ]);
  try {
    if (rTse.status === 'rejected') throw rTse.reason;
    ao = deTSE(rTse.value); cands = ao.cands;
    if (ao.ponto.st > 0) add(ao.ponto, 'tse');
    fontes.tse = { ok: true, msg: ao.ponto.st > 0 ? `${pct(ao.ponto.x)} das seções` : 'apuração ainda não iniciada (0 seções)' };
  } catch (e) { fontes.tse = { ok: false, msg: e.message }; }
  try {
    if (rCol.status === 'rejected') throw rCol.reason;
    const s = deArquivo(rCol.value, 'coletor');
    s.pontos.forEach(p => add(p, 'coletor'));
    if (!cands && s.cands.length) cands = s.cands;
    fontes.coletor = { ok: true, msg: s.pontos.length + ' parciais gravadas' };
  } catch (e) { fontes.coletor = { ok: !!e.vazio, msg: e.vazio ? 'nenhuma parcial gravada ainda' : e.message }; }
  try {
    if (rPla.status === 'rejected') throw rPla.reason;
    const pts = dePlacar(rPla.value, uf);
    pts.forEach(p => add(p, 'placar'));
    fontes.placar = { ok: true, msg: pts.length + ' parciais com votos' };
  } catch (e) { fontes.placar = { ok: !!e.vazio, msg: e.message }; }
  lerLocal(uf).forEach(p => add(p, 'local'));

  // descarta pontos com contagem total de seções diferente da do TSE (outra eleição ou erro de fonte)
  const tsRef = ao?.ts || [...porSt.values()].map(p => p.ts).sort((a, b) => b - a)[0];
  const pontos = [...porSt.values()].filter(p => !tsRef || p.ts === tsRef).sort((a, b) => a.st - b.st);
  gravarLocal(uf, pontos);
  return { cands: cands || [], pontos, ao, fontes };
}

/* ---------- interpolação claramente identificada ---------- */
const perc = (p, n) => p.vv > 0 ? 100 * (p.v[n] || 0) / p.vv : null;
const percOutros = p => p.vv > 0 ? 100 * (p.vv - PRINCIPAIS.reduce((a, n) => a + (p.v[n] || 0), 0)) / p.vv : null;

function valorEm(pontos, x, fn) {
  const pts = pontos.filter(p => p.vv > 0 && fn(p) != null);
  if (!pts.length || x < pts[0].x - 1e-9 || x > pts[pts.length - 1].x + 1e-9) return null;
  let i = pts.findIndex(p => p.x >= x - 1e-9);
  const b = pts[i];
  if (Math.abs(b.x - x) < 0.005) return { y: fn(b), exato: true, p: b };
  const a = pts[i - 1];
  if (!a) return null;
  if (b.x - a.x > LACUNA_MAX) return { y: null, lacuna: [a.x, b.x] };
  const y = fn(a) + (fn(b) - fn(a)) * (x - a.x) / (b.x - a.x);
  return { y, exato: false, a, b };
}

/* ---------- gráfico SVG ---------- */
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, pai) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (pai) pai.appendChild(e);
  return e;
};
const cor = n => getComputedStyle(document.documentElement).getPropertyValue('--series-' + (PRINCIPAIS.includes(n) ? n : 'outros')).trim();

function serie1() {
  const tipo = estado.uf === 'br' ? $('serie1').value : 'reconstruido';
  return estado.t1[estado.uf + ':' + tipo] || null;
}

function linhasVisiveis() {
  const s1 = serie1(), s2 = estado.t2;
  const linhas = [];
  for (const n of PRINCIPAIS) {
    if (s1) linhas.push({ turno: 1, n, pontos: s1.pontos, fn: p => perc(p, n) });
    if (s2 && s2.pontos.length) linhas.push({ turno: 2, n, pontos: s2.pontos, fn: p => perc(p, n) });
  }
  if ($('outros').checked && s1) linhas.push({ turno: 1, n: 'outros', pontos: s1.pontos, fn: percOutros });
  return linhas;
}

function nomeCand(n) {
  if (n === 'outros') return 'Demais (soma)';
  const c = (estado.t2?.cands || []).find(c => c.numero === n) || (serie1()?.cands || []).find(c => c.numero === n);
  return c ? c.nome : 'Nº ' + n;
}

function desenhar() {
  const box = $('grafico');
  const W = Math.max(300, box.clientWidth || 300);
  const H = Math.round(Math.min(460, Math.max(280, W * 0.6)));
  const M = { l: 44, r: 12, t: 12, b: 38 };
  const pw = W - M.l - M.r, ph = H - M.t - M.b;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  const linhas = linhasVisiveis();

  // escala Y
  let y0 = 0, y1 = 100;
  if ($('escala').value === 'auto') {
    const ys = [];
    linhas.forEach(L => L.pontos.forEach(p => { if (p.x >= 1) { const y = L.fn(p); if (y != null) ys.push(y); } }));
    if (ys.length) {
      y0 = Math.max(0, Math.floor((Math.min(...ys) - 1) / 5) * 5);
      y1 = Math.min(100, Math.ceil((Math.max(...ys) + 1) / 5) * 5);
      if (y1 - y0 < 10) y1 = Math.min(100, y0 + 10);
    }
  }
  const X = x => M.l + x / 100 * pw;
  const Y = y => M.t + (y1 - y) / (y1 - y0) * ph;
  const passoY = (y1 - y0) > 40 ? 20 : (y1 - y0) > 20 ? 10 : 5;
  const grid = el('g', {}, svg);
  for (let v = y0; v <= y1 + 1e-9; v += passoY) {
    el('line', { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), stroke: 'var(--grid)', 'stroke-width': 1 }, grid);
    el('text', { x: M.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, grid).textContent = v + '%';
  }
  const passoX = pw < 420 ? 25 : 10;
  for (let v = 0; v <= 100; v += passoX) {
    el('line', { x1: X(v), x2: X(v), y1: M.t + ph, y2: M.t + ph + 4, stroke: 'var(--axis)' }, grid);
    el('text', { x: X(v), y: M.t + ph + 18, 'text-anchor': v === 0 ? 'start' : v === 100 ? 'end' : 'middle' }, grid).textContent = v + '%';
  }
  el('line', { x1: M.l, x2: W - M.r, y1: M.t + ph, y2: M.t + ph, stroke: 'var(--axis)' }, grid);
  el('text', { x: M.l + pw / 2, y: H - 4, 'text-anchor': 'middle' }, grid).textContent = 'seções totalizadas';

  if (!linhas.length) {
    el('text', { x: M.l + pw / 2, y: M.t + ph / 2, 'text-anchor': 'middle', class: 'vazio' }, svg).textContent = 'Sem dados disponíveis para esta abrangência';
  }

  // linhas: quebra o traço onde há lacuna maior que LACUNA_MAX
  const camada = el('g', { fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  for (const L of linhas) {
    let d = '', ant = null;
    for (const p of L.pontos) {
      const y = L.fn(p);
      if (y == null) { ant = null; continue; }
      const cmd = (!ant || p.x - ant.x > LACUNA_MAX) ? 'M' : 'L';
      d += `${cmd}${X(p.x).toFixed(1)},${Y(Math.max(y0, Math.min(y1, y))).toFixed(1)}`;
      ant = p;
    }
    el('path', {
      d, stroke: cor(L.n), 'stroke-width': L.turno === 2 ? 2.75 : 2,
      'stroke-dasharray': L.turno === 1 ? '6 4' : 'none', opacity: L.turno === 1 ? 0.9 : 1
    }, camada);
    // registros isolados (sem vizinho a menos de LACUNA_MAX) viram ponto para não sumirem
    if (L.turno === 2 || L.pontos.length < 60) {
      L.pontos.forEach((p, i) => {
        const y = L.fn(p); if (y == null) return;
        const viz = [L.pontos[i - 1], L.pontos[i + 1]].some(q => q && Math.abs(q.x - p.x) <= LACUNA_MAX);
        if (!viz || i === L.pontos.length - 1 && L.turno === 2) {
          el('circle', { cx: X(p.x), cy: Y(y), r: 4, fill: cor(L.n), stroke: 'var(--surface-1)', 'stroke-width': 2 }, svg);
        }
      });
    }
  }
  // rótulos diretos no fim de cada linha do turno mais recente visível
  const rotulos = [];
  for (const L of linhas) {
    const ult = [...L.pontos].reverse().find(p => L.fn(p) != null);
    if (!ult) continue;
    const temT2 = linhas.some(o => o.turno === 2 && o.n === L.n);
    if (temT2 && L.turno === 1) continue;
    rotulos.push({ x: X(ult.x), y: Y(L.fn(ult)), txt: `${nomeCand(L.n).split(' ')[0]} ${pct(L.fn(ult), 1)}`, n: L.n });
  }
  rotulos.sort((a, b) => a.y - b.y);
  for (let i = 1; i < rotulos.length; i++) if (rotulos[i].y - rotulos[i - 1].y < 15) rotulos[i].y = rotulos[i - 1].y + 15;
  rotulos.forEach(r => {
    const inicio = r.x < M.l + 110;
    const t = el('text', { x: inicio ? r.x + 8 : Math.min(r.x - 6, W - M.r - 2), y: r.y - 6, 'text-anchor': inicio ? 'start' : 'end', class: 'rotulo' }, svg);
    t.textContent = r.txt;
  });

  // cursor de comparação
  const cx = X(estado.x);
  el('line', { x1: cx, x2: cx, y1: M.t, y2: M.t + ph, stroke: 'var(--text-secondary)', 'stroke-width': 1, 'stroke-dasharray': '2 3' }, svg);
  for (const L of linhas) {
    const r = valorEm(L.pontos, estado.x, L.fn);
    if (r && r.y != null) el('circle', { cx, cy: Y(Math.max(y0, Math.min(y1, r.y))), r: 4.5, fill: L.turno === 2 ? cor(L.n) : 'var(--surface-1)', stroke: cor(L.n), 'stroke-width': 2 }, svg);
  }
  // área de toque/arraste
  const alvo = el('rect', { x: M.l, y: 0, width: pw, height: H, fill: 'transparent' }, svg);
  const mover = ev => {
    const rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (W / rect.width);
    const x = Math.max(0, Math.min(100, Math.round((px - M.l) / pw * 400) / 4));
    if (x !== estado.x) { estado.x = x; estado.xManual = true; $('x').value = x; desenharTudoLeve(); }
  };
  alvo.addEventListener('pointerdown', ev => { mover(ev); });
  alvo.addEventListener('pointermove', ev => { if (ev.pointerType === 'mouse' || ev.buttons) mover(ev); });

  box.replaceChildren(svg);
  desenharLegenda(linhas);
}

let rafLeve = 0;
function desenharTudoLeve() {
  cancelAnimationFrame(rafLeve);
  rafLeve = requestAnimationFrame(() => { desenhar(); leitura(); saldo(); });
}

function desenharLegenda(linhas) {
  const itens = [];
  const nums = [...new Set(linhas.map(L => L.n))];
  nums.forEach(n => itens.push(`<span><i class="dot" style="--c:${cor(n)}"></i>${nomeCand(n)}</span>`));
  const amostra = (dash, w) => `<svg width="34" height="10" aria-hidden="true"><line x1="1" x2="33" y1="5" y2="5" stroke="currentColor" stroke-width="${w}" stroke-dasharray="${dash}" stroke-linecap="round"/></svg>`;
  if (linhas.some(L => L.turno === 1)) itens.push(`<span>${amostra('6 4', 2)}1º turno (04/10)${estado.uf === 'br' && $('serie1').value === 'observado' ? ' – parciais publicadas' : ' – reconstrução oficial'}</span>`);
  itens.push(`<span>${amostra('none', 2.75)}2º turno (25/10)${linhas.some(L => L.turno === 2) ? '' : ' – ainda sem parciais'}</span>`);
  $('legenda').innerHTML = itens.join('');
}

/* ---------- leitura no ponto escolhido ---------- */
function leitura() {
  const x = estado.x;
  $('x-val').textContent = pct(x); $('x-val2').textContent = pct(x);
  // resumo compacto na barra fixa, visível em qualquer parte da página
  const s1r = serie1(), s2r = estado.t2;
  const curto = (s, n) => { const r = s && s.pontos.length ? valorEm(s.pontos, x, p => perc(p, n)) : null; return !r || r.y == null ? '—' : (r.exato ? '' : '≈') + f1.format(r.y); };
  $('x-resumo').innerHTML = PRINCIPAIS.map(n => `<i class="dot" style="--c:${cor(n)}"></i>${nomeCand(n).split(' ')[0]} 1º ${curto(s1r, n)} · 2º ${curto(s2r, n)}`).join(' &nbsp; ');
  const s1 = serie1(), s2 = estado.t2;
  const nums = [...PRINCIPAIS, ...($('outros').checked ? ['outros'] : [])];
  const notas = [];
  const desc = (r, rotulo) => {
    if (!r) return null;
    if (r.lacuna) { notas.push(`${rotulo}: não há registro entre ${pct(r.lacuna[0])} e ${pct(r.lacuna[1])} das seções; o valor não é estimado.`); return null; }
    if (!r.exato) notas.push(`${rotulo}: ≈ interpolado entre os registros de ${pct(r.a.x)} e ${pct(r.b.x)} das seções.`);
    else notas.push(`${rotulo}: registro de ${pct(r.p.x)} das seções (${hora(r.p.t)}).`);
    return r;
  };
  let primeira1 = true, primeira2 = true;
  const linhas = nums.map(n => {
    const fn = n === 'outros' ? percOutros : (p => perc(p, n));
    const r1 = s1 ? valorEm(s1.pontos, x, fn) : null;
    const r2 = s2 && s2.pontos.length && n !== 'outros' ? valorEm(s2.pontos, x, fn) : null;
    if (primeira1 && r1) { desc(r1, '1º turno'); primeira1 = false; }
    if (primeira2 && r2) { desc(r2, '2º turno'); primeira2 = false; }
    const fmt = r => !r || r.y == null ? '—' : (r.exato ? '' : '≈') + pct(r.y) +
      (r.exato && n !== 'outros' ? `<br><span class="muted">${f0.format(r.p.v[n] || 0)} votos</span>` : '');
    const dif = r1?.y != null && r2?.y != null ? (r2.y - r1.y >= 0 ? '+' : '−') + f2.format(Math.abs(r2.y - r1.y)) + ' p.p.' : '—';
    return `<tr><th><i class="dot" style="--c:${cor(n)}"></i>${nomeCand(n)}</th><td class="n">${fmt(r1)}</td><td class="n">${fmt(r2)}</td><td class="n">${dif}</td></tr>`;
  });
  if (s2 && s2.pontos.length && x > s2.pontos[s2.pontos.length - 1].x + 1e-9) notas.push(`2º turno: ainda não chegou a ${pct(x)} das seções.`);
  if (!s2 || !s2.pontos.length) notas.push('2º turno: ainda não há parciais publicadas pelo TSE.');
  $('leitura').innerHTML = `<table><thead><tr><th>Em ${pct(x)} das seções</th><th class="n">1º turno</th><th class="n">2º turno</th><th class="n">Diferença</th></tr></thead><tbody>${linhas.join('')}</tbody></table>` +
    notas.map(t => `<p class="nota">${t}</p>`).join('');
}

/* ---------- brancos, nulos, abstenção e saldo dos votos ---------- */
const temExtra = p => p.c != null && p.a != null;
const eleit = p => p.c + p.a; // base que soma 100%: quem votou + quem se absteve
const CATS = [
  { k: '22', nome: () => nomeCand('22'), cor: () => cor('22'), votos: p => p.v['22'] || 0 },
  { k: '13', nome: () => nomeCand('13'), cor: () => cor('13'), votos: p => p.v['13'] || 0 },
  { k: 'outros', nome: () => 'Demais candidatos', cor: () => cor('outros'), votos: p => p.vv - (p.v['22'] || 0) - (p.v['13'] || 0) },
  { k: 'b', nome: () => 'Brancos', votos: p => p.b },
  { k: 'n', nome: () => 'Nulos', votos: p => p.n },
  { k: 'a', nome: () => 'Abstenção (não foram votar)', votos: p => p.a },
];
const sinal = d => (d >= 0 ? '+' : '−') + f2.format(Math.abs(d));

function saldo() {
  const x = estado.x, s1 = serie1(), s2 = estado.t2;
  const box = $('saldo');
  const fnE = c => p => temExtra(p) && eleit(p) > 0 ? 100 * c.votos(p) / eleit(p) : null;
  const tem1 = s1 && s1.pontos.some(temExtra);
  if (!tem1) {
    box.innerHTML = '<p class="muted">A série “parciais publicadas” do 1º turno não traz brancos, nulos e abstenção. Escolha “Reconstrução oficial por seção” para ver este quadro.</p>';
    return;
  }
  const r1 = CATS.map(c => valorEm(s1.pontos, x, fnE(c)));
  const pts2 = s2 && s2.pontos.length ? s2.pontos : [];
  const r2 = CATS.map(c => c.k === 'outros' ? null : pts2.length ? valorEm(pts2, x, fnE(c)) : null);
  // no 2º turno não há "demais candidatos": a categoria vale 0
  if (pts2.length && r2[0]?.y != null) r2[2] = { y: 0, exato: r2[0].exato };
  // TSE: brancos e nulos sobre o comparecimento; abstenção sobre o eleitorado
  const conv = (pts, f) => pts && pts.length ? valorEm(pts, x, f) : null;
  const tse = [
    ['Brancos', p => temExtra(p) && p.c ? 100 * p.b / p.c : null, 'dos votos'],
    ['Nulos', p => temExtra(p) && p.c ? 100 * p.n / p.c : null, 'dos votos'],
    ['Abstenção', p => temExtra(p) && eleit(p) ? 100 * p.a / eleit(p) : null, 'do eleitorado'],
  ];
  const v = r => !r || r.y == null ? '—' : (r.exato ? '' : '≈') + pct(r.y);
  let h = `<table class="t-saldo"><thead><tr><th>Em ${pct(x)} das seções</th><th class="n">1º turno</th><th class="n">2º turno</th></tr></thead><tbody>` +
    tse.map(([nome, f, base]) => `<tr><th>${nome} <span class="muted">(% ${base})</span></th><td class="n">${v(conv(s1.pontos, f))}</td><td class="n">${v(conv(pts2, f))}</td></tr>`).join('') +
    '</tbody></table>';

  h += `<h3>Composição do eleitorado das seções totalizadas</h3><table class="t-saldo"><thead><tr><th></th><th class="n">1º turno</th><th class="n">2º turno</th><th class="n">Saldo</th></tr></thead><tbody>` +
    CATS.map((c, i) => {
      const d = r1[i]?.y != null && r2[i]?.y != null ? r2[i].y - r1[i].y : null;
      const dot = c.cor ? `<i class="dot" style="--c:${c.cor()}"></i>` : '<i class="dot" style="--c:var(--text-muted);opacity:.4"></i>';
      return `<tr><th>${dot}${c.nome()}</th><td class="n">${v(r1[i])}</td><td class="n">${v(r2[i])}</td><td class="n">${d == null ? '—' : sinal(d) + ' p.p.'}</td></tr>`;
    }).join('') + '</tbody></table>';

  const ok = r1.every(r => r?.y != null) && r2.every(r => r?.y != null);
  if (ok) {
    const demais = r1[2].y;
    const ganhos = CATS.map((c, i) => ({ c, d: r2[i].y - r1[i].y })).filter(g => g.c.k !== 'outros');
    const pos = ganhos.filter(g => g.d > 0), somaPos = pos.reduce((a, g) => a + g.d, 0);
    h += `<h3>Para onde foi o saldo</h3><p>No 1º turno, os demais candidatos tinham <strong>${pct(demais)}</strong> do eleitorado nestas seções. ` +
      `No 2º turno, as categorias que cresceram somam <strong>${pct(somaPos)}</strong> do eleitorado:</p><div class="barras">` +
      pos.sort((a, b) => b.d - a.d).map(g => `<div class="barra-l"><span class="rot">${g.c.nome()}</span><span class="trilho"><span style="width:${Math.max(1, 100 * g.d / somaPos)}%;background:${g.c.cor ? g.c.cor() : 'var(--text-muted)'}"></span></span><span class="val">${sinal(g.d)} p.p. · ${f0.format(100 * g.d / somaPos)}%</span></div>`).join('') + '</div>';
    const neg = ganhos.filter(g => g.d < 0);
    if (neg.length) h += `<p class="muted">Diminuíram: ${neg.map(g => `${g.c.nome()} ${sinal(g.d)} p.p.`).join('; ')}</p>`;
    const u1 = s1.pontos[s1.pontos.length - 1], u2 = pts2[pts2.length - 1];
    if (x >= 100 - 1e-9 && u2 && u2.st >= u2.ts && temExtra(u1) && temExtra(u2)) {
      h += `<h3>Resultado final em votos</h3><table class="t-saldo"><thead><tr><th></th><th class="n">1º turno</th><th class="n">2º turno</th><th class="n">Diferença</th></tr></thead><tbody>` +
        CATS.map(c => { const a = c.votos(u1), b = c.k === 'outros' ? 0 : c.votos(u2); return `<tr><th>${c.nome()}</th><td class="n">${f0.format(a)}</td><td class="n">${f0.format(b)}</td><td class="n">${(b - a >= 0 ? '+' : '−') + f0.format(Math.abs(b - a))}</td></tr>`; }).join('') + '</tbody></table>';
    }
  } else if (!pts2.length) {
    h += '<p class="muted">O saldo aparece quando o TSE publicar as parciais do 2º turno.</p>';
  } else {
    h += `<p class="muted">O 2º turno ainda não chegou a ${pct(x)} das seções (ou a parcial não traz esses campos).</p>`;
  }
  h += '<p class="nota muted">O saldo é líquido: mostra quanto cada categoria cresceu ou diminuiu entre os turnos, como fração do eleitorado das seções totalizadas. Não é a migração de cada eleitor (o voto é secreto): parte do crescimento de um candidato pode vir de quem votou no adversário, em branco ou se absteve no 1º turno, e vice-versa. Na mesma % de seções, as seções totalizadas nos dois turnos não são necessariamente as mesmas.</p>';
  box.innerHTML = h;
}

/* ---------- cartões do 2º turno, tabela e fontes ---------- */
function cartoes() {
  const s2 = estado.t2, ao = s2?.ao;
  $('local2').textContent = '· ' + UFS[estado.uf];
  const ult = s2?.pontos[s2.pontos.length - 1];
  const ts = ao?.ts || ult?.ts;
  if (!ult) {
    $('progresso2').innerHTML = `<div class="num">0,00%</div><div class="barra"><span style="width:0"></span></div>` +
      `<div class="muted">${ao ? 'A apuração do 2º turno ainda não começou: o TSE divulga as parciais a partir das 17h (Brasília) de 25/10. ' + f0.format(ts || 0) + ' seções a totalizar.' : 'Não foi possível ler o arquivo do TSE agora; nova tentativa em 30 s.'}</div>`;
  } else {
    $('progresso2').innerHTML = `<div class="num">${pct(ult.x)}</div><div class="barra"><span style="width:${ult.x}%"></span></div>` +
      `<div class="muted">${f0.format(ult.st)} de ${f0.format(ult.ts)} seções totalizadas · totalização do TSE: ${hora(ult.t)}${ao?.finalizado ? ' · totalização encerrada' : ''}</div>`;
  }
  const cands = (s2?.cands?.length ? s2.cands : PRINCIPAIS.map(n => ({ numero: n, nome: nomeCand(n) })));
  const s1 = serie1();
  $('cands2').innerHTML = cands.map(c => {
    const y = ult ? perc(ult, c.numero) : null;
    const r1 = s1 && ult ? valorEm(s1.pontos, ult.x, p => perc(p, c.numero)) : null;
    const comp = r1?.y != null ? `<div class="det">1º turno em ${pct(ult.x)} das seções: ${r1.exato ? '' : '≈'}${pct(r1.y)}</div>` : '';
    return `<div class="cand" style="--c:${cor(c.numero)}"><div class="nome">${c.nome} <span class="muted">(${c.numero})</span></div>` +
      `<div class="pct">${ult ? pct(y) : '—'}</div><div class="det">${ult ? f0.format(ult.v[c.numero] || 0) + ' votos' : 'sem votos totalizados'}</div>${comp}</div>`;
  }).join('');
}

function tabela() {
  const s1 = serie1(), s2 = estado.t2;
  const cel = (s, n, x) => {
    if (!s) return '—';
    const r = valorEm(s.pontos, x, p => perc(p, n));
    return !r || r.y == null ? '—' : (r.exato ? '' : '≈') + pct(r.y);
  };
  let h = `<thead><tr><th>Seções</th>${PRINCIPAIS.map(n => `<th>${nomeCand(n)}<br><span class="muted">1º turno</span></th>`).join('')}${PRINCIPAIS.map(n => `<th>${nomeCand(n)}<br><span class="muted">2º turno</span></th>`).join('')}</tr></thead><tbody>`;
  for (let x = 5; x <= 100; x += 5) {
    h += `<tr><td>${x}%</td>${PRINCIPAIS.map(n => `<td>${cel(s1, n, x)}</td>`).join('')}${PRINCIPAIS.map(n => `<td>${cel(s2 && s2.pontos.length ? s2 : null, n, x)}</td>`).join('')}</tr>`;
  }
  $('tabela').innerHTML = h + '</tbody>';
}

function fontes() {
  const uf = estado.uf, f = estado.fontes;
  const s1 = serie1();
  const item = (ok, nome, url, msg) => `<li><span class="${ok ? 'ok' : 'falha'}">${ok ? '●' : '▲'}</span> <a href="${url}" target="_blank" rel="noopener">${nome}</a> — ${msg}</li>`;
  const tipo1 = uf === 'br' && $('serie1').value === 'observado' ? 'observado' : 'reconstruido';
  const lst = [];
  lst.push(item(!!s1, `1º turno: ${tipo1 === 'observado' ? 'parciais publicadas (pedreirorr + Placar do Voto)' : 'reconstrução a partir dos dados abertos do TSE'}`,
    URL_T1(tipo1, uf), s1 ? `${s1.pontos.length} registros` : (f.t1 || 'não carregado')));
  const nomes = { tse: ['2º turno: TSE (leitura direta)', URL_TSE2(uf)], coletor: ['2º turno: coletor deste repositório (GitHub Actions)', URL_COLETOR(uf)], placar: ['2º turno: Placar do Voto (API pública)', URL_PLACAR2(uf)] };
  for (const [k, [nome, url]] of Object.entries(nomes)) {
    const s = f[k]; lst.push(item(s?.ok, nome, url, s ? s.msg : 'aguardando'));
  }
  $('fontes').innerHTML = lst.join('');
}

function relogio() {
  const falta = Math.max(0, Math.round((estado.proxima - Date.now()) / 1000));
  $('relogio').textContent = estado.ultima
    ? `Última atualização: ${hora(estado.ultima)} · próxima em ${falta} s (a cada 30 s)`
    : 'Carregando…';
}

/* ---------- ciclo ---------- */
async function carregarT1(uf) {
  const tipos = uf === 'br' ? ['reconstruido', 'observado'] : ['reconstruido'];
  await Promise.all(tipos.map(async tipo => {
    const k = uf + ':' + tipo;
    if (estado.t1[k]) return;
    try { estado.t1[k] = deArquivo(await getJSON(URL_T1(tipo, uf), { timeout: 20000 }), tipo); }
    catch (e) { estado.fontes.t1 = 'erro: ' + e.message; }
  }));
}

async function atualizar() {
  if (estado.carregando) return;
  estado.carregando = true;
  const uf = estado.uf;
  $('status').classList.remove('erro');
  $('status').textContent = 'Consultando fontes…';
  try {
    await carregarT1(uf);
    const t2 = await carregarT2(uf);
    if (uf !== estado.uf) return; // usuário trocou de abrangência no meio da consulta
    estado.t2 = t2;
    estado.fontes = { ...estado.fontes, ...t2.fontes };
    if (!estado.xManual) estado.x = t2.pontos.length ? t2.pontos[t2.pontos.length - 1].x : 100;
    $('x').value = estado.x;
    const s1 = serie1();
    const falhas = Object.entries(t2.fontes).filter(([, v]) => !v.ok).map(([k]) => k);
    const msg = [];
    msg.push(s1 ? `1º turno: ${s1.pontos.length} registros.` : '1º turno: não foi possível carregar o histórico.');
    msg.push(`2º turno: ${t2.pontos.length} parciais.`);
    if (falhas.length) msg.push('Fontes com falha: ' + falhas.join(', ') + ' (ver “Fontes”).');
    if (!t2.fontes.tse.ok && !t2.pontos.length) $('status').classList.add('erro');
    if (!s1) $('status').classList.add('erro');
    $('status').textContent = msg.join(' ');
  } catch (e) {
    $('status').classList.add('erro');
    $('status').textContent = 'Erro ao atualizar: ' + e.message;
  } finally {
    estado.carregando = false;
    estado.ultima = new Date().toISOString();
    estado.proxima = Date.now() + INTERVALO;
    render();
  }
}

function render() { desenhar(); leitura(); saldo(); cartoes(); tabela(); fontes(); relogio(); }

function iniciar() {
  const sel = $('uf');
  for (const [k, v] of Object.entries(UFS)) sel.add(new Option(v, k));
  const pedida = new URLSearchParams(location.search).get('uf') || (location.hash.slice(1));
  if (pedida && UFS[pedida.toLowerCase()]) estado.uf = pedida.toLowerCase();
  sel.value = estado.uf;
  $('op-serie1').hidden = estado.uf !== 'br';
  sel.onchange = () => {
    estado.uf = sel.value; estado.t2 = null; estado.xManual = false;
    $('op-serie1').hidden = estado.uf !== 'br';
    history.replaceState(null, '', '#' + estado.uf);
    render(); atualizar();
  };
  $('atualizar').onclick = () => atualizar();
  $('serie1').onchange = () => render();
  $('escala').onchange = () => desenhar();
  $('outros').onchange = () => { desenhar(); leitura(); saldo(); };
  $('x').oninput = () => { estado.x = Number($('x').value); estado.xManual = true; desenharTudoLeve(); };
  const passo = d => { estado.x = Math.max(0, Math.min(100, Math.round((estado.x + d) * 4) / 4)); estado.xManual = true; $('x').value = estado.x; desenharTudoLeve(); };
  $('x-menos').onclick = () => passo(-1);
  $('x-mais').onclick = () => passo(1);
  $('x-atual').onclick = () => {
    const pts = estado.t2?.pontos || [];
    estado.xManual = false; estado.x = pts.length ? pts[pts.length - 1].x : 100; $('x').value = estado.x; desenharTudoLeve();
  };
  let rz = 0;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(desenhar, 120); });
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => render());
  setInterval(() => {
    relogio();
    if (Date.now() >= estado.proxima && !document.hidden && estado.ultima) atualizar();
  }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() >= estado.proxima) atualizar(); });
  render();
  atualizar();
}

iniciar();
