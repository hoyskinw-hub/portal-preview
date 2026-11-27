// 출력용 PDF 양식(templates/*.pdf) 위에 입력값을 그려 완성 PDF를 만든다. 워드 없이 브라우저에서 바로 처리.
// lib: { PDFDocument, rgb, fontkit } / layout: make_pdf_templates.py 가 만든 위치표(JSON)

function fitText(font, text, size, maxW, min = 5.5) {
  let s = size;
  while (s > min && font.widthOfTextAtSize(text, s) > maxW) s -= 0.25;
  return s;
}
function wrap(font, text, size, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const ch of para) {
      if (font.widthOfTextAtSize(line + ch, size) > maxW && line) { out.push(line); line = ch.trim() ? ch : ''; }
      else line += ch;
    }
    out.push(line);
  }
  return out;
}

// plan: 출력할 원본 페이지 순서와 페이지별 값 덮어쓰기 [{ src, vals }]
export function pagePlan(layout, data) {
  const n = layout.pages.length;
  const staffPages = [...new Set(layout.fields.filter((f) => f.k === 'name').map((f) => f.p))].sort((a, b) => a - b);
  const { seal, guar } = layout.marks || {};
  const plan = [];
  for (let i = 0; i < n; i++) {
    if (staffPages.length && i === staffPages[0]) {
      for (const st of data.staff?.length ? data.staff : [{ name: '' }]) for (const p of staffPages) plan.push({ src: p, vals: st });
      continue;
    }
    if (staffPages.includes(i)) continue;
    if (seal != null && guar != null && i >= seal && i < guar && !data.use_seal) continue;
    if (guar != null && i >= guar && !data.is_corp) continue;
    plan.push({ src: i, vals: {} });
  }
  return plan;
}

export async function buildPdf(lib, tplBytes, layout, fontBytes, data, title = '') {
  const { PDFDocument, rgb, fontkit } = lib;
  const tpl = await PDFDocument.load(tplBytes);
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  const font = await out.embedFont(fontBytes, { subset: false })   // 부분 내장은 한글이 빠지는 문제가 있어 전체 내장;
  const black = rgb(0, 0, 0);
  const byPage = {};
  for (const f of layout.fields) (byPage[f.p] ||= []).push(f);
  const plan = pagePlan(layout, data);
  const pages = await out.copyPages(tpl, plan.map((x) => x.src));   // 한 번에 복사해야 글꼴·이미지가 중복되지 않음
  for (let i = 0; i < plan.length; i++) {
    const { src, vals } = plan[i], pg = pages[i];
    out.addPage(pg);
    for (const f of byPage[src] || []) {
      const v = vals[f.k] ?? data[f.k];
      if (v == null || v === '') continue;
      if (f.box) { if (v === '■') pg.drawText('■', { x: f.x, y: f.y, size: f.s, font, color: black }); continue; }
      const text = String(v).replace(/\r/g, '');
      const base = Math.min(f.s, 13);
      const maxW = Math.max(f.w || 100, 10);
      const fits = (sz) => font.widthOfTextAtSize(text, sz) <= maxW;
      // 여러 줄: 줄바꿈이 있는 값, 또는 칸에 값만 있고 한 줄에 넣으면 글자가 너무 작아지는 경우
      const hh = f.h || base * 3;   // 아래 선이 없으면 두 줄까지
      const canWrap = f.solo && hh > base * 2.3;
      if (canWrap && (text.includes('\n') || !fits(base * 0.78))) {
        const sz = text.includes('\n') ? base : base * 0.88, lh = sz * 1.3;
        const maxLines = Math.max(1, Math.floor((hh - 2) / lh));
        const lines = wrap(font, text, sz, maxW).slice(0, maxLines);
        const y0 = text.includes('\n') || lines.length > 2 ? f.y - sz * 0.9 : f.y + (lines.length - 1) * lh / 2 - sz * 0.36;
        lines.forEach((ln, i) => pg.drawText(ln, { x: f.x, y: y0 - i * lh, size: sz, font, color: black }));
        continue;
      }
      const s = fitText(font, text.replace(/\n/g, ' '), base, maxW);
      const tw = font.widthOfTextAtSize(text, s);
      let x = f.x;
      if (f.a === 'g') x = f.x + Math.max(0, (maxW - tw) / 2);
      else if (f.a === 'c') x = f.x - tw / 2;
      else if (f.a === 'r') x = f.x - tw;
      pg.drawText(text, { x, y: f.solo ? f.y - s * 0.36 : f.y, size: s, font, color: black });
    }
  }
  out.setTitle(title); out.setProducer('대리점 소통 포털'); out.setCreator('KICC 채널영업2팀');
  return out.save();
}

// 날인 가이드용: 출력 PDF에서 서류별 쪽 범위(1부터) { 키: { from, to } }
export function docPages(layout, data, offset = 0) {
  const plan = pagePlan(layout, data);
  const owner = (src) => (layout.docs || []).find((d) => src >= d.from && src <= d.to)?.k;
  const out = {};
  plan.forEach(({ src }, i) => {
    const k = owner(src); if (!k) return;
    const n = offset + i + 1;
    out[k] = out[k] ? { from: Math.min(out[k].from, n), to: Math.max(out[k].to, n) } : { from: n, to: n };
  });
  return { pages: out, count: plan.length };
}
