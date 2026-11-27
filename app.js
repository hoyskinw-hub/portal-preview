import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { marked } from 'https://esm.sh/marked@12.0.2';
import DOMPurify from 'https://esm.sh/dompurify@3.1.6';
import { renderWorkbook, renderPdfThumb } from './viewer.js?v=7956aee';

const cfg = window.PORTAL_CONFIG || {};

// 로그인 유지: 체크하면 브라우저를 닫아도 유지(localStorage), 아니면 창 닫으면 로그아웃(sessionStorage)
const KEEP_KEY = 'portal_keep_login', SAVED_ID_KEY = 'portal_saved_id';
const safeLS = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
                 set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
                 del: (k) => { try { localStorage.removeItem(k); } catch {} } };
const authStore = () => (safeLS.get(KEEP_KEY) === '0' ? sessionStorage : localStorage);
const authStorage = {
  getItem: (k) => { try { return authStore().getItem(k); } catch { return null; } },
  setItem: (k, v) => { try { authStore().setItem(k, v); } catch {} },
  removeItem: (k) => { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} },
};
const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { storage: authStorage, persistSession: true } });
const BUCKET = 'agency-files';
const KIND = { notice: '공지', file: '자료', question: '문의' };
const app = document.getElementById('app');
document.title = cfg.SITE_TITLE || document.title;

let me = null;            // 내 profile
let agencies = [];        // 관리자: 전체 / 대리점: 자기 것
const ST0 = { tab: 'home', agency: null, filter: 'all', postId: null, compose: false,
             q: '', gq: '', obId: null, obEdit: null, obFilter: 'active', faqCat: '전체', faqQ: '', faqOpen: null, noticeId: null, noticeEdit: null, libCat: null, libPage: null, libEdit: null, libQ: '', ctId: null, ctEdit: null, ctFilter: 'todo' };
const st = { ...ST0 };
// 로그인/로그아웃 때 보던 화면을 모두 지우고 첫 화면(공지사항)부터
function resetAll() { Object.assign(st, ST0); booted = false; me = null; libOpen.clear(); window.scrollTo(0, 0); }

marked.setOptions({ gfm: true, breaks: true });
function md(src) {
  const div = document.createElement('div');
  div.innerHTML = DOMPurify.sanitize(marked.parse(src || ''));
  div.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
  div.querySelectorAll('input[type=checkbox]').forEach((c) => c.setAttribute('disabled', ''));
  return div.innerHTML;
}
// 검색어 정리 (PostgREST 필터 문법을 깨는 문자 제거)
const cleanQ = (q) => (q || '').replace(/[,()%*"\\:]/g, ' ').trim().slice(0, 50);
const isNew = (d) => Date.now() - new Date(d).getTime() < 3 * 864e5;
const todayStr = () => new Date().toLocaleDateString('sv-SE');
// 중요 공지: 고정 기한이 지나면 일반 공지로
const pinActive = (n) => !!n.pinned && (!n.pin_until || n.pin_until >= todayStr());
const pinLabel = (n) => n.pin_until ? ` · ~${Number(n.pin_until.slice(5, 7))}/${Number(n.pin_until.slice(8, 10))}` : '';
const sortNotices = (list) => list.sort((a, b) => (pinActive(b) - pinActive(a)) || b.created_at.localeCompare(a.created_at));

// ---------------- 유틸 ----------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => { const t = new Date(d); const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}.${p(t.getMonth() + 1)}.${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`; };
const fmtSize = (b) => b == null ? '' : b < 1024 ? `${b}B` : b < 1048576 ? `${(b / 1024).toFixed(0)}KB` : `${(b / 1048576).toFixed(1)}MB`;
// isAdmin(): 본사 측(총관리자 + 본사 담당자) / isSuper(): 총관리자만
const isAdmin = () => me?.role === 'admin' || me?.role === 'manager';
const isSuper = () => me?.role === 'admin';
const isManager = () => me?.role === 'manager';
const isProspect = () => me?.role === 'prospect';
const isOwner = () => !isAdmin() && me?.agency_role === 'owner';
// 대표자만 보는 메뉴 (계약 메뉴를 만들면 'contracts'도 여기에 포함되어 있어 자동으로 대표자 전용)
const OWNER_ONLY = new Set(['myagency', 'contracts']);
const ROLE_LABEL = { owner: '대표자', staff: '직원' };
const agencyName = (code) => agencies.find((a) => a.code === code)?.name || code;
let toastTimer;
function toast(msg, err = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 3200);
}
function fail(e) { console.error(e); toast(e?.message || String(e), true); }
const form = (el) => Object.fromEntries(new FormData(el).entries());
const KOR_ERR = {
  'Invalid login credentials': '이메일 또는 비밀번호가 올바르지 않습니다.',
  'Email not confirmed': '메일 인증이 아직 안 됐습니다. 받은 메일함에서 인증 링크를 눌러주세요.',
  'User already registered': '이미 가입된 이메일입니다.',
};
const kor = (m) => KOR_ERR[m] || m;

// ---------------- 시작 ----------------
if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('YOUR-PROJECT')) {
  app.innerHTML = `<div class="auth-wrap"><div class="auth-card"><h1>설정 필요</h1>
  <p class="sub">site/config.js 에 Supabase 주소와 anon 키를 넣어주세요.</p></div></div>`;
} else {
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') return renderReset();
    // 탭을 다시 열 때 오는 SIGNED_IN 은 무시 (작성 중인 글이 날아가지 않게)
    if (event === 'SIGNED_IN' && me && session?.user?.id === me.id) return;
    if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') resetAll();
    if (['SIGNED_IN', 'SIGNED_OUT', 'INITIAL_SESSION', 'USER_UPDATED'].includes(event)) setTimeout(boot, 0);
  });
}

let booted = false;
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { me = null; return renderAuth('login'); }
  const { data, error } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if (error) return fail(error);
  me = data;
  if (!me) return renderWait('계정 정보를 찾을 수 없습니다. 관리자에게 문의해주세요.');
  if (me.status === 'pending') return renderWait(me.requested_role === 'prospect'
    ? '신규 대리점 가입 신청이 접수됐습니다. 본사 승인 후 대리점 개설 서류를 작성할 수 있습니다.'
    : '가입 신청이 접수됐습니다. 담당자 승인 후 이용하실 수 있습니다.');
  if (me.status === 'rejected') return renderWait('가입이 승인되지 않았습니다. 담당자에게 문의해주세요.');
  const { data: ag } = await sb.from('agencies').select('*').order('code', { ascending: true });
  agencies = (ag || []).sort((a, b) => Number(a.code) - Number(b.code) || a.code.localeCompare(b.code));
  if (!isAdmin()) st.agency = me.agency_code;
  else if (!st.agency) st.agency = agencies[0]?.code || null;
  if (!booted) { st.tab = 'home'; booted = true; }
  render();
}

// ---------------- 로그인/가입 ----------------
function renderAuth(mode) {
  const title = esc(cfg.SITE_TITLE || '대리점 포털');
  const sub = esc(cfg.SITE_SUBTITLE || '');
  let body = '';
  if (mode === 'login') body = `
    <form id="f">
      <label class="field"><span>이메일</span><input type="email" name="email" required autocomplete="email" value="${esc(safeLS.get(SAVED_ID_KEY) || '')}"></label>
      <label class="field"><span>비밀번호</span><input type="password" name="password" required autocomplete="current-password"></label>
      <div class="login-opts">
        <label><input type="checkbox" name="save_id" ${safeLS.get(SAVED_ID_KEY) ? 'checked' : ''}> 아이디 저장</label>
        <label><input type="checkbox" name="keep" ${safeLS.get(KEEP_KEY) !== '0' ? 'checked' : ''}> 로그인 유지</label>
      </div>
      <button class="btn primary block">로그인</button>
    </form>
    <div class="switch">처음이신가요?<a href="#" data-m="signup">가입 신청</a></div>
    <div class="switch"><a href="#" data-m="forgot">비밀번호를 잊으셨나요?</a></div>`;
  if (mode === 'signup') body = `
    <form id="f">
      <div class="field"><span>구분</span>
        <div class="seg"><label><input type="radio" name="requested_role" value="owner"> 대표자</label><label><input type="radio" name="requested_role" value="staff" checked> 직원</label><label><input type="radio" name="requested_role" value="prospect"> 신규 대리점</label></div>
        <small class="muted seg-hint">직원은 대리점 대표자가 가입을 승인합니다.</small>
        <small class="muted" style="display:block;font-size:12px;margin-top:2px">본사 직원은 '대표자'를 선택하고 대리점명에 '본사'라고 적어 주세요.</small></div>
      <div class="row2">
        <label class="field"><span>대리점명</span><input type="text" name="requested_name" required></label>
        <label class="field"><span>대리점 코드 <small class="code-req">(직원은 필수)</small></span><input type="text" name="requested_code" inputmode="numeric"></label>
      </div>
      <div class="row2">
        <label class="field"><span>담당자명</span><input type="text" name="contact_name" required></label>
        <label class="field"><span>연락처</span><input type="tel" name="phone"></label>
      </div>
      <label class="field"><span>이메일 (아이디)</span><input type="email" name="email" required autocomplete="email"></label>
      <label class="field"><span>비밀번호 <small>(8자 이상)</small></span><input type="password" name="password" minlength="8" required autocomplete="new-password"></label>
      <label class="field"><span>비밀번호 확인</span><input type="password" name="password2" minlength="8" required autocomplete="new-password"></label>
      <button class="btn primary block">가입 신청</button>
    </form>
    <div class="switch">이미 계정이 있으신가요?<a href="#" data-m="login">로그인</a></div>`;
  if (mode === 'forgot') body = `
    <form id="f">
      <label class="field"><span>가입한 이메일</span><input type="email" name="email" required></label>
      <button class="btn primary block">재설정 메일 받기</button>
    </form>
    <div class="switch"><a href="#" data-m="login">로그인으로 돌아가기</a></div>`;
  if (mode === 'sent') body = `<div class="notice-box">입력하신 이메일로 메일을 보냈습니다.<br>메일의 링크를 눌러 진행해주세요.</div>
    <div class="switch"><a href="#" data-m="login">로그인으로</a></div>`;

  app.innerHTML = `<div class="auth-wrap"><div class="auth-card"><h1>${title}</h1><p class="sub">${sub}</p>${body}</div></div>`;
  app.querySelectorAll('[data-m]').forEach((a) => a.onclick = (e) => { e.preventDefault(); renderAuth(a.dataset.m); });
  app.querySelectorAll('[name=requested_role]').forEach((r) => r.onchange = () => {
    const r = app.querySelector('[name=requested_role]:checked').value;
    app.querySelector('.seg-hint').textContent = r === 'owner' ? '대표자는 본사 담당자가 확인 후 승인합니다.'
      : r === 'prospect' ? '아직 대리점 코드가 없는 신규 대리점입니다. 본사 승인 후 개설 서류를 작성합니다.' : '직원은 대리점 대표자가 가입을 승인합니다.';
    app.querySelector('.code-req').textContent = r === 'staff' ? '(직원은 필수)' : r === 'prospect' ? '(없으면 비움)' : '(아시면)';
  });
  const f = app.querySelector('#f'); if (!f) return;
  if (mode === 'login' && safeLS.get(SAVED_ID_KEY)) setTimeout(() => f.password?.focus(), 0);
  f.onsubmit = async (e) => {
    e.preventDefault(); const v = form(f); const btn = f.querySelector('button'); btn.disabled = true;
    try {
      if (mode === 'login') {
        safeLS.set(KEEP_KEY, v.keep ? '1' : '0');
        if (v.save_id) safeLS.set(SAVED_ID_KEY, v.email.trim()); else safeLS.del(SAVED_ID_KEY);
        const { error } = await sb.auth.signInWithPassword({ email: v.email, password: v.password });
        if (error) throw new Error(kor(error.message));
      } else if (mode === 'signup') {
        if (v.password !== v.password2) throw new Error('비밀번호 확인이 일치하지 않습니다.');
        if (v.requested_role === 'staff' && !v.requested_code.trim()) throw new Error('직원은 대리점 코드를 입력해야 대표자가 승인할 수 있습니다. 코드는 대표자에게 확인하세요.');
        const { data, error } = await sb.auth.signUp({
          email: v.email, password: v.password,
          options: { emailRedirectTo: location.origin + location.pathname,
            data: { requested_name: v.requested_name.trim(), requested_code: v.requested_code.trim(), requested_role: ['owner', 'prospect'].includes(v.requested_role) ? v.requested_role : 'staff',
                    contact_name: v.contact_name.trim(), phone: v.phone.trim() } },
        });
        if (error) throw new Error(kor(error.message));
        if (!data.session) renderAuth('sent');
      } else if (mode === 'forgot') {
        const { error } = await sb.auth.resetPasswordForEmail(v.email, { redirectTo: location.origin + location.pathname });
        if (error) throw error;
        renderAuth('sent');
      }
    } catch (err) { fail(err); btn.disabled = false; }
  };
}

function renderReset() {
  app.innerHTML = `<div class="auth-wrap"><div class="auth-card"><h1>새 비밀번호 설정</h1><p class="sub">새로 사용할 비밀번호를 입력하세요.</p>
    <form id="f"><label class="field"><span>새 비밀번호</span><input type="password" name="password" minlength="8" required></label>
    <button class="btn primary block">변경</button></form></div></div>`;
  app.querySelector('#f').onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.updateUser({ password: form(e.target).password });
    if (error) return fail(error);
    toast('비밀번호가 변경됐습니다.'); boot();
  };
}

function renderWait(msg) {
  app.innerHTML = `<div class="auth-wrap"><div class="auth-card"><h1>${esc(cfg.SITE_TITLE)}</h1><p class="sub">${esc(me?.email || '')}</p>
    <div class="notice-box">${esc(msg)}</div><div class="switch"><a href="#" id="lo">로그아웃</a></div></div></div>`;
  app.querySelector('#lo').onclick = (e) => { e.preventDefault(); sb.auth.signOut(); };
}

function resetView() {
  Object.assign(st, { postId: null, compose: false, noticeId: null, noticeEdit: null, libEdit: null, obId: null, obEdit: null, ctId: null, ctEdit: null });
}

// ---------------- 브라우저 뒤로가기: 사이트 안에서 이전 화면으로 ----------------
const NAV_KEYS = ['tab', 'agency', 'filter', 'postId', 'compose', 'q', 'obId', 'obEdit', 'obFilter', 'faqCat', 'noticeId', 'noticeEdit', 'libCat', 'libPage', 'libEdit', 'ctId', 'ctEdit'];
const navSnap = () => JSON.stringify(NAV_KEYS.map((k) => st[k] ?? null));
let navFromPop = false;
function syncHistory() {
  if (navFromPop) { navFromPop = false; return; }
  const snap = navSnap(), cur = history.state?.nav;
  if (cur === snap) return;
  // 작성 화면에서 저장하고 나올 때는 작성 화면을 기록에서 지워, 뒤로가기로 다시 열리지 않게
  const EDIT = ['compose', 'noticeEdit', 'libEdit', 'obEdit', 'ctEdit'].map((k) => NAV_KEYS.indexOf(k));
  const wasEdit = cur && EDIT.some((i) => JSON.parse(cur)[i]), isEdit = EDIT.some((i) => JSON.parse(snap)[i]);
  if (!cur || (wasEdit && !isEdit)) history.replaceState({ nav: snap }, ''); else history.pushState({ nav: snap }, '');
}
window.addEventListener('popstate', (e) => {
  if (!me) return;
  const open = document.querySelectorAll('.modal-bg, .lightbox');
  const editing = st.compose || st.noticeEdit || st.libEdit || st.obEdit || st.ctEdit;
  if (editing && !open.length && !confirm('작성 중인 내용은 저장되지 않습니다. 이전 화면으로 갈까요?')) { history.pushState({ nav: navSnap() }, ''); return; }
  open.forEach((x) => x.remove());
  const nav = e.state?.nav;
  if (!nav) return;
  JSON.parse(nav).forEach((v, i) => { st[NAV_KEYS[i]] = v; });
  navFromPop = true; window.scrollTo(0, 0); render();
});

// ---------------- 공통 화면 틀 ----------------
async function render() {
  syncHistory();
  let pendingCnt = 0;
  if (isAdmin()) {
    const { count } = await sb.from('profiles').select('id', { count: 'exact', head: true }).eq('status', 'pending');
    pendingCnt = count || 0;
  }
  // 대표자: 직원 가입 승인 대기 수
  let memberPending = 0;
  if (isOwner()) { const { data: mm } = await sb.rpc('my_members'); memberPending = (mm || []).filter((m) => m.status === 'pending').length; }
  // 새 공지 수 (마지막으로 공지 탭을 본 이후)
  const seenKey = `portal_notice_seen_${me.id}`;
  const { count: newNotice } = await sb.from('notices').select('id', { count: 'exact', head: true })
    .gt('created_at', safeLS.get(seenKey) || '1970-01-01');
  let obPending = 0;
  if (isAdmin()) { const { count } = await sb.from('onboard_apps').select('id', { count: 'exact', head: true }).eq('status', 'submitted'); obPending = count || 0; }
  // 전자계약: 본사 = 본사 날인 대기 수 / 대표자 = 날인할 계약 수
  // (전자계약 테이블이 아직 없으면 대리점 메뉴에서는 숨김)
  let ctCnt = 0, ctReady = false;
  if (isAdmin() || isOwner()) {
    const { count, error: ce } = await sb.from('contracts').select('id', { count: 'exact', head: true }).eq('status', isAdmin() ? 'agency_signed' : 'sent');
    ctCnt = count || 0; ctReady = !ce;
  }
  // 문의 알림: 본사 = 답변이 필요한 문의 수 / 대리점 = 아직 읽지 않은 새 답변 수
  const lastCmt = (p) => (p.comments || []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at)).pop();
  let qCnt = 0;
  if (isAdmin()) {
    const { data: qs } = await sb.from('posts').select('id,comments(author_role,created_at)').eq('kind', 'question').order('last_activity', { ascending: false }).limit(200);
    qCnt = (qs || []).filter((p) => { const c = lastCmt(p); return !c || c.author_role !== 'admin'; }).length;
  } else if (!isProspect() && me.agency_code) {
    const { data: qs } = await sb.from('posts').select('id,comments(author_role,created_at)').eq('agency_code', me.agency_code).eq('kind', 'question').order('last_activity', { ascending: false }).limit(100);
    const answered = (qs || []).filter((p) => lastCmt(p)?.author_role === 'admin');
    const { mine } = await readMap(answered.map((p) => p.id));
    qCnt = answered.filter((p) => !mine[p.id] || new Date(mine[p.id]) < new Date(lastCmt(p).created_at)).length;
  }
  // 본사: 공통 메뉴 + [본사 관리] 묶음 (누르면 바로 아래에 하위 메뉴)
  const HQ_TABS = [['inbox', '최근 문의', '💬', qCnt], ['board', '대리점별 게시판', '🗂'], ['files', '대리점 자료함', '📁'], ['onboarding', '개설 신청', '📝', obPending],
    ['contracts', '전자계약', '✍️', ctCnt], ['users', '가입 승인', '🙋', pendingCnt], ['agencies', '대리점 관리', '🏢']].filter(([k]) => isSuper() || k !== 'agencies');
  const inHq = isAdmin() && HQ_TABS.some(([k]) => k === st.tab);
  const hqSum = HQ_TABS.reduce((a, t) => a + (t[3] || 0), 0);
  const tabs = isProspect() ? [['onboard', '대리점 개설 신청']] : isAdmin()
    ? [['home', '홈'], ['notices', '공지사항'], ['library', '자료실'], ['faq', 'FAQ']]
    : [['home', '홈'], ['notices', '공지사항', newNotice], ['library', '자료실'], ['faq', 'FAQ'], ['board', '1:1 문의', qCnt],
       ['contracts', '전자계약', ctCnt], ['myagency', '우리 대리점', memberPending]].filter(([k]) => (isOwner() || !OWNER_ONLY.has(k)) && (k !== 'contracts' || ctReady));
  const ICON = { home: '🏠', notices: '📢', library: '📚', faq: '❓', board: '💬', myagency: '🏢', contracts: '✍️' };
  if (!isAdmin() && !tabs.some(([k]) => k === st.tab) && !(st.tab === 'search' && !isProspect())) st.tab = tabs[0][0];
  const whoName = isProspect() ? `<b>${esc(me.requested_name || '신규 대리점')}</b> · ${esc(me.contact_name || me.email)} <span class="role-chip">신규 대리점</span>` : isAdmin() ? `${esc(me.contact_name || me.email)} <span class="role-chip owner">${isSuper() ? '총관리자' : '본사 담당자'}</span>` : `<b>${esc(agencyName(me.agency_code))}</b> · ${esc(me.contact_name || me.email)} <span class="role-chip ${me.agency_role}">${ROLE_LABEL[me.agency_role] || '직원'}</span>`;
  app.innerHTML = `
    <header class="top"><div class="top-in">
      <div class="brand">${esc(cfg.SITE_TITLE)}<small>${esc(cfg.SITE_SUBTITLE || '')}</small></div>
      ${isProspect() ? '<div class="grow"></div>' : `<form class="gsearch" id="gs"><input type="search" name="q" placeholder="전체 검색 (공지·자료실·게시판)" value="${esc(st.tab === 'search' ? st.gq : '')}"></form>`}
      <div class="who"><span>${whoName}</span><button class="btn small" id="logout">로그아웃</button></div>
    </div>
    <nav class="tabs">${tabs.map(([k, l, c]) => `<button class="tab ${st.tab === k ? 'on' : ''}" data-tab="${k}">${l}${c ? `<span class="cnt">${c}</span>` : ''}</button>`).join('')}
      ${isAdmin() ? `<button class="tab hq-btn ${inHq ? 'on' : ''}" id="hqBtn" aria-expanded="${inHq || st.hqOpen ? 'true' : 'false'}">🛠 본사 관리${hqSum ? `<span class="cnt">${hqSum}</span>` : ''}<span class="hq-caret">▾</span></button>` : ''}</nav>
    ${isAdmin() ? `<nav class="hq-sub" id="hqSub" ${inHq || st.hqOpen ? '' : 'hidden'}><div class="hq-sub-in"><span class="hq-lab">본사 관리</span>${HQ_TABS.map(([k, l, ic, c]) =>
      `<button class="hq-item ${st.tab === k ? 'on' : ''}" data-tab="${k}"><span class="hq-ic">${ic}</span>${l}${c ? `<span class="cnt">${c}</span>` : ''}</button>`).join('')}</div></nav>` : ''}
    </header>
    <main id="main"></main>
    ${!isAdmin() && tabs.length > 1 ? `<nav class="bnav" style="--n:${tabs.length}">${tabs.map(([k, l, c]) => `<button class="${st.tab === k ? 'on' : ''}" data-tab="${k}"><span class="bi">${ICON[k]}${c ? `<i>${c}</i>` : ''}</span>${l}</button>`).join('')}</nav>` : ''}`;
  app.classList.toggle('agency-ui', !isAdmin());
  app.querySelector('#logout').onclick = () => { try { sessionStorage.removeItem(`portal_brief_${me.id}`); } catch {} sb.auth.signOut(); };
  if (app.querySelector('#gs')) app.querySelector('#gs').onsubmit = (e) => {
    e.preventDefault(); const q = cleanQ(e.target.q.value); if (!q) return;
    resetView(); st.tab = 'search'; st.gq = q; render();
  };
  // 상단 메뉴를 누르면 그 메뉴의 첫 화면으로 (보던 글·분류·검색·필터 초기화)
  const goTab = (t) => {
    resetView();
    Object.assign(st, { tab: t, q: '', filter: 'all', libCat: null, libPage: null, libQ: '', faqCat: '전체', faqQ: '', faqOpen: null });
    window.scrollTo(0, 0); render();
  };
  app.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { if (!b.classList.contains('hq-item')) st.hqOpen = false; goTab(b.dataset.tab); });
  const hqBtn = app.querySelector('#hqBtn');
  if (hqBtn) hqBtn.onclick = () => {
    const sub = app.querySelector('#hqSub'), open = sub.hidden;
    sub.hidden = !open; st.hqOpen = open; hqBtn.setAttribute('aria-expanded', String(open));
  };
  app.querySelector('.brand').onclick = () => goTab('home');
  // 로그인 후 처음 한 번: 새 알림 요약 팝업
  if (!isProspect()) showLoginBrief(isAdmin()
    ? [['inbox', '답변이 필요한 문의', qCnt], ['contracts', '본사 날인이 필요한 전자계약', ctCnt], ['users', '가입 승인 대기', pendingCnt], ['onboarding', '검토할 개설 신청', obPending]]
    : [['board', '답변이 도착한 문의', qCnt], ['notices', '새 공지사항', newNotice || 0], ['contracts', '날인할 전자계약', ctReady ? ctCnt : 0], ['myagency', '직원 가입 승인 대기', memberPending]],
  goTab, { seenNotice: safeLS.get(seenKey) || '1970-01-01' });
  if (st.tab === 'notices') safeLS.set(seenKey, new Date().toISOString());
  const main = app.querySelector('#main');
  main.innerHTML = '<div class="empty">불러오는 중…</div>';
  try {
    if (st.tab === 'home') return await viewHome(main, { pendingCnt });
    if (st.tab === 'faq') return await viewFaq(main);
    if (st.tab === 'onboard') return isProspect() ? await viewOnboard(main) : null;
    if (st.tab === 'onboarding') return isAdmin() ? await viewOnboardAdmin(main) : null;
    if (st.tab === 'contracts') return (isAdmin() || isOwner()) ? await viewContracts(main) : null;
    if (st.tab === 'myagency') return isOwner() ? await viewMyAgency(main) : viewHome(main, { pendingCnt });
    if (st.tab === 'search') return await viewSearch(main);
    if (st.tab === 'notices') return await viewNotices(main);
    if (st.tab === 'library') return await viewLibrary(main);
    if (st.compose) return await viewCompose(main);
    if (st.postId) return await viewPost(main);
    if (st.tab === 'inbox') return await viewInbox(main);
    if (st.tab === 'board') return await viewBoard(main);
    if (st.tab === 'files') return await viewFiles(main);
    if (st.tab === 'users') return await viewUsers(main);
    if (st.tab === 'agencies') return isSuper() ? await viewAgencies(main) : viewHome(main, { pendingCnt });
  } catch (e) { fail(e); main.innerHTML = '<div class="empty">불러오지 못했습니다.</div>'; }
}

function agencySelect() {
  if (!isAdmin()) return '';
  return `<select id="agSel" class="ag-search">${agencies.map((a) => `<option value="${esc(a.code)}" ${a.code === st.agency ? 'selected' : ''}>${esc(a.code)} · ${esc(a.name)}</option>`).join('')}</select>`;
}
function bindAgencySelect(root) {
  const s = root.querySelector('#agSel');
  if (s) s.onchange = () => { st.agency = s.value; render(); };
}

async function readMap(postIds) {
  if (!postIds.length) return { mine: {}, others: {} };
  const { data } = await sb.from('post_reads').select('post_id,user_id,read_at').in('post_id', postIds);
  const mine = {}, others = {};
  (data || []).forEach((r) => {
    if (r.user_id === me.id) mine[r.post_id] = r.read_at;
    else if (!others[r.post_id] || others[r.post_id] < r.read_at) others[r.post_id] = r.read_at;
  });
  return { mine, others };
}

function postRow(p, reads, opts = {}) {
  const unread = !reads.mine[p.id] || new Date(reads.mine[p.id]) < new Date(p.last_activity);
  const cmts = p.comments || [];
  const nFiles = p.files?.[0]?.count ?? 0;
  const last = cmts.slice().sort((a, b) => a.created_at.localeCompare(b.created_at)).pop();
  let status = '';
  if (isAdmin() && p.kind === 'question') {
    const waiting = last ? last.author_role !== 'admin' : true;
    status = waiting ? '<span class="badge need">답변 필요</span>' : '<span class="badge ok">답변 완료</span>';
  } else if (isAdmin()) {
    status = reads.others[p.id] ? '<span class="badge ok">대리점 확인</span>' : '<span class="badge gray">미확인</span>';
  }
  return `<div class="item" data-post="${p.id}">
    <span class="badge ${p.kind}">${KIND[p.kind]}</span>
    <div><div class="t">${unread ? '<span class="dot"></span>' : ''}${esc(p.title)}</div>
      <div class="meta">${opts.showAgency ? `<span>${esc(p.agency_code)} · ${esc(agencyName(p.agency_code))}</span>` : ''}
      <span>${esc(p.author_name || '')}</span>${cmts.length ? `<span>댓글 ${cmts.length}</span>` : ''}${nFiles ? `<span>파일 ${nFiles}</span>` : ''}</div></div>
    <div class="right">${status} <div>${fmt(p.last_activity)}</div></div></div>`;
}
function bindPostRows(root) {
  root.querySelectorAll('[data-post]').forEach((el) => el.onclick = () => {
    const p = el.dataset.post; st.postId = Number(p);
    if (el.dataset.agency) st.agency = el.dataset.agency;
    render();
  });
}

function searchBox(ph) {
  return `<form class="sbox" id="sbox"><input type="search" name="q" placeholder="${esc(ph)}" value="${esc(st.q)}"></form>`;
}
function bindSearchBox(root) {
  const f = root.querySelector('#sbox');
  if (f) f.onsubmit = (e) => { e.preventDefault(); st.q = cleanQ(f.q.value); render(); };
}

// ---------------- 게시판 ----------------
async function viewBoard(main) {
  if (!st.agency) { main.innerHTML = `<div class="empty">${isManager() ? '배정된 담당 대리점이 없습니다. 총관리자에게 배정을 요청하세요.' : '등록된 대리점이 없습니다. [대리점 관리]에서 먼저 추가하세요.'}</div>`; return; }
  let q = sb.from('posts').select('*, comments(author_role,created_at), files(count)').eq('agency_code', st.agency)
    .order('last_activity', { ascending: false }).limit(200);
  if (st.filter !== 'all') q = q.eq('kind', st.filter);
  if (st.q) q = q.or(`title.ilike.%${st.q}%,body.ilike.%${st.q}%`);
  const { data: posts, error } = await q; if (error) throw error;
  const reads = await readMap(posts.map((p) => p.id));
  main.innerHTML = `
    <div class="bar">${isAdmin() ? agencySelect() : `<h2>${esc(agencyName(st.agency))}</h2>`}
      <div class="chips">${[['all', '전체'], ['notice', '공지'], ['file', '자료'], ['question', '문의']].map(([k, l]) => `<button class="chip ${st.filter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
      ${searchBox('제목·내용 검색')}
      <div class="grow"></div><button class="btn primary" id="new">${isAdmin() ? '새 글 · 자료 올리기' : '문의하기'}</button></div>
    <div class="card list">${posts.length ? posts.map((p) => postRow(p, reads)).join('') : `<div class="empty">${st.q ? '검색 결과가 없습니다.' : '아직 글이 없습니다.'}</div>`}</div>`;
  bindAgencySelect(main); bindPostRows(main); bindSearchBox(main);
  main.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { st.filter = b.dataset.f; render(); });
  main.querySelector('#new').onclick = () => { st.compose = true; render(); };
}

// 관리자: 전 대리점 최근 문의
async function viewInbox(main) {
  let iq = sb.from('posts').select('*, comments(author_role,created_at), files(count)')
    .eq('kind', 'question').order('last_activity', { ascending: false }).limit(100);
  if (st.q) iq = iq.or(`title.ilike.%${st.q}%,body.ilike.%${st.q}%`);
  const { data: posts, error } = await iq;
  if (error) throw error;
  const reads = await readMap(posts.map((p) => p.id));
  const waiting = posts.filter((p) => { const c = (p.comments || []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at)).pop(); return !c || c.author_role !== 'admin'; });
  main.innerHTML = `<div class="bar"><h2>최근 문의</h2><span class="badge need">답변 필요 ${waiting.length}건</span>${searchBox('문의 검색')}<div class="grow"></div>
    <button class="btn primary" id="new">새 글 · 자료 올리기</button></div>
    <div class="card list">${posts.length ? posts.map((p) => postRow(p, reads, { showAgency: true }).replace('<div class="item"', `<div class="item" data-agency="${esc(p.agency_code)}"`)).join('') : `<div class="empty">${st.q ? '검색 결과가 없습니다.' : '들어온 문의가 없습니다.'}</div>`}</div>`;
  bindPostRows(main); bindSearchBox(main);
  main.querySelector('#new').onclick = () => { st.compose = true; render(); };
}

// ---------------- 글 보기 ----------------
async function viewPost(main) {
  const { data: p, error } = await sb.from('posts').select('*').eq('id', st.postId).maybeSingle();
  if (error) throw error;
  if (!p) { st.postId = null; main.innerHTML = '<div class="empty">글을 찾을 수 없습니다.</div>'; return; }
  const [{ data: files }, { data: cmts }] = await Promise.all([
    sb.from('files').select('*').eq('post_id', p.id).order('id'),
    sb.from('comments').select('*').eq('post_id', p.id).order('created_at'),
  ]);
  await sb.from('post_reads').upsert({ post_id: p.id, user_id: me.id, read_at: new Date().toISOString() });
  let readInfo = '';
  if (isAdmin()) {
    const { others } = await readMap([p.id]);
    readInfo = others[p.id] ? ` · <span class="badge ok">대리점 확인 ${fmt(others[p.id])}</span>` : ' · <span class="badge gray">대리점 미확인</span>';
  }
  const canDelete = isAdmin() || p.author_id === me.id;
  main.innerHTML = `
    <div class="bar"><button class="btn" id="back">← 목록</button><div class="grow"></div>
      ${isSuper() && p.kind === 'question' ? '<button class="btn small" id="toFaq">❓ FAQ로 등록</button> ' : ''}${canDelete ? '<button class="btn danger small" id="del">글 삭제</button>' : ''}</div>
    <div class="card post">
      <span class="badge ${p.kind}">${KIND[p.kind]}</span>
      <h3>${esc(p.title)}</h3>
      <div class="meta">${isAdmin() ? `${esc(p.agency_code)} · ${esc(agencyName(p.agency_code))} · ` : ''}${esc(p.author_name || '')} · ${fmt(p.created_at)}${readInfo}</div>
      ${p.body ? `<div class="body">${esc(p.body)}</div>` : '<div style="height:16px"></div>'}
      ${commonFilesHtml(files)}
      <div class="comments"><h4>댓글 ${cmts?.length || 0}</h4>
        ${(cmts || []).map((c) => `<div class="cmt ${c.author_role === 'admin' ? 'admin' : ''}"><div class="h"><b>${esc(c.author_name || '')}</b>${c.author_role === 'admin' ? '<span class="badge file">담당자</span>' : ''}<span>${fmt(c.created_at)}</span>
          ${(isSuper() || c.author_id === me.id) ? `<a href="#" data-dc="${c.id}" style="margin-left:auto;color:var(--muted)">삭제</a>` : ''}</div><div class="x">${esc(c.body)}</div></div>`).join('')}
        <form class="cmt-form" id="cf"><textarea name="body" placeholder="댓글을 입력하세요" required></textarea><button class="btn primary">등록</button></form>
      </div>
    </div>`;
  main.querySelector('#back').onclick = () => { st.postId = null; render(); };
  bindDownloads(main);
  const tf = main.querySelector('#toFaq');
  if (tf) tf.onclick = () => {
    const ans = (cmts || []).filter((c) => c.author_role === 'admin').pop();
    faqDialog({ question: p.title, answer: ans?.body || '', category: '' }, true);
  };
  main.querySelector('#cf').onsubmit = async (e) => {
    e.preventDefault(); const body = form(e.target).body.trim(); if (!body) return;
    const { error } = await sb.from('comments').insert({ post_id: p.id, body });
    if (error) return fail(error); render();
  };
  main.querySelectorAll('[data-dc]').forEach((a) => a.onclick = async (e) => {
    e.preventDefault(); if (!confirm('댓글을 삭제할까요?')) return;
    const { error } = await sb.from('comments').delete().eq('id', a.dataset.dc); if (error) return fail(error); render();
  });
  const del = main.querySelector('#del');
  if (del) del.onclick = async () => {
    if (!confirm('이 글과 첨부파일을 삭제할까요?')) return;
    if (isAdmin() && files?.length) await sb.storage.from(BUCKET).remove(files.map((f) => f.storage_path));
    const { error } = await sb.from('posts').delete().eq('id', p.id); if (error) return fail(error);
    st.postId = null; toast('삭제했습니다.'); render();
  };
}

function bindDownloads(root) {
  root.querySelectorAll('[data-dl]').forEach((b) => b.onclick = async () => {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(b.dataset.dl, 120, { download: b.dataset.name });
    if (error) return fail(error);
    window.location.href = data.signedUrl;
  });
  root.querySelectorAll('[data-pv]').forEach((b) => b.onclick = () => openPreview(b.dataset.pv, b.dataset.name));
  hydrateThumbs(root).catch(() => {});
}

// ---------------- 글쓰기 ----------------
async function viewCompose(main) {
  const admin = isAdmin();
  main.innerHTML = `
    <div class="bar"><button class="btn" id="back">← 취소</button><h2>${admin ? '새 글 · 자료 올리기' : '문의하기'}</h2></div>
    <form class="card form-card" id="cf">
      ${admin ? `<label class="field"><span>구분</span><select name="kind"><option value="file">자료</option><option value="notice">공지</option></select></label>
      <div class="field"><span>보낼 대리점 <small>— 여러 곳을 고르면 대리점마다 따로 게시됩니다 (서로 안 보임)</small></span>
        <div style="display:flex;gap:6px;margin-bottom:6px"><button type="button" class="btn small" id="all">전체 선택</button><button type="button" class="btn small" id="none">선택 해제</button></div>
        <div class="agency-pick">${agencies.map((a) => `<label><input type="checkbox" name="ag" value="${esc(a.code)}" ${a.code === st.agency ? 'checked' : ''}> ${esc(a.code)} · ${esc(a.name)}</label>`).join('')}</div></div>` : ''}
      <label class="field"><span>제목</span><input type="text" name="title" required maxlength="200" autocomplete="off"></label>
      ${admin ? '' : '<div class="faq-suggest" id="fsug" hidden></div>'}
      <label class="field"><span>내용</span><textarea name="body"></textarea></label>
      <label class="field"><span>첨부파일 <small>(여러 개 가능, 파일당 50MB 이하)</small></span><input type="file" name="files" multiple></label>
      <button class="btn primary" id="sub">등록</button><span class="progress" id="prog"></span>
    </form>`;
  main.querySelector('#back').onclick = () => { st.compose = false; render(); };
  if (!admin) bindFaqSuggest(main);
  if (admin) {
    main.querySelector('#all').onclick = () => main.querySelectorAll('.agency-pick label:not([hidden]) [name=ag]').forEach((c) => (c.checked = true));
    main.querySelector('#none').onclick = () => main.querySelectorAll('.agency-pick label:not([hidden]) [name=ag]').forEach((c) => (c.checked = false));
  }
  main.querySelector('#cf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target; const btn = main.querySelector('#sub'); const prog = main.querySelector('#prog');
    const title = f.title.value.trim(); const body = f.body.value.trim();
    const files = [...f.files.files];
    const targets = admin ? [...f.querySelectorAll('[name=ag]:checked')].map((c) => c.value) : [me.agency_code];
    const kind = admin ? f.kind.value : 'question';
    if (!targets.length) return toast('대리점을 하나 이상 선택하세요.', true);
    if (files.some((x) => x.size > 50 * 1024 * 1024)) return toast('50MB를 넘는 파일이 있습니다.', true);
    btn.disabled = true;
    try {
      let lastId = null;
      for (let i = 0; i < targets.length; i++) {
        const code = targets[i];
        prog.textContent = `${i + 1}/${targets.length} 대리점 게시 중…`;
        const { data: post, error } = await sb.from('posts').insert({ agency_code: code, kind, title, body }).select('id').single();
        if (error) throw error;
        lastId = post.id;
        for (const file of files) await uploadFile(code, post.id, file);
      }
      toast(targets.length > 1 ? `${targets.length}개 대리점에 게시했습니다.` : '등록했습니다.');
      st.compose = false;
      if (targets.length === 1) { st.agency = targets[0]; st.postId = lastId; }
      render();
    } catch (err) { fail(err); btn.disabled = false; prog.textContent = ''; }
  };
}

async function uploadFile(code, postId, file) {
  const ext = (file.name.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0].toLowerCase();
  const path = `${code}/${crypto.randomUUID()}${ext}`;   // 한글 파일명은 저장 경로에 못 써서 랜덤 이름 사용
  const { error: upErr } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream' });
  if (upErr) throw upErr;
  const { error } = await sb.from('files').insert({ agency_code: code, post_id: postId, file_name: file.name, storage_path: path, size: file.size });
  if (error) throw error;
}

// ---------------- 자료함 ----------------
async function viewFiles(main) {
  if (!st.agency) { main.innerHTML = `<div class="empty">${isManager() ? '배정된 담당 대리점이 없습니다.' : '등록된 대리점이 없습니다.'}</div>`; return; }
  let fq = sb.from('files').select('*, posts(id,title,kind)').eq('agency_code', st.agency)
    .order('created_at', { ascending: false }).limit(500);
  if (st.q) fq = fq.ilike('file_name', `%${st.q}%`);
  const { data: files, error } = await fq;
  if (error) throw error;
  main.innerHTML = `<div class="bar">${isAdmin() ? agencySelect() : `<h2>내 자료함</h2>`}${searchBox('파일명 검색')}<div class="grow"></div><span style="color:var(--muted);font-size:13px">${files.length}개 파일</span></div>
    <div class="card"><table class="tbl"><thead><tr><th>파일명</th><th>게시글</th><th>올린 날짜</th><th></th></tr></thead><tbody>
    ${files.length ? files.map((f) => `<tr><td>${fileIcon(f.file_name)} ${esc(f.file_name)} <span style="color:var(--muted);font-size:12px">${fmtSize(f.size)}</span></td>
      <td>${f.posts ? `<a href="#" data-goto="${f.posts.id}">${esc(f.posts.title)}</a>` : '-'}</td><td>${fmt(f.created_at)}</td>
      <td style="text-align:right;white-space:nowrap">${pvBtn(f)} <button class="btn small" data-dl="${esc(f.storage_path)}" data-name="${esc(f.file_name)}">다운로드</button></td></tr>`).join('')
      : '<tr><td colspan="4"><div class="empty">자료가 없습니다.</div></td></tr>'}
    </tbody></table></div>`;
  bindAgencySelect(main); bindDownloads(main); bindSearchBox(main);
  main.querySelectorAll('[data-goto]').forEach((a) => a.onclick = (e) => { e.preventDefault(); st.tab = 'board'; st.postId = Number(a.dataset.goto); render(); });
}

// ---------------- 관리자: 가입 승인 ----------------
async function viewUsers(main) {
  const { data: users, error } = await sb.from('profiles').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  const opts = (sel) => `<option value="">— 대리점 선택 —</option>` + agencies.map((a) => `<option value="${esc(a.code)}" ${a.code === sel ? 'selected' : ''}>${esc(a.code)} · ${esc(a.name)}</option>`).join('');
  const guess = (u) => agencies.find((a) => a.code === (u.requested_code || '').trim())?.code
    || agencies.find((a) => u.requested_name && (a.name.replace(/㈜|\(주\)|주식회사|\s/g, '').includes(u.requested_name.replace(/㈜|\(주\)|주식회사|\s/g, ''))))?.code || '';
  const pending = users.filter((u) => u.status === 'pending');
  const approved = users.filter((u) => u.status === 'approved' && u.role === 'agency');
  const rejected = users.filter((u) => u.status === 'rejected');
  const roleSel = (r) => `<select class="rl"><option value="staff" ${r !== 'owner' && r !== 'manager' ? 'selected' : ''}>직원</option><option value="owner" ${r === 'owner' ? 'selected' : ''}>대표자</option>${isSuper() ? `<option value="prospect" ${r === 'prospect' ? 'selected' : ''}>신규 대리점</option><option value="manager" ${r === 'manager' ? 'selected' : ''}>본사 담당자</option>` : ''}</select>`;
  const managers = users.filter((u) => u.role === 'manager' && u.status === 'approved');
  const prospects = users.filter((u) => u.role === 'prospect' && u.status === 'approved');
  const who = (u) => `<b>${esc(u.contact_name || '-')}</b><div style="color:var(--muted);font-size:12.5px">${esc(u.email)}${u.phone ? ' · ' + esc(u.phone) : ''}</div>`;
  main.innerHTML = `
    <div class="bar"><h2>가입 승인</h2></div>
    <div class="card"><table class="tbl"><thead><tr><th>신청자</th><th>적어낸 대리점</th><th>연결할 대리점</th><th>구분</th><th></th></tr></thead><tbody>
      ${pending.length ? pending.map((u) => `<tr data-u="${u.id}"><td>${who(u)}</td><td>${esc(u.requested_name || '')} ${u.requested_code ? `(${esc(u.requested_code)})` : ''}<div style="color:var(--muted);font-size:12px">${fmt(u.created_at)}</div></td>
        <td><select class="ag ag-search">${opts(guess(u))}</select></td><td>${roleSel(u.requested_role)}</td>
        <td style="text-align:right;white-space:nowrap"><button class="btn small primary" data-act="approve">승인</button> <button class="btn small danger" data-act="reject">거절</button></td></tr>`).join('')
        : '<tr><td colspan="5"><div class="empty">대기 중인 신청이 없습니다.</div></td></tr>'}
    </tbody></table></div>
    <h3 class="section-title">승인된 대리점 사용자 (${approved.length})</h3>
    <div class="card"><table class="tbl"><thead><tr><th>사용자</th><th>대리점</th><th>구분</th><th></th></tr></thead><tbody>
      ${approved.length ? approved.map((u) => `<tr data-u="${u.id}"><td>${who(u)}</td><td><select class="ag ag-search">${opts(u.agency_code)}</select></td><td>${roleSel(u.agency_role)}</td>
        <td style="text-align:right;white-space:nowrap"><button class="btn small" data-act="move">변경 저장</button> <button class="btn small danger" data-act="reject">이용 중지</button></td></tr>`).join('')
        : '<tr><td colspan="4"><div class="empty">아직 없습니다.</div></td></tr>'}
    </tbody></table></div>
    ${isSuper() && prospects.length ? `<h3 class="section-title">신규 대리점 (${prospects.length}) <small class="muted">— 개설 서류 작성 중, [개설 신청]에서 검토·코드 발급</small></h3>
    <div class="card"><table class="tbl"><tbody>${prospects.map((u) => `<tr><td>${who(u)}</td><td>${esc(u.requested_name || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${isSuper() ? `<h3 class="section-title">본사 담당자 (${managers.length})</h3>
    <div class="card"><table class="tbl"><tbody>${managers.length ? managers.map((u) => `<tr data-u="${u.id}"><td>${who(u)}</td>
      <td>담당 대리점 <b>${agencies.filter((a) => a.manager_id === u.id).length}</b>곳</td>
      <td style="text-align:right"><button class="btn small danger" data-act="unmgr">담당자 해제</button></td></tr>`).join('')
      : '<tr><td><div class="empty small">본사 담당자가 없습니다. 일반 가입한 계정을 위 목록에서 구분 \'본사 담당자\'로 바꿔 지정하세요.</div></td></tr>'}</tbody></table></div>` : ''}
    ${rejected.length ? `<h3 class="section-title">거절·중지 (${rejected.length})</h3><div class="card"><table class="tbl"><tbody>
      ${rejected.map((u) => `<tr data-u="${u.id}"><td>${who(u)}</td><td>${esc(u.requested_name || '')}</td><td><select class="ag">${opts(u.agency_code || guess(u))}</select></td><td>${roleSel(u.agency_role)}</td>
        <td style="text-align:right"><button class="btn small" data-act="approve">다시 승인</button></td></tr>`).join('')}</tbody></table></div>` : ''}`;
  main.querySelectorAll('[data-act]').forEach((b) => b.onclick = async () => {
    const tr = b.closest('tr'); const id = tr.dataset.u; const code = tr.querySelector('.ag')?.value;
    const act = b.dataset.act;
    let patch;
    const rl = tr.querySelector('.rl')?.value;
    if ((act === 'approve' || act === 'move') && rl === 'prospect') {
      if (!isSuper()) return;
      patch = { status: 'approved', role: 'prospect', agency_code: null, agency_role: 'staff' };
    } else if ((act === 'approve' || act === 'move') && rl === 'manager') {
      if (!isSuper()) return;
      if (!confirm('이 계정을 본사 담당자로 지정할까요?\n배정한 대리점의 게시판·자료·가입 승인을 관리할 수 있게 됩니다.')) return;
      patch = { status: 'approved', role: 'manager', agency_code: null, agency_role: 'staff' };
    } else if (act === 'unmgr') {
      if (!confirm('본사 담당자 권한을 해제할까요? 배정된 대리점은 총관리자 관리로 돌아갑니다.')) return;
      await sb.from('agencies').update({ manager_id: null }).eq('manager_id', id);
      patch = { status: 'rejected', role: 'agency', agency_code: null };
    } else if (act === 'approve' || act === 'move') {
      if (!code) return toast('연결할 대리점을 선택하세요.', true);
      patch = { status: 'approved', role: 'agency', agency_code: code, agency_role: rl === 'owner' ? 'owner' : 'staff' };
    } else {
      if (!confirm('이 사용자의 이용을 막을까요?')) return;
      patch = { status: 'rejected' };
    }
    const { error } = await sb.from('profiles').update(patch).eq('id', id);
    if (error) return fail(error);
    toast(patch.role === 'prospect' ? '신규 대리점으로 승인했습니다. 개설 서류를 작성할 수 있습니다.' : patch.role === 'manager' ? '본사 담당자로 지정했습니다. [대리점 관리]에서 담당 대리점을 배정하세요.'
      : act === 'reject' || act === 'unmgr' ? '처리했습니다.' : `${agencyName(code)} ${ROLE_LABEL[patch.agency_role]}(으)로 저장했습니다.`); render();
  });
}

// ---------------- 관리자: 대리점 관리 ----------------
async function viewAgencies(main) {
  const { data: users } = await sb.from('profiles').select('id,agency_code,status,role,agency_role,contact_name,email,phone,created_at').eq('status', 'approved');
  const mgrs = (users || []).filter((u) => u.role === 'manager');
  const mgrSel = (a) => `<select class="mg"><option value="">총관리자 직접</option>${mgrs.map((m) => `<option value="${m.id}" ${a.manager_id === m.id ? 'selected' : ''}>${esc(m.contact_name || m.email)}</option>`).join('')}</select>`;
  const byAg = {}; (users || []).forEach((u) => { if (u.agency_code && u.role === 'agency') (byAg[u.agency_code] ||= []).push(u); });
  Object.values(byAg).forEach((l) => l.sort((a, b) => (a.agency_role === 'owner' ? 0 : 1) - (b.agency_role === 'owner' ? 0 : 1) || String(a.created_at).localeCompare(b.created_at)));
  const userCell = (a) => {
    const l = byAg[a.code] || [], own = l.filter((u) => u.agency_role === 'owner').length;
    if (!l.length) return '<span class="muted">0명</span>';
    return `<button type="button" class="ag-users" data-users="${esc(a.code)}" aria-expanded="${st.agOpen === a.code}">${l.length}명 <small>(대표 ${own} · 직원 ${l.length - own})</small> <span class="ag-caret">${st.agOpen === a.code ? '▴' : '▾'}</span></button>${own ? '' : '<span class="ct-st red ag-noown">대표 없음</span>'}`;
  };
  const userRows = (a) => `<tr class="ag-urow" ${st.agOpen === a.code ? '' : 'hidden'}><td></td><td colspan="4"><table class="ag-utbl"><thead><tr><th>이름</th><th>아이디 (이메일)</th><th>연락처</th><th>가입일</th><th>구분</th><th></th></tr></thead><tbody>
      ${(byAg[a.code] || []).map((u) => `<tr data-u="${u.id}"><td><b>${esc(u.contact_name || '-')}</b></td><td class="ag-mail">${esc(u.email)}</td><td>${esc(u.phone || '-')}</td><td>${fmt(u.created_at).slice(0, 10)}</td>
        <td><select class="ag-role"><option value="owner" ${u.agency_role === 'owner' ? 'selected' : ''}>대표</option><option value="staff" ${u.agency_role !== 'owner' ? 'selected' : ''}>직원</option></select></td>
        <td style="text-align:right"><button class="btn small" data-urole="${u.id}" disabled>변경</button></td></tr>`).join('')}</tbody></table>
      <p class="hint">대표는 계약·대리점 정보·직원 승인 메뉴를 쓰고, 전자계약에 날인할 수 있습니다. 직원은 공지·자료실·게시판만 씁니다.</p></td></tr>`;
  main.innerHTML = `
    <div class="bar"><h2>대리점 관리</h2><div class="grow"></div><span style="color:var(--muted);font-size:13px">${agencies.length}곳</span></div>
    <form class="card form-card" id="af" style="max-width:none;margin-bottom:16px;display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
      <label class="field" style="margin:0;width:140px"><span>대리점 코드</span><input type="text" name="code" required></label>
      <label class="field" style="margin:0;flex:1;min-width:200px"><span>대리점명</span><input type="text" name="name" required></label>
      <button class="btn primary">추가</button></form>
    <div class="card"><table class="tbl"><thead><tr><th style="width:110px">코드</th><th>대리점명</th><th>본사 담당자</th><th>사용자</th><th></th></tr></thead><tbody>
      ${agencies.map((a) => `<tr data-c="${esc(a.code)}"><td>${esc(a.code)}</td><td><input type="text" class="nm" value="${esc(a.name)}"></td><td>${mgrSel(a)}</td><td>${userCell(a)}</td>
        <td style="text-align:right;white-space:nowrap"><button class="btn small" data-act="save">저장</button> <button class="btn small danger" data-act="del">삭제</button></td></tr>${userRows(a)}`).join('')}
    </tbody></table></div>`;
  main.querySelectorAll('[data-users]').forEach((b) => b.onclick = () => {
    const open = st.agOpen !== b.dataset.users; st.agOpen = open ? b.dataset.users : null;
    main.querySelectorAll('.ag-urow').forEach((r) => { r.hidden = true; });
    main.querySelectorAll('[data-users]').forEach((x) => { x.setAttribute('aria-expanded', 'false'); x.querySelector('.ag-caret').textContent = '▾'; });
    if (open) { b.closest('tr').nextElementSibling.hidden = false; b.setAttribute('aria-expanded', 'true'); b.querySelector('.ag-caret').textContent = '▴'; }
  });
  main.querySelectorAll('.ag-role').forEach((sel) => sel.onchange = () => {
    const btn = sel.closest('tr').querySelector('[data-urole]'); const u = (users || []).find((x) => x.id === btn.dataset.urole);
    btn.disabled = sel.value === (u.agency_role === 'owner' ? 'owner' : 'staff'); btn.classList.toggle('primary', !btn.disabled);
  });
  main.querySelectorAll('[data-urole]').forEach((b) => b.onclick = async () => {
    const u = (users || []).find((x) => x.id === b.dataset.urole), role = b.closest('tr').querySelector('.ag-role').value;
    const nm = u.contact_name || u.email, ag = agencyName(u.agency_code);
    const others = (byAg[u.agency_code] || []).filter((x) => x.id !== u.id && x.agency_role === 'owner');
    const msg = role === 'owner'
      ? `${nm}(${u.email})님을 ${ag}의 대표로 바꿀까요?\n계약·대리점 정보·직원 승인 메뉴를 쓰고 전자계약에 날인할 수 있게 됩니다.${others.length ? `\n\n※ 이미 대표 ${others.map((x) => x.contact_name || x.email).join(', ')}님이 있습니다. 대표가 여러 명이 됩니다.` : ''}`
      : `${nm}(${u.email})님을 직원으로 바꿀까요?\n계약·대리점 정보 메뉴와 전자계약 날인 권한이 사라집니다.${others.length ? '' : `\n\n※ 바꾸면 ${ag}에 대표가 없게 됩니다.`}`;
    if (!confirm(msg)) return;
    const { error } = await sb.from('profiles').update({ agency_role: role }).eq('id', u.id);
    if (error) return fail(error);
    toast(`${nm}님을 ${role === 'owner' ? '대표' : '직원'}로 바꿨습니다.`); render();
  });
  main.querySelector('#af').onsubmit = async (e) => {
    e.preventDefault(); const v = form(e.target);
    const { error } = await sb.from('agencies').insert({ code: v.code.trim(), name: v.name.trim() });
    if (error) return fail(error.code === '23505' ? new Error('이미 있는 코드입니다.') : error);
    toast('추가했습니다.'); boot();
  };
  main.querySelectorAll('[data-act]').forEach((b) => b.onclick = async () => {
    const tr = b.closest('tr'); const code = tr.dataset.c;
    if (b.dataset.act === 'save') {
      const { error } = await sb.from('agencies').update({ name: tr.querySelector('.nm').value.trim(), manager_id: tr.querySelector('.mg').value || null }).eq('code', code);
      if (error) return fail(error); toast('저장했습니다.'); boot();
    } else {
      if (!confirm(`${code} 대리점을 삭제할까요?\n이 대리점의 게시글·자료 기록도 함께 삭제됩니다.`)) return;
      const { error } = await sb.from('agencies').delete().eq('code', code);
      if (error) return fail(error);
      if (st.agency === code) st.agency = null;
      toast('삭제했습니다.'); boot();
    }
  });
}

// =====================================================================
//  공통 도우미: 마크다운 편집기, 모달, 공통 첨부파일
// =====================================================================
const MD_TOOLS = [
  ['H', '제목', '\n## ', ''], ['B', '굵게', '**', '**'], ['•', '목록', '\n- ', ''], ['1.', '번호 목록', '\n1. ', ''],
  ['☑', '체크리스트', '\n- [ ] ', ''], ['❝', '인용', '\n> ', ''], ['🔗', '링크', '[', '](https://)'],
  ['▦', '표', '\n| 항목 | 내용 |\n|---|---|\n| ', ' |  |\n'], ['—', '구분선', '\n\n---\n', ''],
];
function mdEditor(name, value, rows = 14) {
  return `<div class="mded" data-md="${name}">
    <div class="mded-bar">${MD_TOOLS.map(([l, t], i) => `<button type="button" title="${t}" data-tool="${i}">${l}</button>`).join('')}
      <span class="grow"></span><button type="button" class="mded-prev">미리보기</button></div>
    <textarea name="${name}" rows="${rows}" placeholder="내용을 입력하세요. 위 버튼으로 제목·목록·표 등을 넣을 수 있습니다.">${esc(value || '')}</textarea>
    <div class="mded-view md" hidden></div></div>`;
}
function bindMdEditors(root) {
  root.querySelectorAll('.mded').forEach((ed) => {
    const ta = ed.querySelector('textarea'), view = ed.querySelector('.mded-view'), pv = ed.querySelector('.mded-prev');
    ed.querySelectorAll('[data-tool]').forEach((b) => b.onclick = () => {
      const [, , pre, post] = MD_TOOLS[b.dataset.tool];
      const s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e);
      ta.value = ta.value.slice(0, s) + pre + sel + post + ta.value.slice(e);
      ta.focus(); ta.selectionStart = ta.selectionEnd = s + pre.length + sel.length;
    });
    pv.onclick = () => {
      const on = view.hidden; view.hidden = !on; ta.hidden = on;
      if (on) view.innerHTML = md(ta.value) || '<p class="muted">내용 없음</p>';
      pv.textContent = on ? '편집' : '미리보기';
    };
  });
}

// 로그인 후 첫 화면에서 한 번만(브라우저 창 기준) 새 알림 요약을 띄운다. 항목을 누르면 해당 건이 펼쳐지고, 건을 누르면 바로 열림
async function briefDetails(k, ctx) {
  const last = (p) => (p.comments || []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at)).pop();
  const ag = (code) => `${code} ${agencyName(code)}`;
  if (k === 'inbox') {
    const { data } = await sb.from('posts').select('id,title,agency_code,last_activity,comments(author_role,created_at)').eq('kind', 'question').order('last_activity', { ascending: false }).limit(200);
    return (data || []).filter((p) => { const c = last(p); return !c || c.author_role !== 'admin'; })
      .map((p) => ({ t: p.title, sub: `${ag(p.agency_code)} · ${last(p) ? '추가 문의' : '새 문의'} · ${fmt(p.last_activity)}`, nav: { tab: 'inbox', postId: p.id } }));
  }
  if (k === 'board') {
    const { data } = await sb.from('posts').select('id,title,last_activity,comments(author_role,created_at,body)').eq('agency_code', me.agency_code).eq('kind', 'question').order('last_activity', { ascending: false }).limit(100);
    const ans = (data || []).filter((p) => last(p)?.author_role === 'admin');
    const { mine } = await readMap(ans.map((p) => p.id));
    return ans.filter((p) => !mine[p.id] || new Date(mine[p.id]) < new Date(last(p).created_at))
      .map((p) => ({ t: p.title, sub: `답변: ${String(last(p).body || '').replace(/\s+/g, ' ').slice(0, 40)} · ${fmt(last(p).created_at)}`, nav: { tab: 'board', postId: p.id } }));
  }
  if (k === 'contracts') {
    const { data } = await sb.from('contracts').select('id,title,kind,agency_code,signed_at,sent_at').eq('status', isAdmin() ? 'agency_signed' : 'sent').order('updated_at', { ascending: false }).limit(20);
    return (data || []).map((c) => ({ t: `${c.title} (${c.kind})`, sub: isAdmin() ? `${ctNo(c.id)} · ${ag(c.agency_code)} · 대리점 날인 ${fmt(c.signed_at)}` : `${ctNo(c.id)} · 본사 요청 ${fmt(c.sent_at)}`, nav: { tab: 'contracts', ctId: c.id } }));
  }
  if (k === 'users') {
    const { data } = await sb.from('profiles').select('contact_name,email,requested_name,requested_code,requested_role,created_at').eq('status', 'pending').order('created_at', { ascending: false }).limit(20);
    return (data || []).map((u) => ({ t: `${u.contact_name || u.email}${u.requested_name ? ` · ${u.requested_name}` : ''}${u.requested_code ? `(${u.requested_code})` : ''}`,
      sub: `${u.requested_role === 'prospect' ? '신규 대리점' : u.requested_role === 'owner' ? '대표자' : '직원'} 가입 신청 · ${fmt(u.created_at)}`, nav: { tab: 'users' } }));
  }
  if (k === 'onboarding') {
    const { data } = await sb.from('onboard_apps').select('id,company_name,ceo_name,submitted_at').eq('status', 'submitted').order('submitted_at', { ascending: false }).limit(20);
    return (data || []).map((a) => ({ t: a.company_name || '(상호 미입력)', sub: `대표 ${a.ceo_name || '-'} · 제출 ${fmt(a.submitted_at)}`, nav: { tab: 'onboarding', obId: a.id } }));
  }
  if (k === 'notices') {
    const { data } = await sb.from('notices').select('id,title,created_at').gt('created_at', ctx.seenNotice).order('created_at', { ascending: false }).limit(20);
    return (data || []).map((n) => ({ t: n.title, sub: fmt(n.created_at), nav: { tab: 'notices', noticeId: n.id } }));
  }
  if (k === 'myagency') {
    const { data } = await sb.rpc('my_members');
    return (data || []).filter((m) => m.status === 'pending').map((m) => ({ t: m.contact_name || m.email || '직원', sub: `직원 가입 신청${m.created_at ? ' · ' + fmt(m.created_at) : ''}`, nav: { tab: 'myagency' } }));
  }
  return [];
}
function showLoginBrief(items, go, ctx = {}) {
  const key = `portal_brief_${me.id}`;
  try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch { return; }
  const list = items.filter(([, , n]) => n > 0);
  if (!list.length) return;
  const wrap = document.createElement('div'); wrap.className = 'modal-bg';
  wrap.innerHTML = `<div class="modal card brief" role="dialog" aria-modal="true"><h3>🔔 새 알림 ${list.reduce((a, [, , n]) => a + n, 0)}건</h3>
    <p class="hint">${esc(me.contact_name || '')}님, 확인이 필요한 항목입니다. 항목을 누르면 내용을 볼 수 있습니다.</p>
    <ul class="brief-list">${list.map(([k, l, n], i) => `<li data-k="${k}"><button type="button" class="brief-row" aria-expanded="false"><span class="brief-car">▸</span><span>${esc(l)}</span><b>${n}건</b></button>
      <div class="brief-det" hidden></div></li>`).join('')}</ul>
    <div class="modal-btns"><button type="button" class="btn primary" data-x>확인</button></div></div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  const open = (nav) => { close(); resetView(); Object.assign(st, { q: '', filter: 'all' }, nav); window.scrollTo(0, 0); render(); };
  wrap.querySelector('[data-x]').onclick = close;
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  wrap.querySelectorAll('.brief-list > li').forEach((li) => {
    const btn = li.querySelector('.brief-row'), det = li.querySelector('.brief-det'), k = li.dataset.k;
    let loaded = false;
    btn.onclick = async () => {
      const on = det.hidden; det.hidden = !on; btn.setAttribute('aria-expanded', String(on)); li.classList.toggle('open', on);
      if (!on || loaded) return;
      det.innerHTML = '<div class="brief-load">불러오는 중…</div>';
      try {
        const rows = await briefDetails(k, ctx); loaded = true;
        const shown = rows.slice(0, 5);
        det.innerHTML = (shown.length ? shown.map((r, j) => `<button type="button" class="brief-item" data-j="${j}"><b>${esc(r.t)}</b><small>${esc(r.sub)}</small></button>`).join('')
          : '<div class="brief-load">표시할 내용이 없습니다.</div>')
          + `<button type="button" class="brief-all">${rows.length > 5 ? `외 ${rows.length - 5}건 · ` : ''}전체 보기 ›</button>`;
        det.querySelectorAll('.brief-item').forEach((b) => b.onclick = () => open(shown[+b.dataset.j].nav));
        det.querySelector('.brief-all').onclick = () => { close(); go(k); };
      } catch (e) { det.innerHTML = '<div class="brief-load">내용을 불러오지 못했습니다.</div>'; }
    };
  });
  setTimeout(() => wrap.querySelector('[data-x]')?.focus(), 0);
}

function modal(title, bodyHtml, onSubmit, submitLabel = '저장', wide = false) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-bg';
  wrap.innerHTML = `<form class="modal card ${wide ? 'wide' : ''}"><h3>${esc(title)}</h3>${bodyHtml}
    <div class="modal-btns"><button type="button" class="btn" data-x>취소</button><button class="btn primary">${esc(submitLabel)}</button></div></form>`;
  document.body.appendChild(wrap);
  const f = wrap.querySelector('form');
  const close = () => wrap.remove();
  wrap.querySelector('[data-x]').onclick = close;
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector('.btn.primary'); btn.disabled = true;
    try { await onSubmit(form(f), f); close(); } catch (err) { fail(err); btn.disabled = false; }
  };
  setTimeout(() => f.querySelector('input,select,textarea')?.focus(), 0);
  return wrap;
}

async function uploadCommon(file, ref) {
  const ext = (file.name.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0].toLowerCase();
  const path = `common/${crypto.randomUUID()}${ext}`;
  const { error: upErr } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream' });
  if (upErr) throw upErr;
  const { error } = await sb.from('common_files').insert({ ...ref, file_name: file.name, storage_path: path, size: file.size });
  if (error) throw error;
}
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i, PDF_EXT = /\.pdf$/i, XLS_EXT = /\.(xlsx|xlsm|xls|csv)$/i;
const canPreview = (n) => IMG_EXT.test(n) || PDF_EXT.test(n) || XLS_EXT.test(n);
const fileIcon = (n) => IMG_EXT.test(n) ? '🖼' : PDF_EXT.test(n) ? '📕' : XLS_EXT.test(n) ? '📊' : /\.(docx?|hwpx?)$/i.test(n) ? '📄' : /\.(pptx?)$/i.test(n) ? '📙' : /\.(zip|7z)$/i.test(n) ? '🗜' : '📎';
const pvBtn = (f) => canPreview(f.file_name) ? `<button type="button" class="btn small" data-pv="${esc(f.storage_path)}" data-name="${esc(f.file_name)}">미리보기</button>` : '';
function commonFilesHtml(files, editable = false) {
  if (!files?.length) return '';
  const pv = files.filter((f) => canPreview(f.file_name));
  return `${pv.length && !editable ? `<div class="thumbs">${pv.map((f) => `<button type="button" class="thumb" data-pv="${esc(f.storage_path)}" data-name="${esc(f.file_name)}" title="${esc(f.file_name)} 미리보기">
      <div class="thumb-box" data-thumb="${esc(f.storage_path)}" data-kind="${IMG_EXT.test(f.file_name) ? 'img' : PDF_EXT.test(f.file_name) ? 'pdf' : 'xls'}" data-name="${esc(f.file_name)}"><span class="thumb-wait">${fileIcon(f.file_name)}</span></div>
      <div class="thumb-cap">${fileIcon(f.file_name)} ${esc(f.file_name)}</div></button>`).join('')}</div>` : ''}
    <div class="files">${files.map((f) => `<div class="f"><span>${fileIcon(f.file_name)}</span><span class="n">${esc(f.file_name)}</span><span class="s">${fmtSize(f.size)}</span>
    ${editable ? `<button type="button" class="btn small danger" data-rmfile="${f.id}" data-path="${esc(f.storage_path)}">삭제</button>`
               : `${pvBtn(f)}<button type="button" class="btn small" data-dl="${esc(f.storage_path)}" data-name="${esc(f.file_name)}">다운로드</button>`}</div>`).join('')}</div>`;
}

// ---------- 미리보기 (이미지 · PDF · 엑셀) ----------
const urlCache = new Map();
async function signedUrl(path) {
  const c = urlCache.get(path); if (c && c.exp > Date.now()) return c.url;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600); if (error) throw error;
  urlCache.set(path, { url: data.signedUrl, exp: Date.now() + 3500e3 }); return data.signedUrl;
}
const wbCache = new Map();   // 같은 엑셀을 썸네일·미리보기에서 두 번 받지 않도록
function workbookOf(path, name) {
  if (!wbCache.has(path)) wbCache.set(path, signedUrl(path).then((u) => fetch(u)).then((r) => r.arrayBuffer()).then((b) => renderWorkbook(b, name)));
  return wbCache.get(path);
}
async function hydrateThumbs(root) {
  const boxes = [...root.querySelectorAll('[data-thumb]')]; if (!boxes.length) return;
  const imgs = boxes.filter((b) => b.dataset.kind === 'img');
  if (imgs.length) {
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(imgs.map((i) => i.dataset.thumb), 3600);
    (data || []).forEach((d, k) => { if (!d.signedUrl) return; urlCache.set(imgs[k].dataset.thumb, { url: d.signedUrl, exp: Date.now() + 3500e3 });
      imgs[k].innerHTML = `<img src="${esc(d.signedUrl)}" alt="">`; });
  }
  for (const b of boxes.filter((x) => x.dataset.kind !== 'img')) {
    try {
      if (b.dataset.kind === 'pdf') {
        const cv = document.createElement('canvas'); await renderPdfThumb(await signedUrl(b.dataset.thumb), cv, 320);
        b.innerHTML = ''; b.appendChild(cv);
      } else {
        const sheets = await workbookOf(b.dataset.thumb, b.dataset.name);
        b.innerHTML = `<div class="thumb-sheet">${sheets[0]?.html || ''}</div>`;
        const inner = b.firstElementChild, t = inner.querySelector('table');
        if (t) { const sc = Math.min(1, b.clientWidth / t.offsetWidth); inner.style.transform = `scale(${sc})`; }
      }
    } catch (e) { console.warn('썸네일 실패', e); }
  }
}
async function openPreview(path, name) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = `<div class="lb-top"><span class="lb-name">${esc(name)}</span><span class="grow"></span>
    <span class="lb-zoom" hidden><button type="button" class="btn small" data-z="-">−</button><span class="lb-zv">100%</span><button type="button" class="btn small" data-z="+">+</button>
      <button type="button" class="btn small" data-z="fit">화면 맞춤</button></span>
    <button type="button" class="btn small" data-lbdl>다운로드</button><button type="button" class="btn small" data-lbx>닫기 ✕</button></div>
    <div class="lb-body"><div class="empty" style="color:#cbd2dc">불러오는 중…</div></div>`;
  document.body.appendChild(box); document.body.style.overflow = 'hidden';
  const close = () => { box.remove(); document.body.style.overflow = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  box.querySelector('[data-lbx]').onclick = close;
  box.onclick = (e) => { if (e.target === box || e.target.classList.contains('lb-body')) close(); };
  box.querySelector('[data-lbdl]').onclick = async () => {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 120, { download: name });
    if (error) return fail(error); window.location.href = data.signedUrl;
  };
  const body = box.querySelector('.lb-body');
  try {
    const url = await signedUrl(path);
    if (IMG_EXT.test(name)) {
      body.innerHTML = `<img class="lb-img" src="${esc(url)}" alt="${esc(name)}">`;
    } else if (PDF_EXT.test(name)) {
      body.innerHTML = `<iframe class="lb-pdf" src="${esc(url)}" title="${esc(name)}"></iframe>
        <a class="lb-open" href="${esc(url)}" target="_blank" rel="noopener">화면에 안 보이면 새 창에서 열기 ↗</a>`;
    } else if (XLS_EXT.test(name)) {
      const sheets = await workbookOf(path, name);
      const zoomUi = box.querySelector('.lb-zoom'); zoomUi.hidden = false;
      let zoom = 1, cur = 0;
      const apply = () => { const p = body.querySelector('.xv-page'); if (p) p.style.zoom = zoom; box.querySelector('.lb-zv').textContent = Math.round(zoom * 100) + '%'; };
      const fit = () => { const t = body.querySelector('.xv-page table'); if (!t) return; zoom = Math.min(1.2, (body.clientWidth - 40) / t.offsetWidth); apply(); };
      const show = (i) => {
        cur = i; const sh = sheets[i];
        body.innerHTML = `${sheets.length > 1 ? `<div class="lb-sheets">${sheets.map((x, k) => `<button type="button" class="chip ${k === i ? 'on' : ''}" data-sheet="${k}">${esc(x.name)}</button>`).join('')}</div>` : ''}
          ${sh.truncated ? '<p class="lb-note">앞 500행만 표시합니다. 전체는 다운로드해서 확인하세요.</p>' : ''}
          <div class="xv-page">${DOMPurify.sanitize(sh.html, { ADD_ATTR: ['target'] })}</div>`;
        body.querySelectorAll('[data-sheet]').forEach((b) => b.onclick = () => show(Number(b.dataset.sheet)));
        requestAnimationFrame(fit);
      };
      box.querySelectorAll('[data-z]').forEach((b) => b.onclick = () => {
        if (b.dataset.z === 'fit') return fit();
        zoom = Math.max(.3, Math.min(3, zoom + (b.dataset.z === '+' ? .1 : -.1))); apply();
      });
      show(0);
    }
  } catch (e) { console.error(e); body.innerHTML = `<div class="empty" style="color:#fff">미리보기를 열 수 없습니다. 다운로드해서 확인해 주세요.</div>`; }
}

function bindRemoveFiles(root) {
  root.querySelectorAll('[data-rmfile]').forEach((b) => b.onclick = async () => {
    if (!confirm('이 첨부파일을 삭제할까요?')) return;
    await sb.storage.from(BUCKET).remove([b.dataset.path]);
    const { error } = await sb.from('common_files').delete().eq('id', b.dataset.rmfile);
    if (error) return fail(error);
    b.closest('.f').remove(); toast('첨부파일을 삭제했습니다.');
  });
}
// 같은 이름의 파일을 다시 올리면 옛 파일은 지우고 새 파일로 교체 (옛 양식이 남지 않게)
async function removeSameName(existing, newFiles) {
  const names = new Set(newFiles.map((f) => f.name.normalize('NFC')));
  const old = (existing || []).filter((f) => names.has(f.file_name.normalize('NFC')));
  if (!old.length) return;
  await sb.storage.from(BUCKET).remove(old.map((f) => f.storage_path));
  const { error } = await sb.from('common_files').delete().in('id', old.map((f) => f.id)); if (error) throw error;
}
async function deleteCommonFiles(col, id) {
  const { data } = await sb.from('common_files').select('storage_path').eq(col, id);
  if (data?.length) await sb.storage.from(BUCKET).remove(data.map((f) => f.storage_path));
}

// =====================================================================
//  공지사항 (모든 대리점 공통)
// =====================================================================
async function viewNotices(main) {
  if (st.noticeEdit) return viewNoticeEdit(main);
  if (st.noticeId) return viewNotice(main);
  let q = sb.from('notices').select('id,title,body,pinned,pin_until,author_name,created_at,common_files(count)')
    .order('created_at', { ascending: false }).limit(300);
  if (st.q) q = q.or(`title.ilike.%${st.q}%,body.ilike.%${st.q}%`);
  const { data: list, error } = await q; if (error) throw error;
  sortNotices(list);
  main.innerHTML = `<div class="bar"><h2>공지사항</h2>${searchBox('공지 검색')}<div class="grow"></div>
    ${isSuper() ? '<button class="btn primary" id="newN">공지 작성</button>' : ''}</div>
    <div class="card list">${list.length ? list.map((n) => `<div class="item notice-row ${pinActive(n) ? 'pinned' : ''}" data-n="${n.id}">
      <span class="badge ${pinActive(n) ? 'notice' : 'gray'}">${pinActive(n) ? '📌 중요' + pinLabel(n) : '공지'}</span>
      <div><div class="t">${esc(n.title)}${isNew(n.created_at) ? ' <span class="new">N</span>' : ''}</div>
        ${plain(n.body, 80) ? `<div class="snip">${esc(plain(n.body, 80))}</div>` : ''}
        <div class="meta"><span>${esc(n.author_name || '')}</span>${n.common_files?.[0]?.count ? `<span>📎 ${n.common_files[0].count}</span>` : ''}</div></div>
      <div class="right">${fmt(n.created_at).slice(0, 10)}</div></div>`).join('')
      : `<div class="empty">${st.q ? '검색 결과가 없습니다.' : '등록된 공지가 없습니다.'}</div>`}</div>`;
  bindSearchBox(main);
  main.querySelectorAll('[data-n]').forEach((el) => el.onclick = () => { st.noticeId = Number(el.dataset.n); render(); });
  const nb = main.querySelector('#newN'); if (nb) nb.onclick = () => { st.noticeEdit = 'new'; render(); };
}

async function viewNotice(main) {
  const [{ data: n, error }, { data: files }] = await Promise.all([
    sb.from('notices').select('*').eq('id', st.noticeId).maybeSingle(),
    sb.from('common_files').select('*').eq('notice_id', st.noticeId).order('id'),
  ]);
  if (error) throw error;
  if (!n) { st.noticeId = null; main.innerHTML = '<div class="empty">공지를 찾을 수 없습니다.</div>'; return; }
  main.innerHTML = `<div class="bar"><button class="btn" id="back">← 목록</button><div class="grow"></div>
    ${isSuper() ? '<button class="btn small" id="edit">수정</button> <button class="btn small danger" id="del">삭제</button>' : ''}</div>
    <article class="card post">
      <span class="badge ${pinActive(n) ? 'notice' : 'gray'}">${pinActive(n) ? '📌 중요 공지' + pinLabel(n) : '공지'}</span>
      <h3>${esc(n.title)}</h3>
      <div class="meta">${esc(n.author_name || '')} · ${fmt(n.created_at)}${n.updated_at && new Date(n.updated_at) - new Date(n.created_at) > 60000 ? ` (수정 ${fmt(n.updated_at)})` : ''}</div>
      <div class="md body-md">${md(n.body)}</div>
      ${commonFilesHtml(files)}
    </article>`;
  main.querySelector('#back').onclick = () => { st.noticeId = null; render(); };
  bindDownloads(main);
  if (isSuper()) {
    main.querySelector('#edit').onclick = () => { st.noticeEdit = n.id; render(); };
    main.querySelector('#del').onclick = async () => {
      if (!confirm('이 공지와 첨부파일을 삭제할까요?')) return;
      await deleteCommonFiles('notice_id', n.id);
      const { error: e } = await sb.from('notices').delete().eq('id', n.id); if (e) return fail(e);
      st.noticeId = null; toast('삭제했습니다.'); render();
    };
  }
}

async function viewNoticeEdit(main) {
  const isNewN = st.noticeEdit === 'new';
  let n = { title: '', body: '', pinned: false, pin_until: null }, files = [];
  if (!isNewN) {
    const r = await sb.from('notices').select('*').eq('id', st.noticeEdit).single(); if (r.error) throw r.error; n = r.data;
    files = (await sb.from('common_files').select('*').eq('notice_id', n.id).order('id')).data || [];
  }
  main.innerHTML = `<div class="bar"><button class="btn" id="back">← 취소</button><h2>${isNewN ? '공지 작성' : '공지 수정'}</h2></div>
    <form class="card form-card wide" id="nf">
      <label class="field"><span>제목</span><input type="text" name="title" required maxlength="200" value="${esc(n.title)}"></label>
      <div class="pin-row"><label class="check"><input type="checkbox" name="pinned" ${n.pinned ? 'checked' : ''}> 📌 중요 공지 (홈 배너·목록 맨 위)</label>
        <label class="check">고정 기한 <input type="date" name="pin_until" value="${esc(n.pin_until || '')}"> <small class="muted">비우면 계속 고정</small></label></div>
      <div class="field"><span>내용</span>${mdEditor('body', n.body)}</div>
      ${files.length ? `<div class="field"><span>기존 첨부파일</span>${commonFilesHtml(files, true)}</div>` : ''}
      <label class="field"><span>첨부파일 추가 <small>(여러 개 가능, 파일당 50MB 이하 · 같은 이름이면 새 파일로 교체)</small></span><input type="file" name="files" multiple></label>
      <p class="hint">모든 승인된 대리점에 공개됩니다.</p>
      <button class="btn primary" id="sub">${isNewN ? '등록' : '저장'}</button><span class="progress" id="prog"></span>
    </form>`;
  bindMdEditors(main); bindRemoveFiles(main);
  main.querySelector('#back').onclick = () => { st.noticeEdit = null; render(); };
  main.querySelector('#nf').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; const btn = main.querySelector('#sub'); btn.disabled = true;
    const newFiles = [...f.files.files];
    if (newFiles.some((x) => x.size > 50 * 1024 * 1024)) { btn.disabled = false; return toast('50MB를 넘는 파일이 있습니다.', true); }
    try {
      const row = { title: f.title.value.trim(), body: f.body.value, pinned: f.pinned.checked, pin_until: f.pinned.checked && f.pin_until.value ? f.pin_until.value : null };
      let id = n.id;
      if (isNewN) {
        row.author_name = me.contact_name || me.email;
        const r = await sb.from('notices').insert(row).select('id').single(); if (r.error) throw r.error; id = r.data.id;
      } else {
        const r = await sb.from('notices').update(row).eq('id', id); if (r.error) throw r.error;
      }
      await removeSameName(files, newFiles);
      for (let i = 0; i < newFiles.length; i++) {
        main.querySelector('#prog').textContent = `파일 ${i + 1}/${newFiles.length} 올리는 중…`;
        await uploadCommon(newFiles[i], { notice_id: id });
      }
      toast(isNewN ? '공지를 등록했습니다.' : '저장했습니다.');
      st.noticeEdit = null; st.noticeId = id; render();
    } catch (err) { fail(err); btn.disabled = false; }
  };
}

// =====================================================================
//  공통 자료실 (노션형: 분류 > 하위분류 > 페이지)
// =====================================================================
const libOpen = new Set();
async function loadLib() {
  const [{ data: cats, error: e1 }, { data: pages, error: e2 }] = await Promise.all([
    sb.from('lib_categories').select('*').order('sort').order('id'),
    sb.from('lib_pages').select('id,category_id,title,icon,sort,updated_at,created_at,author_name,featured').order('sort').order('id'),
  ]);
  if (e1) throw e1; if (e2) throw e2;
  return { cats, pages };
}
const catChildren = (cats, pid) => cats.filter((c) => (c.parent_id ?? null) === (pid ?? null));
function catPath(cats, id) {
  const out = []; let c = cats.find((x) => x.id === id);
  while (c) { out.unshift(c); c = c.parent_id ? cats.find((x) => x.id === c.parent_id) : null; }
  return out;
}
const topNo = (cats, id) => { const root = catPath(cats, id)[0]; return root ? catChildren(cats, null).indexOf(root) + 1 : 0; };
const numBadge = (n, big = false) => n ? `<span class="tnum c${(n - 1) % 6}${big ? ' big' : ''}">${n}</span>` : '';
function catPageCount(cats, pages, id) {
  return pages.filter((p) => p.category_id === id).length + catChildren(cats, id).reduce((s, c) => s + catPageCount(cats, pages, c.id), 0);
}

async function viewLibrary(main) {
  const lib = await loadLib();
  if (st.libEdit) return viewLibEdit(main, lib);
  // 현재 위치의 상위 분류 펼치기
  const cur = st.libPage ? lib.pages.find((p) => p.id === st.libPage)?.category_id : st.libCat;
  catPath(lib.cats, cur).forEach((c) => libOpen.add(c.id));

  main.innerHTML = `<div class="lib">
    <aside class="lib-side card ${st.libPage || st.libCat || st.libQ ? 'collapsed' : ''}" id="lside">
      <button type="button" class="lib-toggle" id="ltog">📂 분류 보기</button>
      <form class="lib-search" id="ls"><input type="search" name="q" placeholder="자료실 검색" value="${esc(st.libQ)}"></form>
      <div class="lib-home ${!st.libCat && !st.libPage && !st.libQ ? 'on' : ''}" id="lhome">자료실 홈</div>
      <nav class="lib-tree">${treeHtml(lib, null, 0)}</nav>
      ${isSuper() ? '<button class="btn small block-sm" id="addCat">+ 분류 추가</button>' : ''}
    </aside>
    <section class="lib-main" id="lmain"></section></div>`;
  const lmain = main.querySelector('#lmain');
  main.querySelector('#ltog').onclick = () => main.querySelector('#lside').classList.toggle('collapsed');

  main.querySelector('#ls').onsubmit = (e) => { e.preventDefault(); st.libQ = cleanQ(e.target.q.value); st.libPage = null; st.libCat = null; render(); };
  main.querySelector('#lhome').onclick = () => { Object.assign(st, { libCat: null, libPage: null, libQ: '' }); render(); };
  main.querySelectorAll('[data-tcat]').forEach((el) => el.onclick = (e) => {
    const id = Number(el.dataset.tcat);
    if (e.target.closest('.tw')) { libOpen.has(id) ? libOpen.delete(id) : libOpen.add(id); return render(); }
    libOpen.add(id); Object.assign(st, { libCat: id, libPage: null, libQ: '' }); render();
  });
  main.querySelectorAll('[data-tpage]').forEach((el) => el.onclick = () => { Object.assign(st, { libPage: Number(el.dataset.tpage), libQ: '' }); render(); });
  const ac = main.querySelector('#addCat'); if (ac) ac.onclick = () => catDialog(null, null);

  if (st.libQ) return libSearchView(lmain, lib);
  if (st.libPage) return libPageView(lmain, lib);
  if (st.libCat) return libCatView(lmain, lib);
  return libHomeView(lmain, lib);
}

function treeHtml(lib, pid, depth) {
  return catChildren(lib.cats, pid).map((c) => {
    const open = libOpen.has(c.id);
    const kids = catChildren(lib.cats, c.id), pages = lib.pages.filter((p) => p.category_id === c.id).sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
    const hasKids = kids.length || pages.length;
    const lead = depth === 0 ? numBadge(topNo(lib.cats, c.id)) : '';
    return `<div class="tnode d${Math.min(depth, 2)}">
      <div class="trow cat d${Math.min(depth, 2)} ${st.libCat === c.id && !st.libPage ? 'on' : ''}" data-tcat="${c.id}">
        ${lead}<span class="tn">${esc(c.name)}</span>
        <span class="tc">${catPageCount(lib.cats, lib.pages, c.id) || ''}</span><span class="tw">${hasKids ? (open ? '▾' : '▸') : ''}</span></div>
      ${open && hasKids ? `<div class="tkids">${treeHtml(lib, c.id, depth + 1)}${pages.map((p) => `<div class="trow page ${st.libPage === p.id ? 'on' : ''}" data-tpage="${p.id}">
        <span class="tn">${p.featured ? '<span class="tstar">★</span>' : ''}${esc(p.title)}</span></div>`).join('')}</div>` : ''}
    </div>`;
  }).join('');
}

function pageCards(pages, cats) {
  return `<div class="pcards">${pages.map((p) => `<div class="pcard" data-goto-page="${p.id}">
    <div class="pc-t">${p.featured ? '<span class="star">⭐</span>' : ''}${esc(p.title)}${p.created_at && daysAgo(p.created_at) < 7 ? ' <span class="new">NEW</span>' : p.updated_at && daysAgo(p.updated_at) < 7 ? ' <span class="new upd">UP</span>' : ''}</div>
    <div class="pc-m">${cats ? esc(catPath(cats, p.category_id).map((c) => c.name).join(' › ')) + ' · ' : ''}${fmt(p.updated_at).slice(0, 10)}</div></div>`).join('')}</div>`;
}
function bindPageCards(root) {
  root.querySelectorAll('[data-goto-page]').forEach((el) => el.onclick = () => { Object.assign(st, { libPage: Number(el.dataset.gotoPage), libQ: '' }); render(); });
}

function libHomeView(el, lib) {
  const tops = catChildren(lib.cats, null);
  const recent = [...lib.pages].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 8);
  const feat = lib.pages.filter((p) => p.featured);
  el.innerHTML = `<div class="lib-head"><h2>📚 자료실</h2><p class="muted">분류를 선택하거나 검색해서 자료를 찾으세요.</p></div>
    ${feat.length ? `<h3 class="section-title">⭐ 추천 자료</h3>${pageCards(feat, lib.cats)}<div style="height:18px"></div>` : ''}
    <div class="ccards">${tops.map((c, i) => `<div class="ccard" data-goto-cat="${c.id}"><div class="cc-i">${numBadge(i + 1, true)}</div>
      <div class="cc-t">${esc(c.name)}</div><div class="cc-m">자료 ${catPageCount(lib.cats, lib.pages, c.id)}개</div></div>`).join('')
      || '<div class="empty">아직 분류가 없습니다.</div>'}</div>
    ${recent.length ? `<h3 class="section-title">최근 업데이트</h3>${pageCards(recent, lib.cats)}` : ''}`;
  el.querySelectorAll('[data-goto-cat]').forEach((c) => c.onclick = () => { st.libCat = Number(c.dataset.gotoCat); render(); });
  bindPageCards(el);
}

function crumbs(lib, catId, extra) {
  const path = catPath(lib.cats, catId);
  return `<div class="crumbs"><a href="#" data-crumb="">자료실</a>${path.map((c) => ` › <a href="#" data-crumb="${c.id}">${esc(c.name)}</a>`).join('')}${extra ? ` › <span>${extra}</span>` : ''}</div>`;
}
function bindCrumbs(el) {
  el.querySelectorAll('[data-crumb]').forEach((a) => a.onclick = (e) => {
    e.preventDefault(); Object.assign(st, { libCat: a.dataset.crumb ? Number(a.dataset.crumb) : null, libPage: null }); render();
  });
}

function libCatView(el, lib) {
  const c = lib.cats.find((x) => x.id === st.libCat);
  if (!c) { st.libCat = null; return libHomeView(el, lib); }
  const kids = catChildren(lib.cats, c.id), pages = lib.pages.filter((p) => p.category_id === c.id).sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
  el.innerHTML = `${crumbs(lib, c.parent_id)}
    <div class="lib-head"><h2>${c.parent_id ? '' : numBadge(topNo(lib.cats, c.id), true)} ${esc(c.name)}</h2>
      ${isSuper() ? `<div class="lib-actions"><button class="btn small primary" id="addPage">+ 페이지</button>
        ${!c.parent_id ? '<button class="btn small" id="addSub">+ 하위 분류</button>' : ''}
        <button class="btn small" id="editCat">분류 편집</button><button class="btn small danger" id="delCat">분류 삭제</button></div>` : ''}</div>
    ${kids.length ? `<div class="ccards">${kids.map((k) => `<div class="ccard sub" data-goto-cat="${k.id}">
      <div class="cc-t">${esc(k.name)}</div><div class="cc-m">자료 ${catPageCount(lib.cats, lib.pages, k.id)}개</div></div>`).join('')}</div>` : ''}
    ${pages.length ? pageCards(pages) : (kids.length ? '' : '<div class="card empty">이 분류에 아직 자료가 없습니다.</div>')}`;
  bindCrumbs(el); bindPageCards(el);
  el.querySelectorAll('[data-goto-cat]').forEach((k) => k.onclick = () => { st.libCat = Number(k.dataset.gotoCat); render(); });
  if (isSuper()) {
    el.querySelector('#addPage').onclick = () => { st.libEdit = { page: 'new', cat: c.id }; render(); };
    const as = el.querySelector('#addSub'); if (as) as.onclick = () => catDialog(null, c.id);
    el.querySelector('#editCat').onclick = () => catDialog(c, c.parent_id, lib);
    el.querySelector('#delCat').onclick = async () => {
      const n = catPageCount(lib.cats, lib.pages, c.id);
      if (!confirm(`'${c.name}' 분류를 삭제할까요?${n ? `\n안에 있는 자료 ${n}개와 하위 분류도 함께 삭제됩니다.` : ''}`)) return;
      const ids = [c.id, ...catChildren(lib.cats, c.id).map((k) => k.id)];
      const pids = lib.pages.filter((p) => ids.includes(p.category_id)).map((p) => p.id);
      if (pids.length) {
        const { data: fs } = await sb.from('common_files').select('storage_path').in('page_id', pids);
        if (fs?.length) await sb.storage.from(BUCKET).remove(fs.map((f) => f.storage_path));
      }
      const { error } = await sb.from('lib_categories').delete().eq('id', c.id); if (error) return fail(error);
      st.libCat = c.parent_id || null; toast('분류를 삭제했습니다.'); render();
    };
  }
}

function catDialog(cat, parentId, lib) {
  const isEdit = !!cat;
  const parentOpts = lib && isEdit && !catChildren(lib.cats, cat.id).length
    ? `<label class="field"><span>상위 분류</span><select name="parent"><option value="">(최상위)</option>${catChildren(lib.cats, null).filter((c) => c.id !== cat.id)
        .map((c) => `<option value="${c.id}" ${c.id === cat.parent_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>` : '';
  modal(isEdit ? '분류 편집' : (parentId ? '하위 분류 추가' : '분류 추가'), `
    <div class="row-icon"><label class="field"><span>아이콘</span><input type="text" name="icon" maxlength="4" value="${esc(cat?.icon || '📁')}"></label>
    <label class="field"><span>분류 이름</span><input type="text" name="name" required maxlength="60" value="${esc(cat?.name || '')}"></label></div>
    <label class="field"><span>순서 <small>(작을수록 위)</small></span><input type="text" name="sort" inputmode="numeric" value="${cat?.sort ?? ''}"></label>
    ${parentOpts}`, async (v) => {
    const row = { name: v.name.trim(), icon: v.icon.trim() || '📁', sort: parseInt(v.sort, 10) || 0 };
    if (parentOpts) row.parent_id = v.parent ? Number(v.parent) : null;
    if (!isEdit) row.parent_id = parentId;
    const r = isEdit ? await sb.from('lib_categories').update(row).eq('id', cat.id)
                     : await sb.from('lib_categories').insert(row).select('id').single();
    if (r.error) throw r.error;
    if (!isEdit) { st.libCat = r.data.id; if (parentId) libOpen.add(parentId); }
    toast('저장했습니다.'); render();
  });
}

async function libPageView(el, lib) {
  const [{ data: p, error }, { data: files }] = await Promise.all([
    sb.from('lib_pages').select('*').eq('id', st.libPage).maybeSingle(),
    sb.from('common_files').select('*').eq('page_id', st.libPage).order('id'),
  ]);
  if (error) throw error;
  if (!p) { st.libPage = null; return libHomeView(el, lib); }
  el.innerHTML = `${crumbs(lib, p.category_id, esc(p.title))}
    <article class="card lib-page">
      <div class="page-head"><div></div>
        ${isSuper() ? '<div class="lib-actions"><button class="btn small" id="editP">편집</button><button class="btn small danger" id="delP">삭제</button></div>' : ''}</div>
      <h1 class="page-title">${esc(p.title)}</h1>
      <div class="meta">${esc(p.author_name || '')} · 최종 수정 ${fmt(p.updated_at)}</div>
      ${p.body ? `<div class="md body-md">${md(p.body)}</div>` : ''}
      ${files?.length ? `<h4 class="att-title">첨부파일 ${files.length}</h4>${commonFilesHtml(files)}` : ''}
    </article>`;
  bindCrumbs(el); bindDownloads(el);
  if (isSuper()) {
    el.querySelector('#editP').onclick = () => { st.libEdit = { page: p.id, cat: p.category_id }; render(); };
    el.querySelector('#delP').onclick = async () => {
      if (!confirm('이 페이지와 첨부파일을 삭제할까요?')) return;
      await deleteCommonFiles('page_id', p.id);
      const { error: e } = await sb.from('lib_pages').delete().eq('id', p.id); if (e) return fail(e);
      st.libPage = null; st.libCat = p.category_id; toast('삭제했습니다.'); render();
    };
  }
}

async function libSearchView(el, lib) {
  const q = st.libQ;
  const [{ data: pages, error }, { data: fhits }] = await Promise.all([
    sb.from('lib_pages').select('id,category_id,title,icon,updated_at').or(`title.ilike.%${q}%,body.ilike.%${q}%`).limit(100),
    sb.from('common_files').select('file_name,page_id').not('page_id', 'is', null).ilike('file_name', `%${q}%`).limit(100),
  ]);
  if (error) throw error;
  const ids = new Set(pages.map((p) => p.id));
  const extra = (fhits || []).filter((f) => !ids.has(f.page_id)).map((f) => lib.pages.find((p) => p.id === f.page_id)).filter(Boolean);
  const all = [...pages, ...extra.filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i)];
  el.innerHTML = `<div class="lib-head"><h2>🔍 "${esc(q)}" 검색 결과 ${all.length}건</h2><p class="muted">페이지 제목·본문·첨부파일명에서 찾았습니다.</p></div>
    ${all.length ? pageCards(all, lib.cats) : '<div class="card empty">검색 결과가 없습니다.</div>'}`;
  bindPageCards(el);
}

async function viewLibEdit(main, lib) {
  const isNewP = st.libEdit.page === 'new';
  let p = { title: '', icon: '📄', body: '', sort: 0, featured: false, category_id: st.libEdit.cat }, files = [];
  if (!isNewP) {
    const r = await sb.from('lib_pages').select('*').eq('id', st.libEdit.page).single(); if (r.error) throw r.error; p = r.data;
    files = (await sb.from('common_files').select('*').eq('page_id', p.id).order('id')).data || [];
  }
  const catOpts = (pid, depth) => catChildren(lib.cats, pid).map((c) => `<option value="${c.id}" ${c.id === p.category_id ? 'selected' : ''}>${'　'.repeat(depth)}${esc(c.name)}</option>${catOpts(c.id, depth + 1)}`).join('');
  main.innerHTML = `<div class="bar"><button class="btn" id="back">← 취소</button><h2>${isNewP ? '새 페이지' : '페이지 편집'}</h2></div>
    <form class="card form-card wide" id="pf">
      <div class="row-icon"><label class="field"><span>아이콘</span><input type="text" name="icon" maxlength="4" value="${esc(p.icon)}"></label>
        <label class="field"><span>제목</span><input type="text" name="title" required maxlength="200" value="${esc(p.title)}"></label></div>
      <div class="row2"><label class="field"><span>분류</span><select name="category_id">${catOpts(null, 0)}</select></label>
        <label class="field"><span>순서 <small>(작을수록 위)</small></span><input type="text" name="sort" inputmode="numeric" value="${p.sort || ''}"></label></div>
      <label class="check"><input type="checkbox" name="featured" ${p.featured ? 'checked' : ''}> ⭐ 추천 자료 (홈 '꼭 보세요'와 분류 맨 위에 표시)</label>
      <div class="field"><span>본문</span>${mdEditor('body', p.body, 18)}</div>
      ${files.length ? `<div class="field"><span>기존 첨부파일</span>${commonFilesHtml(files, true)}</div>` : ''}
      <label class="field"><span>첨부파일 추가 <small>(여러 개 가능, 파일당 50MB 이하 · 같은 이름이면 새 파일로 교체)</small></span><input type="file" name="files" multiple></label>
      <p class="hint">자료실은 모든 승인된 대리점이 볼 수 있습니다.</p>
      <button class="btn primary" id="sub">${isNewP ? '등록' : '저장'}</button><span class="progress" id="prog"></span>
    </form>`;
  bindMdEditors(main); bindRemoveFiles(main);
  main.querySelector('#back').onclick = () => { st.libEdit = null; render(); };
  main.querySelector('#pf').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; const btn = main.querySelector('#sub'); btn.disabled = true;
    const newFiles = [...f.files.files];
    if (newFiles.some((x) => x.size > 50 * 1024 * 1024)) { btn.disabled = false; return toast('50MB를 넘는 파일이 있습니다.', true); }
    try {
      const row = { title: f.title.value.trim(), icon: f.icon.value.trim() || '📄', body: f.body.value,
                    category_id: Number(f.category_id.value), sort: parseInt(f.sort.value, 10) || 0, featured: f.featured.checked };
      let id = p.id;
      if (isNewP) {
        row.author_name = me.contact_name || me.email;
        const r = await sb.from('lib_pages').insert(row).select('id').single(); if (r.error) throw r.error; id = r.data.id;
      } else {
        const r = await sb.from('lib_pages').update(row).eq('id', id); if (r.error) throw r.error;
      }
      await removeSameName(files, newFiles);
      for (let i = 0; i < newFiles.length; i++) {
        main.querySelector('#prog').textContent = `파일 ${i + 1}/${newFiles.length} 올리는 중…`;
        await uploadCommon(newFiles[i], { page_id: id });
      }
      toast(isNewP ? '페이지를 등록했습니다.' : '저장했습니다.');
      Object.assign(st, { libEdit: null, libPage: id }); render();
    } catch (err) { fail(err); btn.disabled = false; }
  };
}

// =====================================================================
//  통합 검색
// =====================================================================
async function viewSearch(main) {
  const q = st.gq;
  const like = `title.ilike.%${q}%,body.ilike.%${q}%`;
  let n, p, b, fq; await Promise.all([
    sb.from('notices').select('id,title,created_at,pinned,pin_until').or(like).order('created_at', { ascending: false }).limit(30),
    sb.from('lib_pages').select('id,title,icon,updated_at,category_id').or(like).order('updated_at', { ascending: false }).limit(30),
    sb.from('posts').select('id,title,kind,agency_code,last_activity').or(like).order('last_activity', { ascending: false }).limit(50),
    sb.from('faqs').select('id,question,category').or(`question.ilike.%${q}%,answer.ilike.%${q}%`).limit(30),
  ]).then((r) => { [n, p, b, fq] = r; return r; }).catch((e) => { throw e; });
  for (const r of [n, p, b, fq]) if (r.error) throw r.error;
  const total = n.data.length + p.data.length + b.data.length + fq.data.length;
  const sec = (title, rows) => `<h3 class="section-title">${title} <span class="muted">${rows.length}</span></h3>
    <div class="card list">${rows.length ? rows.join('') : '<div class="empty small">결과 없음</div>'}</div>`;
  main.innerHTML = `<div class="bar"><h2>🔍 "${esc(q)}" 검색 결과 ${total}건</h2></div>
    ${sec('공지사항', n.data.map((x) => `<div class="item" data-sn="${x.id}"><span class="badge ${pinActive(x) ? 'notice' : 'gray'}">공지</span>
      <div class="t">${esc(x.title)}</div><div class="right">${fmt(x.created_at).slice(0, 10)}</div></div>`))}
    ${sec('FAQ', fq.data.map((x) => `<div class="item" data-sf="${x.id}"><span class="badge question">FAQ</span>
      <div><div class="t">${esc(x.question)}</div><div class="meta">${esc(x.category)}</div></div><div class="right"></div></div>`))}
    ${sec('자료실', p.data.map((x) => `<div class="item" data-sp="${x.id}"><span class="badge file">${esc(x.icon)} 자료</span>
      <div class="t">${esc(x.title)}</div><div class="right">${fmt(x.updated_at).slice(0, 10)}</div></div>`))}
    ${sec(isAdmin() ? '대리점 게시판' : '1:1 문의', b.data.map((x) => `<div class="item" data-sb="${x.id}" data-ag="${esc(x.agency_code)}"><span class="badge ${x.kind}">${KIND[x.kind]}</span>
      <div><div class="t">${esc(x.title)}</div>${isAdmin() ? `<div class="meta">${esc(x.agency_code)} · ${esc(agencyName(x.agency_code))}</div>` : ''}</div>
      <div class="right">${fmt(x.last_activity).slice(0, 10)}</div></div>`))}`;
  main.querySelectorAll('[data-sf]').forEach((el) => el.onclick = () => { resetView(); Object.assign(st, { tab: 'faq', faqOpen: Number(el.dataset.sf), faqCat: '전체', faqQ: '' }); render(); });
  main.querySelectorAll('[data-sn]').forEach((el) => el.onclick = () => { resetView(); Object.assign(st, { tab: 'notices', noticeId: Number(el.dataset.sn) }); render(); });
  main.querySelectorAll('[data-sp]').forEach((el) => el.onclick = () => { resetView(); Object.assign(st, { tab: 'library', libPage: Number(el.dataset.sp), libQ: '' }); render(); });
  main.querySelectorAll('[data-sb]').forEach((el) => el.onclick = () => { resetView(); Object.assign(st, { tab: 'board', postId: Number(el.dataset.sb), agency: el.dataset.ag }); render(); });
}


// =====================================================================
//  홈 (로그인 첫 화면): 중요 공지 · 최근 공지 · 새 자료 · 자료실 바로가기
// =====================================================================
const plain = (mdText, n = 90) => (mdText || '').split('\n').filter((l) => !l.trim().startsWith('|')).join(' ').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[#>*_`|~-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const daysAgo = (d) => (Date.now() - new Date(d).getTime()) / 864e5;
function ago(d) {
  const m = (Date.now() - new Date(d).getTime()) / 6e4;
  if (m < 60) return `${Math.max(1, Math.round(m))}분 전`;
  if (m < 1440) return `${Math.round(m / 60)}시간 전`;
  if (m < 1440 * 7) return `${Math.round(m / 1440)}일 전`;
  return fmt(d).slice(0, 10);
}

// ---------- 정책 요약 (홈 화면 · 로그인 팝업) ----------
let policyCache;
async function loadPolicy() {
  if (policyCache !== undefined) return policyCache;
  try {
    const { data, error } = await sb.storage.from(BUCKET).download('common/policy-summary.json');
    policyCache = error ? null : JSON.parse(await data.text());
  } catch { policyCache = null; }
  return policyCache;
}
const won = (m) => `${Math.round(m).toLocaleString('ko-KR')}만원`;
function policyCardsHtml(P, compact = false) {
  return `<div class="pol-cards ${compact ? 'compact' : ''}">${P.cards.map((c, i) => `<article class="pol-card t-${esc(c.tone || 'gray')}" ${c.page ? `data-polpage="${esc(c.page)}"` : ''}>
    <div class="pol-top"><span class="pol-tag">${esc(c.tag)}</span>${c.until ? `<span class="pol-until">${esc(c.until)}</span>` : ''}</div>
    <div class="pol-unit">${esc(c.unit)}</div><div class="pol-big">${esc(c.big)}</div>
    ${compact ? '' : `<ul>${c.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`}
    ${c.page ? '<span class="pol-more">자세히 ›</span>' : ''}</article>`).join('')}</div>`;
}
function policyCalc(P, n, m) {
  const C = P.calc.connect, Q = P.calc.qr, rows = [];
  if (n > 0) {
    rows.push([`Npay connect 대리점 수령액 (${n}대 × ${C.per}만)`, n * C.per]);
    rows.push([`H/W 설치수수료 (${n}대 × ${C.hw}만)`, n * C.hw]);
    for (const [every, amt] of C.cum) { const k = Math.floor(n / every); if (k) rows.push([`누적 설치 인센티브 (${every.toLocaleString()}대당 ${won(amt)} × ${k})`, k * amt]); }
    for (const [at, amt] of C.milestones) if (n >= at) rows.push([`누적 ${at.toLocaleString()}대 달성`, amt]);
  }
  if (m > 0) {
    rows.push([`이지QR 설치 (${m}곳 × ${Q.per}만)`, m * Q.per]);
    const tier = [...Q.tiers].reverse().find(([at]) => m >= at);
    if (tier) rows.push([`이지QR 우수 대리점 (${tier[0]}곳 이상)`, tier[1]]);
  }
  return rows;
}
function policyHtml(P) {
  return `<div class="pol">
    <p class="pol-head"><span class="pol-period">${esc(P.period)}</span> ${esc(P.headline)}</p>
    ${policyCardsHtml(P)}
    <section class="pol-calc"><h4>💰 우리 대리점 예상 수익 계산</h4>
      <div class="pol-in"><label>Npay connect 설치 <input type="number" min="0" step="1" value="10" id="pcN"> 대</label>
        <label>네이버 이지QR 설치 <input type="number" min="0" step="1" value="50" id="pcM"> 곳</label></div>
      <div id="pcOut"></div></section>
    <ul class="pol-notes">${(P.notes || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`;
}
function bindPolicy(root, P) {
  const out = root.querySelector('#pcOut');
  const upd = () => {
    const n = Math.max(0, Math.floor(Number(root.querySelector('#pcN')?.value) || 0)), m = Math.max(0, Math.floor(Number(root.querySelector('#pcM')?.value) || 0));
    const rows = policyCalc(P, n, m), sum = rows.reduce((a, r) => a + r[1], 0);
    if (out) out.innerHTML = rows.length ? `<table class="pol-tbl">${rows.map(([l, v]) => `<tr><td>${esc(l)}</td><td>${won(v)}</td></tr>`).join('')}
      <tr class="sum"><td>예상 합계 (VAT 별도)</td><td>${won(sum)}</td></tr></table>` : '<div class="muted">설치 수량을 넣어 보세요.</div>';
  };
  root.querySelectorAll('#pcN, #pcM').forEach((i) => i.oninput = upd); upd();
  root.querySelectorAll('[data-polpage]').forEach((el) => el.onclick = async () => {
    const { data } = await sb.from('lib_pages').select('id').eq('title', el.dataset.polpage).limit(1).maybeSingle();
    document.querySelectorAll('.modal-bg').forEach((x) => x.remove());
    resetView(); Object.assign(st, { tab: 'library', libPage: data?.id || null, libCat: null }); window.scrollTo(0, 0); render();
  });
}
function showPolicy(P) {
  try { localStorage.setItem('policy_seen_' + P.version, '1'); } catch { /* 저장 불가 환경 */ }
  modal(`📣 ${P.title}`, `<div id="polBox">${policyHtml(P)}</div>`, async () => {}, '확인했어요', true);
  const box = document.querySelector('#polBox'); if (box) bindPolicy(box, P);
}
function policySeen(P) { try { return !!localStorage.getItem('policy_seen_' + P.version); } catch { return true; } }

async function viewHome(main, { pendingCnt }) {
  const admin = isAdmin();
  const [pins, recent, pages, cats, mine] = await Promise.all([
    sb.from('notices').select('id,title,body,created_at,pinned,pin_until').eq('pinned', true).order('created_at', { ascending: false }).limit(10),
    sb.from('notices').select('id,title,pinned,pin_until,created_at').order('created_at', { ascending: false }).limit(6),
    sb.from('lib_pages').select('id,title,icon,category_id,created_at,updated_at').order('updated_at', { ascending: false }).limit(8),
    sb.from('lib_categories').select('id,name,icon,parent_id,sort').order('sort').order('id'),
    admin
      ? sb.from('posts').select('id,comments(author_role,created_at)').eq('kind', 'question').order('last_activity', { ascending: false }).limit(200)
      : sb.from('posts').select('id,title,kind,last_activity').eq('agency_code', me.agency_code).order('last_activity', { ascending: false }).limit(4),
  ]);
  for (const r of [pins, recent, pages, cats, mine]) if (r.error) throw r.error;
  pins.data = pins.data.filter(pinActive).slice(0, 3);
  let ownerPending = 0;
  if (isOwner()) { const { data: mm } = await sb.rpc('my_members'); ownerPending = (mm || []).filter((m) => m.status === 'pending').length; }
  const { data: topFaq } = await sb.from('faqs').select('id,question,category').order('featured', { ascending: false }).order('views', { ascending: false }).limit(5);
  const { data: feat } = await sb.from('lib_pages').select('id,title,icon,category_id,updated_at').eq('featured', true).order('sort').order('updated_at', { ascending: false }).limit(6);
  const catName = (id) => { const c = cats.data.find((x) => x.id === id); return c ? `${c.icon} ${c.name}` : ''; };
  const tops = cats.data.filter((c) => !c.parent_id);
  const P = await loadPolicy();
  const now = new Date(); const wd = '일월화수목금토'[now.getDay()];
  const who = admin ? `${esc(me.contact_name || '본사')}님` : `${esc(agencyName(me.agency_code))} ${esc(me.contact_name || '')}님`;

  let side = '';
  if (admin) {
    const waiting = mine.data.filter((p) => { const c = (p.comments || []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at)).pop(); return !c || c.author_role !== 'admin'; }).length;
    side = `<div class="h-stats">
      <button class="h-stat" data-go="inbox"><b>${waiting}</b><span>답변 필요 문의</span></button>
      <button class="h-stat" data-go="users"><b>${pendingCnt}</b><span>가입 승인 대기</span></button>
      <button class="h-stat" data-go="${isSuper() ? 'agencies' : 'board'}"><b>${agencies.length}</b><span>${isSuper() ? '등록 대리점' : '담당 대리점'}</span></button></div>`;
  } else {
    const reads = await readMap(mine.data.map((p) => p.id));
    const unread = mine.data.filter((p) => !reads.mine[p.id] || new Date(reads.mine[p.id]) < new Date(p.last_activity));
    side = `<div class="card h-box"><div class="h-box-head"><h3>💬 1:1 문의</h3><button class="link" data-go="board">전체 보기 ›</button></div>
      ${mine.data.length ? mine.data.map((p) => `<div class="h-row" data-post="${p.id}"><span class="badge ${p.kind}">${KIND[p.kind]}</span>
        <span class="h-t">${unread.includes(p) ? '<span class="dot"></span>' : ''}${esc(p.title)}</span><span class="h-d">${ago(p.last_activity)}</span></div>`).join('')
        : '<div class="h-empty">담당자와 주고받은 글이 여기에 표시됩니다.</div>'}
      <button class="btn block-sm" data-ask style="margin-top:10px">✏️ 담당자에게 문의하기</button></div>`;
  }

  main.innerHTML = `
    <section class="h-hero"><div><div class="h-date">${now.getMonth() + 1}월 ${now.getDate()}일 (${wd})</div>
      <h2>안녕하세요, ${who}</h2><p>${admin ? '오늘 대리점에 전할 소식과 자료를 확인하세요.' : '새 소식과 자료를 한눈에 확인하세요.'}</p></div>
      ${isSuper() ? '<div class="h-hero-btns"><button class="btn primary" data-new="notice">＋ 공지 작성</button><button class="btn" data-new="page">＋ 자료 등록</button></div>' : ''}
    </section>

    ${P ? `<section class="h-sec h-policy"><div class="h-box-head"><h3>📣 ${esc(P.title)} <small class="muted">${esc(P.period)}</small></h3>
      <button class="link" data-polopen>💰 수익 계산해 보기 ›</button></div>${policyCardsHtml(P, true)}</section>` : ''}

    ${isOwner() && ownerPending ? `<button class="h-alert" data-go="myagency"><span class="t">👥 직원 가입 신청 <b>${ownerPending}건</b>이 승인을 기다리고 있습니다</span><span class="go">확인하기 ›</span></button>` : ''}
    ${pins.data.length ? `<section class="h-pins">${pins.data.map((n) => `<article class="h-pin" data-notice="${n.id}">
      <span class="h-pin-tag">📌 중요 공지</span><h3>${esc(n.title)}${isNew(n.created_at) ? ' <span class="new">N</span>' : ''}</h3>
      <p>${esc(plain(n.body, 110)) || '&nbsp;'}</p><span class="h-pin-more">자세히 보기 ›</span></article>`).join('')}</section>` : ''}

    <div class="h-grid">
      <div class="card h-box"><div class="h-box-head"><h3>📢 최근 공지</h3><button class="link" data-go="notices">전체 보기 ›</button></div>
        ${recent.data.length ? recent.data.map((n) => `<div class="h-row" data-notice="${n.id}">
          ${pinActive(n) ? '<span class="badge notice">중요</span>' : '<span class="badge gray">공지</span>'}
          <span class="h-t">${esc(n.title)}${isNew(n.created_at) ? ' <span class="new">N</span>' : ''}</span><span class="h-d">${ago(n.created_at)}</span></div>`).join('')
          : '<div class="h-empty">등록된 공지가 없습니다.</div>'}</div>
      ${admin ? `<div>${side}</div>` : side}
    </div>

    ${feat?.length ? `<section class="h-sec"><div class="h-box-head"><h3>⭐ 꼭 보세요</h3><button class="link" data-go="library">자료실 ›</button></div>
      <div class="pcards">${feat.map((p) => `<div class="pcard feat" data-page="${p.id}">
        <div class="pc-t">${esc(p.title)}</div><div class="pc-m">${esc(catName(p.category_id))}</div></div>`).join('')}</div></section>` : ''}

    ${topFaq?.length ? `<section class="h-sec"><div class="h-box-head"><h3>❓ 자주 묻는 질문</h3><button class="link" data-go="faq">FAQ 전체 ›</button></div>
      <div class="card h-faq">${topFaq.map((f) => `<button class="h-faq-q" data-faq="${f.id}"><span class="qmark sm">Q</span><span>${esc(f.question)}</span><span class="h-faq-c">${esc(f.category)}</span></button>`).join('')}</div></section>` : ''}

    <section class="h-sec"><div class="h-box-head"><h3>🆕 새로 올라온 자료</h3><button class="link" data-go="library">자료실 ›</button></div>
      ${pages.data.length ? `<div class="pcards">${pages.data.map((p) => {
        const fresh = daysAgo(p.created_at) < 7, upd = !fresh && daysAgo(p.updated_at) < 7;
        return `<div class="pcard" data-page="${p.id}">
          <div class="pc-t">${esc(p.title)}${fresh ? ' <span class="new">NEW</span>' : upd ? ' <span class="new upd">UP</span>' : ''}</div>
          <div class="pc-m">${esc(catName(p.category_id))} · ${ago(p.updated_at)}</div></div>`; }).join('')}</div>`
        : '<div class="card h-empty">아직 등록된 자료가 없습니다.</div>'}</section>

    <section class="h-sec"><div class="h-box-head"><h3>📚 자료실 바로가기</h3></div>
      <div class="h-cats">${tops.map((c, i) => `<button class="h-cat" data-cat="${c.id}">${numBadge(i + 1)}${esc(c.name)}</button>`).join('')}</div></section>`;

  const go = (patch) => { resetView(); Object.assign(st, { q: '', filter: 'all', libCat: null, libPage: null, libQ: '' }, patch); window.scrollTo(0, 0); render(); };
  main.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => go({ tab: b.dataset.go }));
  main.querySelectorAll('[data-notice]').forEach((b) => b.onclick = () => go({ tab: 'notices', noticeId: Number(b.dataset.notice) }));
  main.querySelectorAll('[data-faq]').forEach((b) => b.onclick = () => go({ tab: 'faq', faqOpen: Number(b.dataset.faq) }));
  main.querySelectorAll('[data-page]').forEach((b) => b.onclick = () => go({ tab: 'library', libPage: Number(b.dataset.page) }));
  main.querySelectorAll('[data-cat]').forEach((b) => b.onclick = () => go({ tab: 'library', libCat: Number(b.dataset.cat) }));
  main.querySelectorAll('[data-post]').forEach((b) => b.onclick = () => go({ tab: 'board', postId: Number(b.dataset.post) }));
  const ask = main.querySelector('[data-ask]'); if (ask) ask.onclick = () => go({ tab: 'board', compose: true });
  if (P) {
    bindPolicy(main.querySelector('.h-policy'), P);
    main.querySelector('[data-polopen]').onclick = () => showPolicy(P);
    if (!admin && !policySeen(P)) showPolicy(P);   // 대리점: 새 정책은 로그인 후 첫 화면에서 한 번 보여줌
  }
  main.querySelectorAll('[data-new]').forEach((b) => b.onclick = () => {
    if (b.dataset.new === 'notice') return go({ tab: 'notices', noticeEdit: 'new' });
    const first = tops[0]; if (!first) return go({ tab: 'library' });
    go({ tab: 'library', libEdit: { page: 'new', cat: first.id } });
  });
}


// =====================================================================
//  FAQ (자주 묻는 질문) — 고객센터형: 검색 · 분류 탭 · 펼침 목록 · 문의 유도
// =====================================================================
const FAQ_CATS = ['가맹점 등록·변경', '단말기·설치', '코드 이관', 'EasyPOS·서비스', '포털 이용', '기타'];
const faqViewed = new Set();
const hl = (text, q) => {
  const t = esc(text); if (!q) return t;
  const words = q.split(/\s+/).filter((w) => w.length > 0).map((w) => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return words.length ? t.replace(new RegExp(`(${words.join('|')})`, 'gi'), '<mark>$1</mark>') : t;
};
const faqMatch = (f, q) => !q || q.split(/\s+/).filter(Boolean).every((w) => (f.question + ' ' + f.answer + ' ' + f.category).toLowerCase().includes(w.toLowerCase()));

async function loadFaqs() {
  const { data, error } = await sb.from('faqs').select('*').order('featured', { ascending: false }).order('sort').order('id');
  if (error) throw error; return data;
}

async function viewFaq(main) {
  const all = await loadFaqs();
  const cats = [...new Set([...FAQ_CATS, ...all.map((f) => f.category)])].filter((c) => c === '기타' || all.some((f) => f.category === c) || isAdmin());
  const q = st.faqQ;
  const list = all.filter((f) => (st.faqCat === '전체' || f.category === st.faqCat) && faqMatch(f, q));
  const popular = [...all].sort((a, b) => (b.featured - a.featured) || (b.views - a.views)).slice(0, 4);
  const count = (c) => all.filter((f) => (c === '전체' || f.category === c) && faqMatch(f, q)).length;

  main.innerHTML = `
    <section class="faq-hero">
      <h2>무엇을 도와드릴까요?</h2>
      <p>자주 묻는 질문에서 먼저 찾아보세요. 해결되지 않으면 1:1 문의를 남겨 주세요.</p>
      <form class="faq-search" id="fs"><input type="search" name="q" value="${esc(q)}" placeholder="궁금한 내용을 입력하세요 (예: 코드 이관, 단말기 교체)" autocomplete="off">
        <button class="btn primary">검색</button></form>
      ${popular.length && !q ? `<div class="faq-pop"><span>많이 찾는 질문</span>${popular.map((f) => `<button type="button" data-pop="${f.id}">${esc(f.question)}</button>`).join('')}</div>` : ''}
    </section>

    <div class="faq-bar">
      <div class="faq-tabs" role="tablist">${['전체', ...cats].map((c) => `<button role="tab" aria-selected="${st.faqCat === c}" class="${st.faqCat === c ? 'on' : ''}" data-fc="${esc(c)}">${esc(c)}<em>${count(c)}</em></button>`).join('')}</div>
      ${isSuper() ? '<button class="btn primary small" id="addFaq">＋ FAQ 추가</button>' : ''}
    </div>

    ${q ? `<p class="faq-result">"<b>${esc(q)}</b>" 검색 결과 ${list.length}건 <button class="link" id="clearQ">검색 지우기</button></p>` : ''}

    <div class="faq-list">${list.length ? list.map((f) => `
      <div class="faq-item ${st.faqOpen === f.id ? 'open' : ''}" data-fid="${f.id}">
        <button type="button" class="faq-q" aria-expanded="${st.faqOpen === f.id}">
          <span class="qmark">Q</span>
          <span class="faq-qt"><span class="faq-cat">${esc(f.category)}</span>${f.featured ? '<span class="faq-star">⭐</span>' : ''}${hl(f.question, q)}</span>
          <span class="chev" aria-hidden="true"></span>
        </button>
        <div class="faq-a">${st.faqOpen === f.id ? faqAnswerHtml(f, q) : ''}</div>
      </div>`).join('')
      : `<div class="faq-empty">${all.length ? '찾는 질문이 없습니다. 다른 단어로 검색하거나 1:1 문의를 남겨 주세요.' : (isAdmin() ? '아직 FAQ가 없습니다. ＋ FAQ 추가로 첫 질문을 등록하세요.' : '아직 등록된 FAQ가 없습니다.')}</div>`}</div>

    ${!isAdmin() ? `<div class="faq-cta"><div><b>원하는 답을 찾지 못하셨나요?</b><span>담당자가 직접 확인하고 답변드립니다.</span></div>
      <button class="btn primary" id="ask">1:1 문의하기</button></div>` : ''}`;

  main.querySelector('#fs').onsubmit = (e) => { e.preventDefault(); st.faqQ = cleanQ(e.target.q.value); st.faqOpen = null; render(); };
  const cq = main.querySelector('#clearQ'); if (cq) cq.onclick = () => { st.faqQ = ''; render(); };
  main.querySelectorAll('[data-fc]').forEach((b) => b.onclick = () => { st.faqCat = b.dataset.fc; st.faqOpen = null; render(); });
  main.querySelectorAll('[data-pop]').forEach((b) => b.onclick = () => { openFaq(main, Number(b.dataset.pop), all, true); });
  main.querySelectorAll('.faq-q').forEach((b) => b.onclick = () => openFaq(main, Number(b.closest('.faq-item').dataset.fid), all));
  const ask = main.querySelector('#ask'); if (ask) ask.onclick = () => { resetView(); Object.assign(st, { tab: 'board', compose: true }); render(); };
  const add = main.querySelector('#addFaq'); if (add) add.onclick = () => faqDialog({ category: st.faqCat !== '전체' ? st.faqCat : '' });
  bindFaqAdmin(main, all);
  if (st.faqOpen) { const el = main.querySelector(`[data-fid="${st.faqOpen}"]`); if (el) { el.scrollIntoView({ block: 'center' }); countView(st.faqOpen); } }
}

function faqAnswerHtml(f, q) {
  return `<div class="faq-a-in"><span class="amark">A</span><div class="faq-body">
    <div class="md">${md(f.answer) || '<p class="muted">답변 준비 중입니다.</p>'}</div>
    <div class="faq-meta">최종 수정 ${fmt(f.updated_at).slice(0, 10)}${isSuper() ? ` · 조회 ${f.views}
      <span class="faq-admin"><button type="button" class="link" data-fedit="${f.id}">편집</button><button type="button" class="link danger" data-fdel="${f.id}">삭제</button></span>` : ''}</div>
  </div></div>`;
}
function countView(id) { if (faqViewed.has(id) || isAdmin()) return; faqViewed.add(id); sb.rpc('faq_view', { fid: id }).then(() => {}, () => {}); }

function openFaq(main, id, all, fromPop = false) {
  const item = main.querySelector(`[data-fid="${id}"]`);
  if (!item) { st.faqCat = '전체'; st.faqQ = ''; st.faqOpen = id; return render(); }
  const opening = !item.classList.contains('open');
  main.querySelectorAll('.faq-item.open').forEach((x) => { x.classList.remove('open'); x.querySelector('.faq-q').setAttribute('aria-expanded', 'false'); });
  st.faqOpen = opening ? id : null;
  if (opening) {
    const f = all.find((x) => x.id === id);
    item.querySelector('.faq-a').innerHTML = faqAnswerHtml(f, st.faqQ);
    item.classList.add('open'); item.querySelector('.faq-q').setAttribute('aria-expanded', 'true');
    bindFaqAdmin(item, all); countView(id);
    if (fromPop) item.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function bindFaqAdmin(root, all) {
  root.querySelectorAll('[data-fedit]').forEach((b) => b.onclick = () => faqDialog(all.find((f) => f.id === Number(b.dataset.fedit))));
  root.querySelectorAll('[data-fdel]').forEach((b) => b.onclick = async () => {
    if (!confirm('이 FAQ를 삭제할까요?')) return;
    const { error } = await sb.from('faqs').delete().eq('id', b.dataset.fdel); if (error) return fail(error);
    st.faqOpen = null; toast('삭제했습니다.'); render();
  });
}

function faqDialog(f = {}, fromPost = false) {
  const isEdit = !!f.id;
  const w = modal(isEdit ? 'FAQ 편집' : (fromPost ? '문의를 FAQ로 등록' : 'FAQ 추가'), `
    ${fromPost ? '<p class="hint">대리점 이름 없이 질문과 답변만 FAQ에 공개됩니다. 다듬어서 등록하세요.</p>' : ''}
    <div class="row2"><label class="field"><span>분류</span><input type="text" name="category" list="faqcats" required value="${esc(f.category || '')}" placeholder="분류 선택 또는 입력">
      <datalist id="faqcats">${FAQ_CATS.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <label class="field"><span>순서 <small>(작을수록 위)</small></span><input type="text" name="sort" inputmode="numeric" value="${f.sort ?? ''}"></label></div>
    <label class="field"><span>질문</span><input type="text" name="question" required maxlength="200" value="${esc(f.question || '')}"></label>
    <div class="field"><span>답변</span>${mdEditor('answer', f.answer || '', 9)}</div>
    <label class="check"><input type="checkbox" name="featured" ${f.featured ? 'checked' : ''}> ⭐ 많이 찾는 질문으로 고정 (FAQ·홈 상단)</label>`,
  async (v, form) => {
    const row = { category: v.category.trim() || '기타', question: v.question.trim(), answer: form.answer.value,
                  sort: parseInt(v.sort, 10) || 0, featured: form.featured.checked };
    let r;
    if (isEdit) r = await sb.from('faqs').update(row).eq('id', f.id);
    else { row.author_name = me.contact_name || me.email; r = await sb.from('faqs').insert(row).select('id').single(); }
    if (r.error) throw r.error;
    toast(isEdit ? '저장했습니다.' : 'FAQ를 등록했습니다.');
    if (fromPost) { resetView(); Object.assign(st, { tab: 'faq', faqCat: '전체', faqQ: '', faqOpen: r.data.id }); }
    else st.faqOpen = isEdit ? f.id : r.data.id;
    render();
  }, isEdit ? '저장' : '등록', true);
  bindMdEditors(w);
}

// 1:1 문의 작성 중 제목과 비슷한 FAQ 먼저 보여주기
function bindFaqSuggest(root) {
  const box = root.querySelector('#fsug'), input = root.querySelector('input[name=title]');
  if (!box || !input) return;
  let faqs = null, timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const words = input.value.trim().split(/\s+/).filter((w) => w.length >= 2);
      if (!words.length) { box.hidden = true; return; }
      if (!faqs) faqs = (await sb.from('faqs').select('id,question,category')).data || [];
      const scored = faqs.map((f) => ({ f, s: words.filter((w) => f.question.includes(w)).length })).filter((x) => x.s).sort((a, b) => b.s - a.s).slice(0, 3);
      if (!scored.length) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = `<b>💡 먼저 확인해 보세요</b>${scored.map(({ f }) => `<button type="button" data-sf="${f.id}"><span class="qmark sm">Q</span>${esc(f.question)}</button>`).join('')}`;
      box.querySelectorAll('[data-sf]').forEach((b) => b.onclick = () => {
        if (!confirm('작성 중인 문의는 저장되지 않습니다. FAQ로 이동할까요?')) return;
        resetView(); Object.assign(st, { tab: 'faq', faqCat: '전체', faqQ: '', faqOpen: Number(b.dataset.sf) }); render();
      });
    }, 300);
  });
}


// =====================================================================
//  우리 대리점 (대표자 전용): 대리점 정보 · 직원 가입 승인 · 이용 중지
// =====================================================================
async function viewMyAgency(main) {
  const { data: members, error } = await sb.rpc('my_members'); if (error) throw error;
  const code = me.agency_code, name = agencyName(code);
  const pending = members.filter((m) => m.status === 'pending');
  const active = members.filter((m) => m.status === 'approved');
  const stopped = members.filter((m) => m.status === 'rejected');
  const invite = `[${cfg.SITE_TITLE}] ${name} 직원 가입 안내\n\n1. 사이트 접속: ${location.origin}\n2. [가입 신청] → 구분 '직원' 선택\n3. 대리점 코드 ${code} 입력\n4. 가입 후 대표자 승인이 나면 이용할 수 있습니다.`;
  const row = (m, actions) => `<tr data-m="${m.id}"><td><b>${esc(m.contact_name || '-')}</b>${m.is_me ? ' <span class="role-chip owner">나</span>' : ''}
      <div class="sub">${esc(m.email)}${m.phone ? ' · ' + esc(m.phone) : ''}</div></td>
    <td><span class="role-chip ${m.status === 'pending' ? (m.requested_role || 'staff') : m.agency_role}">${ROLE_LABEL[m.status === 'pending' ? (m.requested_role || 'staff') : m.agency_role]}${m.status === 'pending' ? ' 신청' : ''}</span></td>
    <td class="sub">${fmt(m.created_at).slice(0, 10)}</td><td style="text-align:right;white-space:nowrap">${actions}</td></tr>`;

  main.innerHTML = `
    <div class="bar"><h2>🏢 우리 대리점</h2></div>
    <section class="ma-head card">
      <div><div class="ma-name">${esc(name)}</div><div class="ma-code">대리점 코드 <b>${esc(code)}</b></div></div>
      <div class="ma-stats"><div><b>${active.length}</b><span>이용 중</span></div><div><b>${pending.length}</b><span>승인 대기</span></div></div>
    </section>

    <section class="h-sec">
      <div class="h-box-head"><h3>직원 초대</h3></div>
      <div class="card ma-invite"><p>직원이 사이트에서 <b>가입 신청 → 구분 '직원' → 대리점 코드 ${esc(code)}</b>를 입력하면 아래 '승인 대기'에 나타납니다.</p>
        <button class="btn" id="copyInv">📋 직원 가입 안내 문구 복사</button></div>
    </section>

    <section class="h-sec"><div class="h-box-head"><h3>승인 대기 ${pending.length ? `<span class="cnt-inline">${pending.length}</span>` : ''}</h3></div>
      <div class="card"><table class="tbl"><tbody>${pending.length ? pending.map((m) => row(m,
        `<button class="btn small primary" data-oa="approve">승인</button> <button class="btn small danger" data-oa="reject">거절</button>`)).join('')
        : '<tr><td><div class="empty small">대기 중인 가입 신청이 없습니다.</div></td></tr>'}</tbody></table></div>
      ${pending.some((m) => m.requested_role === 'owner') ? '<p class="hint" style="margin-top:8px">대표자로 신청한 계정을 승인하면 직원으로 등록됩니다. 대표자 변경은 본사 담당자에게 요청하세요.</p>' : ''}
    </section>

    <section class="h-sec"><div class="h-box-head"><h3>구성원 ${active.length}</h3></div>
      <div class="card"><table class="tbl"><tbody>${active.map((m) => row(m,
        m.is_me || m.agency_role === 'owner' ? '' : `<button class="btn small danger" data-oa="suspend">이용 중지</button>`)).join('')}</tbody></table></div>
    </section>

    ${stopped.length ? `<section class="h-sec"><div class="h-box-head"><h3>중지·거절 ${stopped.length}</h3></div>
      <div class="card"><table class="tbl"><tbody>${stopped.map((m) => row(m, `<button class="btn small" data-oa="approve">다시 승인</button>`)).join('')}</tbody></table></div></section>` : ''}`;

  main.querySelector('#copyInv').onclick = async () => {
    try { await navigator.clipboard.writeText(invite); toast('안내 문구를 복사했습니다. 카톡 등에 붙여넣으세요.'); }
    catch { modal('직원 가입 안내 문구', `<textarea rows="8" style="width:100%">${esc(invite)}</textarea>`, async () => {}, '닫기'); }
  };
  main.querySelectorAll('[data-oa]').forEach((b) => b.onclick = async () => {
    const action = b.dataset.oa, id = b.closest('tr').dataset.m;
    if (action !== 'approve' && !confirm(action === 'reject' ? '이 가입 신청을 거절할까요?' : '이 직원의 이용을 중지할까요?')) return;
    b.disabled = true;
    const { error: e } = await sb.rpc('owner_manage', { target: id, action });
    if (e) { b.disabled = false; return fail(e); }
    toast(action === 'approve' ? '승인했습니다.' : '처리했습니다.'); render();
  });
}

// =====================================================================
//  대리점 개설 신청 (신규 대리점) / 개설 신청 검토·코드 발급 (본사)
// =====================================================================
const OB_STEPS = [['draft', '서류 작성'], ['submitted', '제출·본사 검토'], ['approved', '검토 완료'], ['issued', '코드 발급']];
const OB_LABEL = { draft: '작성 중', submitted: '검토 대기', revise: '보완 요청', approved: '검토 완료', issued: '코드 발급' };
const obStepIdx = (s) => ({ draft: 0, revise: 0, submitted: 1, approved: 2, issued: 3 }[s] ?? 0);
const MAIL_TO = cfg.MAIL_TO || '(04513) 서울특별시 중구 세종대로 39, 대한상공회의소 7층 한국정보통신㈜ 채널영업2팀';

// ---------- 기본 정보(개설 신청서) 입력 항목: 원본 신청서 순서 그대로 ----------
const OB_INFO = [
  { t: '1. 사업자 정보', f: [
    { k: 'corp_type', l: '사업자 구분', type: 'radio', opt: ['개인', '법인'], req: 1 },
    { k: 'own', l: '사무실', type: 'radio', opt: ['자가', '임차'], req: 1 },
    { k: 'agency', l: '상호(법인명)', req: 1 }, { k: 'bizno', l: '사업자등록번호', req: 1, ph: '000-00-00000' },
    { k: 'rep', l: '대표자', req: 1 }, { k: 'open_date', l: '개업연월일', ph: '예) 2020-03-01' },
    { k: 'addr', l: '사업장 주소', req: 1, wide: 1 }, { k: 'zip', l: '우편번호' }, { k: 'emp_cnt', l: '종업원 수(명)' },
    { k: 'tel', l: '대표번호', req: 1 }, { k: 'mobile', l: '휴대폰' }, { k: 'fax', l: 'FAX' }, { k: 'email', l: '이메일', req: 1 },
    { k: 'homepage', l: '홈페이지' }, { k: 'biz_type', l: '업태', req: 1 }, { k: 'biz_item', l: '종목', req: 1 }] },
  { t: '2. 영업 현황', hint: '취급 중인 솔루션과 VAN 실적을 적어 주세요. 없는 칸은 비워 두세요.', f: [
    { k: 'org_sales', l: '영업 인원(명)' }, { k: 'org_support', l: '지원 인원(명)' }, { k: 'org_dev', l: '개발 인원(명)' }, { k: 'org_ext', l: '외부영업(명)' }],
    rows: { k: 'sols', n: 5, l: '취급 솔루션', cols: [['cat', '구분 (포스·키오스크 등)'], ['name', '솔루션명'], ['mer', '주요 가맹점 · 규모']] },
    rows2: [{ k: 'vans', n: 3, l: '보유 실적 (VAN사별)', cols: [['name', 'VAN 사명'], ['cnt', '실적 건수(건)'], ['amt', '실적 금액(백만원)']] },
            { k: 'plans', n: 3, l: 'KICC 실적 계획', yearLabel: 1, cols: [['cnt', '실적 건수(건)'], ['amt', '실적 금액(백만원)']] }] },
  { t: '3. 사업 계획', f: [{ k: 'plan_text', l: '참여 동기, 영업 전략, 목표 가맹점 등', type: 'textarea', wide: 1 }] },
  { t: '4. 대표자 정보 (실제 대표자 기준)', f: [
    { k: 'cv_name', l: '성명' }, { k: 'cv_birth', l: '생년월일', type: 'date' }, { k: 'cv_addr', l: '주소', wide: 1 }],
    rows: { k: 'careers', n: 5, l: '주요 경력 (VAN 경력 위주, 없으면 현재 사업)', cols: [['ym', '기간 (예: 2019.03~2022.02)'], ['t', '경력 사항'], ['n', '비고']] } },
  { t: '5. 담보 제공 계획', f: [
    { k: 'col_type', l: '담보 종류', type: 'radio', opt: ['보증보험', '기타', '미정'] }, { k: 'col_note', l: '기타일 때 내용' },
    { k: 'col_amt', l: '담보 금액' }, { k: 'col_date', l: '설정 예정일', type: 'date' }] },
  { t: '보안서약서 대상 직원', hint: 'VAN 업무를 하는 직원 이름만 적어 주세요. 대표자를 포함해 1인 1부씩 개인 보안서약서가 출력됩니다. (신청서에는 들어가지 않습니다)', f: [],
    rows: { k: 'emps', n: 10, l: '직원 이름', cols: [['name', '이름']] } },
  { t: '연대보증인 (법인만)', hint: '법인 대리점만 대표자가 연대보증인이 됩니다. 대리점 계약서와 연대보증승락서에 들어갑니다. 개인사업자는 작성하지 않습니다.', guar: 1, f: [
    { k: 'g_name', l: '이름', req: 1, corp: 1 }, { k: 'g_birth', l: '생년월일', type: 'date', req: 1, corp: 1 }, { k: 'g_addr', l: '주소', req: 1, wide: 1, corp: 1 }] },
  { t: '거래대금 입금계좌·거래 담당자', f: [
    { k: 'bank', l: '은행명', req: 1 }, { k: 'branch', l: '지점명' }, { k: 'holder', l: '예금주', req: 1 }, { k: 'account', l: '계좌번호', req: 1 },
    { k: 'mgr_dept', l: '담당 부서' }, { k: 'mgr_name', l: '담당자' }, { k: 'mgr_tel', l: '담당자 전화' },
    { k: 'use_seal', l: '법인인감 외 사용인감을 따로 씁니다 (사용인감계 추가, 법인만)', type: 'check', wide: 1, corp: 1 }] },
  { t: '서류 작성일', hint: '비워 두면 날짜 칸이 빈칸으로 출력되어 날인할 때 손으로 적을 수 있습니다.', f: [{ k: 'doc_date', l: '신청서·계약서·서약서 작성일', type: 'date' }] },
];
const OB_REQ_F = OB_INFO.flatMap((s) => s.f.filter((f) => f.req));
const reqKeys = (d) => OB_REQ_F.filter((f) => !f.corp || d.corp_type === '법인').map((f) => f.k);

// 고지사항 7문항 (여신전문금융업법 제16조의3 제2항)
const OB_NOTICE = [
  '피한정후견인 또는 피성년후견인',
  '파산선고를 받고 복권되지 아니한 자',
  '여신전문금융업법에 따라 벌금 이상의 실형을 선고받고 그 집행이 끝나거나(집행이 끝난 것으로 보는 경우를 포함한다) 집행이 면제된 날부터 2년이 지나지 아니한 자',
  '여신전문금융업법에 따라 가맹점모집인의 등록이 취소된 후 2년이 지나지 아니한 자',
  '영업에 관하여 성년자와 같은 능력을 가지지 아니한 미성년자로서 그 법정대리인이 제1호부터 제4호까지의 어느 하나에 해당하는 자',
  '법인 또는 법인이 아닌 사단이나 재단으로서 그 임원이나 관리인 가운데 제1호부터 제4호까지의 어느 하나에 해당하는 자가 있는 자',
  '관할 세무서장에게 사업자등록을 아니한 자',
];

// 원본 우편 발송 목록 (기본 정보에 따라 자동 구성). s: 민감 서류 → 포털에 올리지 않음
function mailItems(d = {}) {
  const corp = d.corp_type === '법인';
  const staff = staffList(d).length || 1;
  const L = [
    ['g', '작성·날인 서류 (파트너센터에서 출력)'],
    ['apply', '대리점 개설 신청서', 1, '내용 확인 후 날인'],
    ['c_main', '대리점 계약서', corp ? 3 : 2, corp ? '계인·간인·직인, 연대보증인(대표자) 날인 / 본사 날인 후 대리점·연대보증인용 반송' : '계인·간인·직인 / 본사 날인 후 대리점용 반송'],
    ['c_fee', '가맹점관리수수료 및 DDC 지급수수료 관련 특약서', 2, '계인·간인·직인'],
    ['c_lease', '신용카드조회기 임대차 계약서', 2, '계인·간인·직인'],
    ['c_ddc', 'DDC 매출전표 투입업무 특약서', 2, '계인·간인·직인'],
    ['f_bank', '거래처 등록 및 거래대금 입금계좌(인감) 신고서', 1, '인감 날인, 통장 인감과 동일'],
    ['f_sec', '보안서약서 (대리점용)', 1, '대표자 날인'],
    ['f_secp', '보안서약서 (개인용)', staff, '대표자 포함 VAN 업무 임직원 각자 서명'],
    ...(corp ? [['f_guar', '연대보증승락서', 1, '연대보증인(대표자) 날인']] : []),
    ...(corp && d.use_seal ? [['f_seal', '사용인감계', 1, '사용인감 날인']] : []),
    ['notice', '가맹점모집인 등록신청인 고지사항', 1, '자필로 체크 후 서명·날인'],
    ['g', '발급·사본 서류'],
    ['biz_reg', '사업자등록증 사본', 2, ''],
    ['bankbook', '결제구좌 통장 사본', 1, ''],
    ...(d.own === '임차' ? [['lease', '사무실 임대차계약서 사본', 1, '']] : []),
    ['g', '개인정보 포함 서류 (우편으로만 제출)'],
    ['rep_reg', '대표자 주민등록표(등본)', 1, '', 1],
    ['rep_id', '대표자 신분증 사본', 1, '', 1],
    ['rep_seal', '대표자 인감증명서', 2, '', 1],
    ...(corp ? [['g_reg', '연대보증인(대표자) 주민등록등본', 1, '', 1], ['g_seal', '연대보증인(대표자) 인감증명서', 1, '', 1],
      ['g_tax', '연대보증인(대표자) 재산세 과세 증명서', 1, '', 1]] : []),
    ...(corp ? [['corp_seal', '법인 인감증명서', 3, '', 1], ['corp_reg', '법인 등기사항전부증명서', 1, '', 1], ['corp_aoi', '법인 정관 사본', 1, '', 1]] : []),
  ];
  return L.map(([k, t, n, note, s]) => (k === 'g' ? { group: t } : { k, t, n, note, s: !!s }));
}

async function loadOnboard(appId) {
  const [t, d, f] = await Promise.all([
    sb.from('onboard_doc_types').select('*').eq('active', true).order('sort'),
    sb.from('onboard_docs').select('*').eq('app_id', appId),
    sb.from('onboard_files').select('*').eq('app_id', appId).order('id'),
  ]);
  for (const r of [t, d, f]) if (r.error) throw r.error;
  return { types: t.data, docs: d.data, files: f.data };
}
const noticeYes = (n) => OB_NOTICE.map((_, i) => n?.[`q${i + 1}`] === '예');
// 서류별 완료 여부
function docState(type, docs, files, info = {}) {
  const doc = docs.find((x) => x.doc_key === type.key);
  const fl = files.filter((x) => x.doc_key === type.key);
  const d = doc?.data || {};
  let done, required = type.required;
  if (type.key === 'apply') done = reqKeys(d).every((k) => String(d[k] ?? '').trim());
  else if (type.key === 'notice') done = OB_NOTICE.every((_, i) => d[`q${i + 1}`]);
  else if (type.key === 'mail') done = !!d.sent;
  else if (type.kind === 'form') done = !!doc;
  else done = fl.length > 0;
  if (type.key === 'lease') required = info.own === '임차';
  const hq = doc?.status === 'ok' ? 'ok' : doc?.status === 'revise' ? 'revise' : null;
  return { doc, files: fl, done, hq, required };
}
function stepper(status) {
  const idx = obStepIdx(status);
  return `<ol class="ob-steps">${OB_STEPS.map(([k, l], i) => `<li class="${i < idx ? 'done' : i === idx ? 'cur' : ''}"><span>${i < idx ? '✓' : i + 1}</span>${l}${i === 0 && status === 'revise' ? ' <b class="ob-rev">보완</b>' : ''}</li>`).join('')}</ol>`;
}
function docChip(st2, editable) {
  if (st2.hq === 'ok') return '<span class="ob-chip ok">확인 완료</span>';
  if (st2.hq === 'revise') return '<span class="ob-chip rev">보완 필요</span>';
  return st2.done ? '<span class="ob-chip done">준비 완료</span>' : `<span class="ob-chip">${editable ? '미완료' : '미제출'}</span>`;
}

// ---------- 서류 PDF 자동 작성 (원본 양식 PDF 위에 값을 채움) ----------
let pdfLibs = null;
async function pdfKit() {
  if (!pdfLibs) {
    const [pl, fk, pf, df, font] = await Promise.all([import('https://esm.sh/pdf-lib@1.17.1'), import('https://esm.sh/@pdf-lib/fontkit@1.1.1'),
      import('./pdffill.js?v=7956aee'), import('./docfill.js?v=7956aee'), fetch('fonts/kr.ttf').then((r) => r.arrayBuffer())]);
    pdfLibs = { lib: { PDFDocument: pl.PDFDocument, rgb: pl.rgb, fontkit: fk.default }, ...pf, docData: df.docData, font };
  }
  return pdfLibs;
}
const tplCache = {};
async function tplFile(name, type) {
  if (!tplCache[name]) {
    const { data, error } = await sb.storage.from(BUCKET).download(`templates/${name}`);
    if (error) throw new Error('양식 파일을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
    tplCache[name] = type === 'json' ? JSON.parse(await data.text()) : await data.arrayBuffer();
  }
  return tplCache[name];
}
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
// which: apply(개설 신청서) | forms(계약서·신고서·서약서) | all(전체 + 고지사항 원본)
async function buildPdfBytes(which, info, app) {
  const K = await pdfKit();
  const sub = app.submitted_at ? new Date(app.submitted_at) : null;
  const data = K.docData(info, { appNo: app.id, recvDate: sub ? `${sub.getFullYear()}. ${sub.getMonth() + 1}. ${sub.getDate()}.` : undefined });
  const build = async (n, opt = {}) => K.buildPdf(K.lib, await tplFile(`${n}.pdf`), await tplFile(`${n}.json`, 'json'), K.font, data, '', opt);
  if (which === 'apply') return build('apply');
  if (which === 'forms') return build('forms', { bundle: true });
  if (which.startsWith('doc:')) {        // 서류 하나만 다시 받기 (부수 반영)
    const k = which.slice(4);
    if (k === 'apply_1') return build('apply');
    if (k === 'notice') return tplFile('notice.pdf');
    return build('forms', { bundle: true, only: [k] });
  }
  const out = await K.lib.PDFDocument.create();
  for (const src of [await build('apply'), await build('forms', { bundle: true }), await tplFile('notice.pdf')]) {
    const d = await K.lib.PDFDocument.load(src);
    (await out.copyPages(d, d.getPageIndices())).forEach((p) => out.addPage(p));
  }
  out.setTitle(`개설 서류 일체_${info.agency || ''}`);
  return out.save();
}
async function makePdf(which, info, app) {
  const nm = (info.agency || '대리점').replace(/[\\/:*?"<>|]/g, '');
  const bytes = await buildPdfBytes(which, info, app);
  const one = which.startsWith('doc:') ? sealSteps(info).find((x) => x.k === which.slice(4)) : null;
  const title = which === 'all' ? `개설 서류 인쇄용_${nm} (1부·단면 인쇄).pdf`
    : one ? `${one.t} ${one.n}부_${nm}.pdf` : `${which === 'apply' ? '대리점 개설 신청서' : '계약서·신고서·서약서 인쇄용'}_${nm}.pdf`;
  saveBlob(new Blob([bytes], { type: 'application/pdf' }), title);
}

// ---------- 날인 가이드 (PDF 내려받기 전) ----------
function sealSteps(info) {
  const corp = info.corp_type === '법인';
  const seal = corp ? '법인인감' : '대표자 인감';
  const staff = staffList(info);
  const L = [
    { k: 'apply_1', t: '대리점 개설 신청서', n: 1, s: [`2쪽 하단 <b>신청인 대표자 (인)</b>에 ${seal}`] },
    { k: 'c_main', t: '대리점 계약서', n: corp ? 3 : 2, s: [`첫 장 <b>계인</b>(${corp ? '3부' : '2부'}를 옆으로 맞대어 경계에 반씩)`, '모든 쪽 경계에 <b>간인</b>(앞 장을 접어 접힌 선에 반씩)', `마지막 쪽 <b>"대리점" 대표자 (인)</b>에 ${seal}`, ...(corp ? ['3부는 <b>본사·대리점·연대보증인 보관용</b>입니다. 3부 모두 날인'] : []),
      ...(corp ? ['같은 쪽 <b>"연대보증인" 이름 (인)</b>에 대표자 <b>개인 인감</b>'] : [])] },
    { k: 'c_fee', t: '가맹점관리수수료 및 DDC 지급수수료 관련 특약서', n: 2, s: ['첫 장 <b>계인</b>', '모든 쪽 사이 <b>간인</b>', `마지막 쪽 <b>"대리점" 대표자 (인)</b>에 ${seal}`] },
    { k: 'c_ddc', t: 'DDC 매출전표 투입업무 특약서', n: 2, s: ['첫 장 <b>계인</b>', '모든 쪽 사이 <b>간인</b>', `마지막 쪽 <b>"대리점" 대표자 (인)</b>에 ${seal}`] },
    { k: 'c_lease', t: '신용카드조회기 임대차 계약서', n: 2, s: ['첫 장 <b>계인</b>', '모든 쪽 사이 <b>간인</b>', `마지막 쪽 <b>"대리점" 대표자 (인)</b>에 ${seal}`] },
    { k: 'f_bank', t: '거래처 등록 및 입금계좌(인감) 신고서', n: 1, s: ['<b>&lt;신고인&gt;</b> 칸에 주소·상호·대표자를 <b>자필</b>로 기재',
      `<b>${corp ? '법인인감' : '대표자 인감'}</b> 칸에 ${seal}`, '<b>통장인감</b> 칸에 통장에 등록된 도장', ...(!corp ? [] : info.use_seal ? ['<b>사용인감</b> 칸에 사용인감'] : ['<b>사용인감</b> 칸: 사용인감이 <b>있으면</b> 사용인감도 날인 (없으면 비워 둠)'])] },
    { k: 'f_sec', t: '보안 서약서 (대리점용)', n: 1, s: [`마지막 쪽 <b>대표자 (인)</b>에 ${seal}`] },
    { k: 'f_secp', t: '개인정보보호(보안) 서약서 (개인용)', n: staff.length || 1, s: ['각 장 하단 <b>서약인 (인)</b>에 본인이 서명 또는 날인'] },
    ...(corp && info.use_seal ? [{ k: 'f_seal', t: '사용인감계', n: 1, s: ['<b>사용인감</b> 네모 칸에 앞으로 쓸 도장', '하단 <b>대표이사 (인)</b>에 법인인감'] }] : []),
    ...(corp ? [{ k: 'f_guar', t: '연대보증승락서', n: 1, s: ['하단 <b>연대보증인 이름 (인)</b>에 대표자 <b>개인 인감</b> (인감증명서와 같은 도장)'] }] : []),
    { k: 'notice', t: '가맹점모집인 등록신청인 고지사항', n: 1, s: ['7개 문항을 <b>자필</b>로 예/아니오에 ☑', '하단 <b>신청인 서명 및 날인</b>'] },
  ];
  return L;
}
async function sealGuide(info, app, which = 'all') {
  let pages = {};
  try {
    const K = await pdfKit();
    const data = K.docData(info, { appNo: app.id });
    const fl = await tplFile('forms.json', 'json');
    const off = which === 'all' ? 2 : 0;
    const r = K.docPages(fl, data, off, { bundle: true });
    pages = { ...r.pages, apply_1: { from: 1, to: 2 }, notice: { from: off + r.count + 1, to: off + r.count + 1 } };
  } catch (e) { /* 쪽 번호 없이 안내 */ }
  const corp = info.corp_type === '법인';
  const rows = sealSteps(info).filter((x) => which === 'all' || (which === 'apply' ? x.k === 'apply_1' : !['apply_1', 'notice'].includes(x.k)));
  const rg = (a) => (a.from === a.to ? `${a.from}쪽` : `${a.from}~${a.to}쪽`);
  const pg = (k) => { const p = pages[k]; if (!p || (which === 'apply' && k !== 'apply_1')) return ''; return p.copies && p.copies.length > 1 ? p.copies.map((c) => `${rg(c)}<br><small>${c.label}</small>`).join('<br>') : rg(p); };
  return `<div class="sg">
    <div class="sg-key"><div><b>${corp ? '법인인감' : '대표자 인감'}</b> 인감증명서와 같은 도장</div><div><b>간인</b> 겹친 두 쪽에 걸쳐 찍기</div><div><b>2부</b> 계약서는 2부 모두 각각 날인</div></div>
    <table class="tbl sg-tbl"><tr><th>서류</th><th>부수</th><th>쪽</th><th>날인·기재 방법</th></tr>
    ${rows.map((x) => `<tr><td><b>${esc(x.t)}</b></td><td class="c">${x.n}부</td><td class="c">${pg(x.k)}</td><td><ul>${x.s.map((t) => `<li>${t}</li>`).join('')}</ul></td></tr>`).join('')}</table>
    <p class="hint">${which === 'all' ? '쪽 번호는 [전체 서류 한 번에] PDF 기준입니다. 부수가 이미 들어 있으니 <b>1부·단면</b>으로 인쇄하세요.' : which === 'forms' ? '쪽 번호는 [계약서·신고서·서약서] PDF 기준입니다. <b>1부·단면</b>으로 인쇄하세요.' : ''}
      ${info.doc_date ? '' : ' 작성일을 비워 두어 날짜 칸이 빈칸입니다. 날인하는 날짜를 손으로 적어 주세요.'}
      ${info.use_seal && corp ? '' : ''} 날인한 원본은 [원본 서류 우편 발송] 목록과 함께 보내 주세요.</p></div>`;
}
function printGuide(html, info) {
  const w = window.open('', '_blank'); if (!w) return toast('팝업이 차단됐습니다. 브라우저에서 팝업을 허용해 주세요.', true);
  w.document.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>날인 가이드_${esc(info.agency || '')}</title><style>
    @page{size:A4;margin:14mm}body{font-family:'Malgun Gothic',sans-serif;font-size:11.5px;color:#000}h1{font-size:18px;text-align:center;margin:0 0 10px}
    table{width:100%;border-collapse:collapse}th,td{border:1px solid #000;padding:5px 7px;vertical-align:top}th{background:#eee}td.c{text-align:center;white-space:nowrap}
    ul{margin:0;padding-left:16px}.sg-key{display:flex;gap:14px;margin-bottom:8px;font-size:11px}.hint{font-size:11px;margin-top:8px}.tool{text-align:center;margin:8px}@media print{.tool{display:none}}</style></head>
    <body><div class="tool"><button onclick="print()">🖨 인쇄</button></div><h1>날인 가이드 — ${esc(info.agency || '')}</h1>${html}</body></html>`);
  w.document.close();
}
// 애니메이션 날인 가이드: 실제로 만들어질 PDF 쪽 위에 도장이 찍히는 모습을 단계별로 보여준다
async function guideSlides(info, app) {
  const K = await pdfKit();
  const data = K.docData(info, { appNo: app.id });
  const fl = await tplFile('forms.json', 'json'), al = await tplFile('apply.json', 'json');
  const plan = K.pagePlan(fl, data, { bundle: true });
  const nApply = al.pages.length, nForms = plan.length, notice = nApply + nForms + 1;
  const { pages } = K.docPages(fl, data, nApply, { bundle: true });
  pages.apply_1 = { from: 1, to: nApply };
  pages.notice = { from: notice, to: notice };
  const corp = info.corp_type === '법인';
  const keep = (st) => !(st.k === 'g_name' && !corp) && !(st.k === 'box_사용인감' && !corp);   // 개인사업자는 사용인감 없음
  const optSeal = (st) => (st.k === 'box_사용인감' && !(corp && info.use_seal) ? { ...st, opt: true } : st);
  const stampsOf = (n) => {
    if (n <= nApply) return (al.stamps || []).filter((st) => st.p === n - 1 && keep(st)).map(optSeal);
    if (n === notice) return [{ x: 508, y: 156, k: 'notice' }];
    const src = plan[n - nApply - 1]?.src;
    return (fl.stamps || []).filter((st) => st.p === src && keep(st)).map(optSeal);
  };
  const S = [];
  const cm = pages.c_main;
  if (cm) {
    S.push({ kind: 'gyein', how: true, t: '계인 찍는 방법', p: cm.copies[0].from, p2: (cm.copies[1] || cm.copies[0]).from, sub: `양사 계약서 4종 공통 · 보관용 ${corp ? '3부(대리점 계약서)' : '2부'}의 첫 장 경계에 반씩`,
      s: ['보관용 계약서 첫 장을 <b>옆으로 나란히 맞대어</b> 놓고, <b>두 부의 경계에 도장이 반씩 걸치도록</b> 찍습니다.',
        '위쪽은 본사 자리, <b>아래쪽이 대리점 자리</b>입니다.' + (corp ? ' 3부면 1·2부 경계, 2·3부 경계에 각각 찍습니다.' : ''),
        '대리점 계약서 · 특약서 2종 · 임대차 계약서 <b>4종 모두</b> 각각 합니다.'] });
    S.push({ kind: 'ganin', how: true, t: '간인 찍는 방법', p: cm.from + 1, sub: '각 계약서의 모든 쪽 사이',
      s: ['앞 장(예: 2쪽)의 <b>아래쪽을 위로 접어</b> 다음 장(3쪽)이 드러나게 하고, <b>접힌 선에 도장이 반씩 걸치도록</b> 찍습니다.',
        '왼쪽은 본사 자리, <b>오른쪽이 대리점 자리</b>입니다.', '첫 장을 뺀 <b>모든 장</b>(1-2쪽, 2-3쪽 … 마지막 쪽까지)에, 계약서 4종 · 2부 모두 합니다.'] });
  }
  for (const x of sealSteps(info)) {
    const pg = pages[x.k]; if (!pg) continue;
    const c0 = pg.copies?.[0];
    const p = x.k === 'f_secp' ? pg.from : (c0 ? c0.to : pg.to);
    const rg = (a) => (a.from === a.to ? `${a.from}` : `${a.from}~${a.to}`);
    const sub = pg.copies && pg.copies.length > 1 ? `${x.n}부 · ${pg.copies.map((c) => `${rg(c)}쪽(${c.label.replace(' 보관용', '')})`).join(', ')}` : `${x.n}부 · ${rg(pg)}쪽`;
    if (x.k.startsWith('c_') && c0) S.push({ kind: 'contract', t: x.t, p, from: c0.from, to: c0.to, sub, s: x.s, stamps: stampsOf(c0.to) });
    else S.push({ kind: 'page', t: x.t, p, sub, s: x.s, stamps: stampsOf(p) });
  }
  return S;
}
function guideThenDownload(info, app, which) {
  modal('출력 전 날인 가이드', `<div class="ag" id="ag"><div class="ag-load">서류 미리보기를 준비하고 있습니다…</div></div>`, async () => {
    await makePdf(which, info, app); toast('PDF를 내려받았습니다.');
  }, '확인했어요 · PDF 내려받기', true);
  const root = document.querySelector('#ag');
  (async () => {
    try {
      const [S, bytes, V] = await Promise.all([guideSlides(info, app), buildPdfBytes('all', info, app), import('./viewer.js?v=7956aee')]);
      const doc = await V.loadPdfBytes(bytes);
      const seal = info.corp_type === '법인' ? '법인인감' : '대표자 인감';
      root.innerHTML = `<div class="ag-key"><span><b>${seal}</b> 인감증명서와 같은 도장</span><span><b>계인</b> 2부 첫 장을 맞댄 경계에 반씩</span><span><b>간인</b> 쪽과 쪽 경계에 반씩</span></div>
        <div class="ag-body"><ol class="ag-list">${(() => { let d = 0, out = '', g = null;
          S.forEach((x, i) => {
            const grp = x.how ? 'how' : 'doc';
            if (grp !== g) { g = grp; out += `<li class="ag-grp">${grp === 'how' ? '먼저 보세요 · 날인 방법' : '서류별 날인 · 순서대로'}</li>`; }
            out += `<li data-i="${i}" class="${x.how ? 'how' : 'doc'}">${x.how ? '<em class="ag-tag">방법</em>' : `<em class="ag-no">${++d}</em>`}<b>${esc(x.t)}</b><small>${esc(x.sub)}</small></li>`;
          }); return out; })()}</ol>
        <div class="ag-main"><div class="ag-stage" id="agStage"></div><div class="ag-cap" id="agCap"></div>
        <div class="ag-nav"><button type="button" class="btn small" id="agPrev">← 이전</button><span id="agPos"></span><button type="button" class="btn small" id="agNext">다음 →</button></div>
        <div class="ag-nav2"><button type="button" class="btn small" id="agPrint">🖨 글로 된 가이드 인쇄</button></div></div></div>`;
      const W = Math.max(220, Math.min(330, (root.querySelector('.ag-main').clientWidth || 330) - 10));
      const pageCanvas = async (n, w) => { const c = document.createElement('canvas'); const sz = await V.renderPdfPage(doc, n, c, w); return { c, sz }; };
      let cur = 0, token = 0;
      const show = async (i) => {
        cur = (i + S.length) % S.length; const my = ++token;
        const x = S[cur], st = root.querySelector('#agStage');
        root.querySelectorAll('.ag-list li[data-i]').forEach((li) => li.classList.toggle('on', Number(li.dataset.i) === cur));
        root.querySelector('.ag-list li.on')?.scrollIntoView({ block: 'nearest' });
        root.querySelector('#agCap').innerHTML = `${x.how ? '<em class="ag-tag">방법</em> ' : ''}<b>${esc(x.t)}</b> <span class="muted">${esc(x.sub)}</span><ul>${x.s.map((t) => `<li>${t}</li>`).join('')}</ul>`;
        root.querySelector('#agPos').textContent = `${cur + 1} / ${S.length}`;
        const box = document.createElement('div'); box.className = 'ag-scene ag-' + x.kind;
        const mk = (cls, left, top) => { const s = document.createElement('div'); s.className = 'ag-stamp ' + cls; s.textContent = cls.includes('ghost') ? '본사' : '인'; s.style.left = left + 'px'; s.style.top = top + 'px'; return s; };
        if (x.kind === 'gyein') {
          // 2부의 첫 장을 옆으로 맞대고 → 경계선에 본사(위)·대리점(아래) 도장이 반씩 걸침
          const w = Math.round(Math.min(W * 0.62, 210)), h = Math.round(w * 1.414);
          for (const k of [0, 1]) {
            const { c } = await pageCanvas(k ? x.p2 : x.p, w); const pw = document.createElement('div'); pw.className = 'ag-page ag-side ag-side' + k;
            pw.style.left = (k * w) + 'px'; pw.append(c);
            const tag = document.createElement('div'); tag.className = 'ag-pgno'; tag.textContent = k ? '2부' : '1부'; pw.append(tag); box.append(pw);
          }
          box.style.width = (w * 2) + 'px'; box.style.height = h + 'px';
          const seam = document.createElement('div'); seam.className = 'ag-seam'; seam.style.left = w + 'px'; box.append(seam);
          box.append(mk('ghost', w, h * 0.43), mk('big', w, h * 0.58));
        } else if (x.kind === 'ganin') {
          // 3쪽 위에 2쪽을 겹쳐 두고 → 2쪽 오른쪽 절반을 앞으로 접어 → 접힌 가장자리와 3쪽에 걸쳐 도장
          const w = Math.round(W * 0.82), h = Math.round(w * 1.414);
          const p3 = await pageCanvas(x.p + 1, w), p2 = await pageCanvas(x.p, w);
          const img2 = p2.c.toDataURL('image/png');
          box.style.width = (w + 10) + 'px'; box.style.height = (h + 10) + 'px';
          const under = document.createElement('div'); under.className = 'ag-page ag-under'; under.style.left = '10px'; under.style.top = '10px'; under.append(p3.c);
          const lab3 = document.createElement('div'); lab3.className = 'ag-pgno'; lab3.textContent = `${x.p + 1}쪽`; under.append(lab3);
          const top = document.createElement('div'); top.className = 'ag-top'; top.style.width = w + 'px'; top.style.height = h + 'px';
          // 2쪽 아래쪽 절반을 위로 접어 올림 → 접힌 선(가운데)과 3쪽에 걸쳐 도장
          const half = (cls, pos) => { const d = document.createElement('div'); d.className = cls; d.style.width = w + 'px'; d.style.height = (h / 2) + 'px';
            d.style.backgroundImage = `url(${img2})`; d.style.backgroundSize = `${w}px ${h}px`; d.style.backgroundPosition = pos; return d; };
          const upper = half('ag-half ag-upper', '0 0');
          const flap = document.createElement('div'); flap.className = 'ag-flap'; flap.style.width = w + 'px'; flap.style.height = (h / 2) + 'px'; flap.style.top = (h / 2) + 'px';
          const front = half('ag-face ag-front', `0 -${h / 2}px`); const back = document.createElement('div'); back.className = 'ag-face ag-back';
          flap.append(front, back);
          const lab2 = document.createElement('div'); lab2.className = 'ag-pgno ag-pgno-l'; lab2.textContent = `${x.p}쪽`; upper.append(lab2);
          top.append(upper, flap); box.append(under, top);
          box.append(mk('ghost ag-ghost-ganin', w * 0.4, h / 2), mk('big ag-stamp-ganin', w * 0.62, h / 2));
        } else if (x.kind === 'contract') {
          // 한 화면에: [2부 첫 장 | 1부 첫 장] 계인 → 쪽 경계 간인 → 마지막 쪽 서명란 인감
          const n = x.to - x.from + 1;
          const stageW = Math.max(300, (st.clientWidth || 480) - 36);
          const show3 = [x.from, ...(n >= 3 ? [x.from + 1] : []), ...(n >= 2 ? [x.to] : [])];
          const gap = 22, tw = Math.round(Math.min(150, (stageW - gap * (show3.length + 0.6)) / (show3.length + 0.35)));
          const th = Math.round(tw * 1.414);
          box.classList.add('ag-row'); box.style.height = (th + 34) + 'px';
          let left = Math.round(tw * 0.35), d = 0.3;
          const ghost = document.createElement('div'); ghost.className = 'ag-page ag-ghostcopy'; ghost.style.left = '0px'; ghost.style.width = Math.round(tw * 0.35) + 'px'; ghost.style.height = th + 'px';
          ghost.innerHTML = '<span>2부</span>'; box.append(ghost);
          const at = (cls, lx, ty, label) => { const s = mk('seq ' + cls, lx, ty); s.textContent = label; s.style.animationDelay = d + 's'; d += 0.55; box.append(s); return s; };
          const pos = [];
          for (const [j, pn] of show3.entries()) {
            const { c, sz } = await pageCanvas(pn, tw);
            const pw = document.createElement('div'); pw.className = 'ag-page ag-thumb'; pw.style.left = left + 'px'; pw.append(c);
            const tag = document.createElement('div'); tag.className = 'ag-pgno'; tag.textContent = `${pn}쪽`; pw.append(tag); box.append(pw);
            pos.push({ pn, left, sz });
            if (j < show3.length - 1) {
              const nx = show3[j + 1];
              if (nx !== pn + 1) { const dots = document.createElement('div'); dots.className = 'ag-dots'; dots.style.left = (left + tw) + 'px'; dots.style.width = gap + 'px'; dots.style.top = (th / 2 - 30) + 'px'; dots.textContent = '…'; box.append(dots); }
            }
            left += tw + gap;
          }
          box.style.width = (left - gap + 4) + 'px';
          at('mini gy', Math.round(tw * 0.35), th * 0.58, '계인');
          // 간인: [간인 찍는 방법]과 같은 모습 — 앞 장 아래쪽을 접어 올린 상태로, 접힌 선(쪽 가운데)에 걸쳐 오른쪽(대리점 자리)에 찍기
          const ganinOn = pos.length >= 3 ? [1] : pos.slice(1).map((_, j) => j + 1);
          for (const j of ganinOn) {
            const ov = document.createElement('div'); ov.className = 'ag-foldov'; ov.style.left = pos[j].left + 'px'; ov.style.width = tw + 'px'; ov.style.height = Math.round(th / 2) + 'px';
            ov.innerHTML = `<span>${pos[j].pn - 1}쪽 접어 올림</span>`; box.append(ov);
            at('mini gn', pos[j].left + tw * 0.62, th / 2, '간인');
          }
          const lp = pos[pos.length - 1];
          (x.stamps || []).forEach((p) => at(p.k.startsWith('box_') ? 'box' : '', lp.left + (p.x / lp.sz.w) * tw, (1 - p.y / lp.sz.h) * th, '인'));
          const cap = document.createElement('div'); cap.className = 'ag-rowcap';
          cap.innerHTML = `<span><i class="gy"></i>계인 · 첫 장(2부 맞댄 경계)</span><span><i class="gn"></i>간인 · 앞 장 접은 선, 모든 쪽 경계(${n - 1}곳)</span><span><i></i>인감 · 서명란</span>`;
          box.append(cap);
        } else {
          const { c, sz } = await pageCanvas(x.p, W);
          const pw = document.createElement('div'); pw.className = 'ag-page'; pw.append(c); box.append(pw);
          const H = W * sz.h / sz.w;
          (x.stamps || []).forEach((p, j) => { const s = mk((p.k.startsWith('box_') ? 'box' : '') + (p.opt ? ' opt' : ''), p.x / sz.w * W, (1 - p.y / sz.h) * H);
            if (p.opt) s.textContent = '있으면'; s.style.animationDelay = (0.4 + j * 0.6) + 's'; pw.append(s); });
          const tag = document.createElement('div'); tag.className = 'ag-pgno'; tag.textContent = `${x.p}쪽`; pw.append(tag);
        }
        if (my !== token) return;
        st.innerHTML = ''; st.append(box);
      };
      root.querySelector('#agPrev').onclick = () => show(cur - 1);
      root.querySelector('#agNext').onclick = () => show(cur + 1);
      root.querySelectorAll('.ag-list li[data-i]').forEach((li) => li.onclick = () => show(Number(li.dataset.i)));
      root.querySelector('#agPrint').onclick = async () => printGuide(await sealGuide(info, app, 'all'), info);
      show(0);
    } catch (e) {
      console.error(e);
      root.innerHTML = await sealGuide(info, app, which);   // 미리보기를 못 만들면 글로 된 가이드
    }
  })();
}

async function openNoticePdf() {
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl('templates/notice.pdf', 600);
  if (error) return fail(error);
  window.open(data.signedUrl, '_blank');
}
function bindMakeDocs(root, info, app) {
  root.querySelectorAll('[data-guide]').forEach((b) => b.onclick = () => guideThenDownload(info, app, 'all'));
  root.querySelectorAll('[data-pdf]').forEach((b) => b.onclick = async () => {
    if (!isAdmin() && !b.dataset.pdf.startsWith('doc:')) return guideThenDownload(info, app, b.dataset.pdf);   // 대리점은 날인 가이드를 먼저 보여줌
    const t = b.innerHTML; b.disabled = true; b.textContent = 'PDF 만드는 중…';
    try { await makePdf(b.dataset.pdf, info, app); toast('PDF를 내려받았습니다.'); } catch (e) { fail(e); }
    b.disabled = false; b.innerHTML = t;
  });
  root.querySelectorAll('[data-npdf]').forEach((b) => b.onclick = openNoticePdf);
  root.querySelectorAll('[data-mlist]').forEach((b) => b.onclick = () => printMailList(info, app));
}
function staffList(d) {
  return [...new Set([String(d.rep || '').trim(), ...(d.emps || []).map((e) => String(e.name || '').trim())].filter(Boolean))];
}

// 원본 발송 목록 출력 (봉투에 동봉)
function printMailList(info, app, received = null) {
  const items = mailItems(info);
  const w = window.open('', '_blank');
  if (!w) return toast('팝업이 차단됐습니다. 브라우저에서 팝업을 허용해 주세요.', true);
  let n = 0;
  const rows = items.map((x) => x.group ? `<tr class="g"><td colspan="5">${esc(x.group)}</td></tr>`
    : `<tr><td class="c">${++n}</td><td>${esc(x.t)}${x.s ? ' <small>개인정보</small>' : ''}</td><td class="c">${x.n}</td><td>${esc(x.note)}</td><td class="c">${received ? (received[x.k] ? '✔' : '') : '☐'}</td></tr>`).join('');
  w.document.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>원본 서류 발송 목록</title>
    <style>@page{size:A4;margin:15mm}body{font-family:'Malgun Gothic',sans-serif;color:#000;margin:0;font-size:12.5px}
    h1{text-align:center;font-size:21px;margin:4px 0 14px;letter-spacing:.1em}.info{width:100%;border-collapse:collapse;margin-bottom:10px}
    .info td,.info th{border:1px solid #000;padding:6px 8px}.info th{background:#eee;width:16%;text-align:left}
    table.l{width:100%;border-collapse:collapse}table.l th,table.l td{border:1px solid #000;padding:5px 7px}table.l th{background:#eee}
    .c{text-align:center;width:40px}tr.g td{background:#f4f4f4;font-weight:700}small{border:1px solid #c00;color:#c00;border-radius:3px;padding:0 3px;font-size:10px}
    .to{margin-top:14px;border:2px solid #000;padding:10px 12px;line-height:1.7}.tool{text-align:center;margin:10px}@media print{.tool{display:none}}</style></head><body>
    <div class="tool"><button onclick="print()">🖨 인쇄</button></div>
    <h1>대리점 개설 원본 서류 발송 목록</h1>
    <table class="info"><tr><th>상호</th><td>${esc(info.agency || '')}</td><th>대표자</th><td>${esc(info.rep || '')}</td></tr>
      <tr><th>사업자번호</th><td>${esc(info.bizno || '')}</td><th>신청번호</th><td>${app.id} (${esc(info.corp_type || '')}사업자)</td></tr></table>
    <table class="l"><tr><th>No</th><th>서류</th><th>부수</th><th>비고</th><th>${received ? '수령' : '동봉'}</th></tr>${rows}</table>
    <div class="to"><b>보내실 곳</b><br>${esc(MAIL_TO)}<br>※ 개인정보가 포함된 서류(신분증·등본·인감증명서 등)는 파트너센터에 올리지 말고 이 목록과 함께 우편으로만 보내 주세요.<br>※ 계약서는 보관용 부수 모두 첫 장 계인, 쪽 사이 간인, 서명란 날인을 해 주세요. 본사 날인 후 대리점(·연대보증인) 보관용을 돌려드립니다.</div>
    </body></html>`);
  w.document.close();
}

// ---------- 기본 정보 입력 화면 ----------
function infoField(f, d) {
  const v = d[f.k];
  const req = f.req ? ' <b class="req-mark">*</b>' : '';
  if (f.type === 'radio') return `<div class="field ${f.wide ? 'wide' : ''}"><span>${esc(f.l)}${req}</span><div class="ob-radios">${f.opt.map((o) =>
    `<label><input type="radio" name="${f.k}" value="${esc(o)}" ${v === o ? 'checked' : ''}> ${esc(o)}</label>`).join('')}</div></div>`;
  if (f.type === 'checks') return `<div class="field ${f.wide ? 'wide' : ''}"><span>${esc(f.l)}</span><div class="ob-radios">${f.opt.map((o) =>
    `<label><input type="checkbox" name="${f.k}" value="${esc(o)}" ${(v || []).includes(o) ? 'checked' : ''}> ${esc(o)}</label>`).join('')}</div></div>`;
  if (f.type === 'check') return `<label class="field wide ob-check"><input type="checkbox" name="${f.k}" value="1" ${v ? 'checked' : ''}> ${esc(f.l)}</label>`;
  if (f.type === 'textarea') return `<label class="field wide"><span>${esc(f.l)}${req}</span><textarea name="${f.k}" rows="4">${esc(v || '')}</textarea></label>`;
  return `<label class="field ${f.wide ? 'wide' : ''}"><span>${esc(f.l)}${req}</span><input type="${f.type === 'date' ? 'date' : 'text'}" name="${f.k}" value="${esc(v || '')}" placeholder="${esc(f.ph || '')}"></label>`;
}
function infoRows(r, d) {
  const y = new Date().getFullYear();
  return `<div class="ob-rows"><div class="ob-rows-t">${esc(r.l)}</div><div class="tbl-wrap"><table class="tbl ob-rtbl"><tr><th>${r.yearLabel ? '연도' : 'No'}</th>${r.cols.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr>
    ${Array.from({ length: r.n }, (_, i) => `<tr><td class="c">${r.yearLabel ? y + i : i + 1}</td>${r.cols.map(([k]) =>
      `<td><input type="text" name="${r.k}.${i}.${k}" value="${esc(d[r.k]?.[i]?.[k] || '')}"></td>`).join('')}</tr>`).join('')}</table></div></div>`;
}
function readInfo(f) {
  const fd = new FormData(f), d = {};
  for (const s of OB_INFO) {
    for (const x of s.f) d[x.k] = x.type === 'checks' ? fd.getAll(x.k) : x.type === 'check' ? !!fd.get(x.k) : String(fd.get(x.k) ?? '').trim();
    for (const r of [s.rows, ...(s.rows2 || [])].filter(Boolean)) {
      d[r.k] = Array.from({ length: r.n }, (_, i) => Object.fromEntries(r.cols.map(([k]) => [k, String(fd.get(`${r.k}.${i}.${k}`) ?? '').trim()])));
      while (d[r.k].length && Object.values(d[r.k].at(-1)).every((v) => !v) && !r.yearLabel) d[r.k].pop();
    }
  }
  return d;
}
function viewInfoEdit(main, app, doc) {
  const d = { ...(doc?.data || {}) };
  if (!doc) Object.assign(d, { agency: app.company_name || '', email: app.email || '', tel: app.phone || '' });
  main.innerHTML = `<div class="bar"><button class="btn" id="back">← 개설 신청</button><div class="grow"></div><button class="btn primary" id="saveTop">저장</button></div>
    <div class="ob-banner info"><b>대리점 개설 신청서</b>와 같은 순서입니다. <b class="req-mark">*</b> 표시만 채우면 제출할 수 있고, 나머지도 채울수록 신청서가 완성됩니다.
      입력한 내용은 계약서·신고서·서약서에도 자동으로 들어갑니다.</div>
    <form id="infoForm" class="ob-info">${OB_INFO.map((s) => `<section class="card ob-sec"><h3>${esc(s.t)}</h3>${s.hint ? `<p class="hint">${esc(s.hint)}</p>` : ''}
      ${s.guar ? '<div class="ob-guar"><button type="button" class="btn small" id="guarRep">대표자 정보로 채우기 (이력서의 생년월일·주소)</button> </div>' : ''}
      <div class="ob-form">${s.f.map((f) => infoField(f, d)).join('')}</div>
      ${[s.rows, ...(s.rows2 || [])].filter(Boolean).map((r) => infoRows(r, d)).join('')}</section>`).join('')}
      <div class="ob-submit"><div>저장 후 [개설 신청] 화면에서 서류를 PDF로 내려받을 수 있습니다.</div><button class="btn primary">저장</button></div></form>`;
  const f = main.querySelector('#infoForm');
  const back = () => { st.obEdit = null; render(); };
  main.querySelector('#back').onclick = () => { if (confirm('저장하지 않은 내용은 사라집니다. 나갈까요?')) back(); };
  main.querySelector('#saveTop').onclick = () => f.requestSubmit();
  const guarSec = main.querySelector('#guarRep')?.closest('section');
  const guarCheck = () => {   // 연대보증인 칸은 법인일 때만 보임
    const v = readInfo(f);
    if (guarSec) guarSec.hidden = v.corp_type !== '법인';
    const seal = f.querySelector('[name=use_seal]')?.closest('label');
    if (seal) seal.hidden = v.corp_type !== '법인';
  };
  f.addEventListener('change', guarCheck); guarCheck();
  main.querySelector('#guarRep').onclick = () => {
    f.g_name.value = f.cv_name.value || f.rep.value; f.g_birth.value = f.cv_birth.value; f.g_addr.value = f.cv_addr.value; guarCheck();
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = readInfo(f);
    if (v.corp_type !== '법인') Object.assign(v, { g_name: '', g_birth: '', g_addr: '', use_seal: false });
    const miss = OB_REQ_F.filter((x) => reqKeys(v).includes(x.k) && !String(v[x.k] ?? '').trim()).map((x) => x.l);
    try {
      const r = doc ? await sb.from('onboard_docs').update({ data: v }).eq('id', doc.id)
                    : await sb.from('onboard_docs').insert({ app_id: app.id, doc_key: 'apply', data: v });
      if (r.error) throw r.error;
      await sb.from('onboard_apps').update({ company_name: v.agency, biz_no: v.bizno, ceo_name: v.rep, phone: v.tel || v.mobile, email: v.email, address: v.addr }).eq('id', app.id);
      toast(miss.length ? `저장했습니다. 필수 항목 ${miss.length}개가 비어 있습니다: ${miss.slice(0, 4).join(', ')}${miss.length > 4 ? ' 등' : ''}` : '저장했습니다.', !!miss.length);
      back();
    } catch (err) { fail(err); }
  };
}

// 고지사항 사전 확인 (모달)
function noticeDialog(app, doc) {
  const d = doc?.data || {};
  modal('가맹점모집인 등록 결격사유 확인', `<p class="hint">여신전문금융업법 제16조의3 제2항에 따라 다음 각 호에 해당하는 사항이 있는지 확인합니다.
    여기서 미리 확인한 뒤, <b>원본 고지사항 양식은 출력해서 자필로 체크하고 서명·날인</b>해 우편으로 보내 주세요.</p>
    <ol class="ob-q">${OB_NOTICE.map((q, i) => `<li><div>${esc(q)}</div><div class="ob-radios">${['예', '아니오'].map((o) =>
      `<label><input type="radio" name="q${i + 1}" value="${o}" required ${d[`q${i + 1}`] === o ? 'checked' : ''}> ${o}</label>`).join('')}</div></li>`).join('')}</ol>
    <p class="hint">"예"에 해당하면 가맹점모집인 등록이 어려울 수 있습니다. 해당 사항이 있으면 본사 담당자와 먼저 상의해 주세요.</p>`,
  async (v) => {
    const data = Object.fromEntries(OB_NOTICE.map((_, i) => [`q${i + 1}`, v[`q${i + 1}`]]));
    const r = doc ? await sb.from('onboard_docs').update({ data }).eq('id', doc.id) : await sb.from('onboard_docs').insert({ app_id: app.id, doc_key: 'notice', data });
    if (r.error) throw r.error;
    toast(noticeYes(data).some(Boolean) ? '"예" 항목이 있습니다. 본사 담당자와 상의해 주세요.' : '저장했습니다.', noticeYes(data).some(Boolean)); render();
  }, '저장', true);
}
function mailDialog(app, doc) {
  const d = doc?.data || {};
  modal('원본 서류 우편 발송', `<p class="hint">발송 목록의 서류를 모두 넣어 아래 주소로 보내 주세요.<br><b>${esc(MAIL_TO)}</b></p>
    <div class="row2"><label class="field"><span>발송일</span><input type="date" name="date" required value="${esc(d.date || new Date().toISOString().slice(0, 10))}"></label>
    <label class="field"><span>등기·택배 번호 <small>(선택)</small></span><input type="text" name="tracking" value="${esc(d.tracking || '')}"></label></div>
    <label class="field ob-check"><input type="checkbox" name="sent" value="1" required ${d.sent ? 'checked' : ''}> 발송 목록의 서류를 모두 넣어 보냈습니다.</label>`,
  async (v) => {
    const data = { sent: !!v.sent, date: v.date, tracking: v.tracking.trim() };
    const r = doc ? await sb.from('onboard_docs').update({ data }).eq('id', doc.id) : await sb.from('onboard_docs').insert({ app_id: app.id, doc_key: 'mail', data });
    if (r.error) throw r.error; toast('발송 정보를 저장했습니다.'); render();
  }, '저장');
}

// ---------- 신규 대리점 화면 ----------
async function viewOnboard(main) {
  let { data: app, error } = await sb.from('onboard_apps').select('*').eq('user_id', me.id).maybeSingle();
  if (error) throw error;
  if (!app) {
    const r = await sb.from('onboard_apps').insert({ user_id: me.id, company_name: me.requested_name || '', phone: me.phone || '', email: me.email || '' }).select('*').single();
    if (r.error) throw r.error; app = r.data;
  }
  const { types, docs, files } = await loadOnboard(app.id);
  const editable = ['draft', 'revise'].includes(app.status);
  const infoDoc = docs.find((x) => x.doc_key === 'apply');
  if (st.obEdit === 'apply' && editable) return viewInfoEdit(main, app, infoDoc);
  const info = infoDoc?.data || {};
  const states = types.map((t) => ({ t, ...docState(t, docs, files, info) }));
  const S = Object.fromEntries(states.map((x) => [x.t.key, x]));
  const req = states.filter((x) => x.required);
  const ready = req.filter((x) => x.done).length;
  const canSubmit = editable && ready === req.length;
  const banner = {
    draft: ['info', '① 기본 정보 입력 → ② 결격사유 확인 → ③ 서류 출력·날인 → ④ 사본 올리기 → ⑤ 원본 우편 발송 순서로 진행한 뒤 <b>제출</b>을 눌러 주세요. 입력한 내용은 자동으로 보관됩니다.'],
    revise: ['warn', `<b>본사에서 보완을 요청했습니다.</b>${app.hq_note ? `<div class="ob-note">${esc(app.hq_note)}</div>` : ''}표시된 서류를 고친 뒤 다시 제출해 주세요.`],
    submitted: ['ok', '제출이 완료됐습니다. <b>본사에서 서류와 우편 원본을 확인</b>하고 있습니다. 보완이 필요하면 이 화면에 안내됩니다.'],
    approved: ['ok', '서류 검토가 끝났습니다. <b>대리점 코드 발급</b>을 기다리고 있습니다. 코드가 나오면 파트너센터의 모든 메뉴를 이용할 수 있습니다.'],
  }[app.status] || ['info', ''];
  const head = (x, ic, n) => `<div class="ob-doc-head"><span class="ob-num">${n}</span>
    <div class="ob-doc-t"><b>${esc(x.t.title)}</b> ${x.required ? '<span class="ob-req">필수</span>' : '<span class="ob-opt">선택</span>'}
      <div class="ob-desc">${esc(x.t.description)}</div></div>${docChip(x, editable)}</div>
    ${x.hq === 'revise' && x.doc?.revise_note ? `<div class="ob-note">보완 사유: ${esc(x.doc.revise_note)}</div>` : ''}`;
  const art = (x, n, body) => x ? `<article class="ob-doc ${x.hq === 'revise' ? 'rev' : ''}" data-k="${esc(x.t.key)}">${head(x, '', n)}<div class="ob-doc-body">${body}</div></article>` : '';
  const upBody = (x) => `${commonFilesHtml(x.files, editable)}${editable ? `<label class="btn small ob-up">＋ 파일 첨부<input type="file" multiple accept="image/*,.pdf" hidden data-up></label>` : ''}`;
  const yes = noticeYes(S.notice?.doc?.data).filter(Boolean).length;
  const items = mailItems(info);

  main.innerHTML = `
    <section class="ob-hero">
      <div><h2>대리점 개설 신청</h2><p>${esc(app.company_name || me.requested_name || '')} · 신청번호 ${app.id}</p></div>
      ${stepper(app.status)}
    </section>
    <div class="ob-banner ${banner[0]}">${banner[1]}</div>
    <div class="ob-progress"><div class="ob-bar"><i style="width:${req.length ? Math.round(ready / req.length * 100) : 0}%"></i></div>
      <span>필수 단계 <b>${ready}</b> / ${req.length}</span></div>

    <div class="ob-docs">
      ${art(S.apply, 1, `${S.apply.doc ? `<div class="ob-sum">${esc(info.corp_type || '')}사업자 · ${esc(info.agency || '')} · 대표 ${esc(info.rep || '')} · 연대보증인 ${esc(info.g_name || '-')}</div>` : ''}
        ${editable ? `<button class="btn ${S.apply.done ? '' : 'primary'} small" data-info>${S.apply.doc ? '내용 수정' : '작성하기'}</button>` : ''}`)}
      ${art(S.notice, 2, `${S.notice.doc ? `<div class="ob-sum ${yes ? 'bad' : ''}">${yes ? `⚠ "예" ${yes}개 — 본사 담당자와 상의가 필요합니다.` : '7개 문항 모두 "아니오"'}</div>` : ''}
        ${editable ? `<button class="btn ${S.notice.done ? '' : 'primary'} small" data-notice>${S.notice.doc ? '다시 확인' : '확인하기'}</button>` : ''}
        <button class="btn small" data-npdf>📄 원본 양식(PDF) 출력</button>`)}
      <article class="ob-doc"><div class="ob-doc-head"><span class="ob-num">3</span><div class="ob-doc-t"><b>서류 자동 작성 · 출력</b>
          <div class="ob-desc">기본 정보가 원본 양식에 채워진 PDF를 내려받아 출력하고 날인합니다.</div></div></div>
        <div class="ob-doc-body">${S.apply.doc ? `<button class="btn small primary" data-pdf="all">⬇ 전체 서류 한 번에 (인쇄용 PDF)</button>
          <button class="btn small" data-pdf="apply">개설 신청서</button>
          <button class="btn small" data-pdf="forms">계약서·신고서·서약서</button>
          <button class="btn small" data-guide>📋 날인 가이드</button>
          <details class="ob-redo"><summary>서류별로 다시 받기 (잘못 출력한 서류만)</summary><div>${sealSteps(info).map((x) => `<button class="btn small" data-pdf="doc:${x.k}">${esc(x.t)} · ${x.n}부</button>`).join('')}</div></details>
          <ul class="ob-tips"><li>[전체 서류 한 번에]에는 계약서가 <b>보관용 부수만큼</b> 이미 들어 있습니다. 프린터는 <b>1부·단면</b>으로 인쇄하세요.</li>
            <li>계약서는 첫 장 <b>계인</b>, 모든 쪽 사이 <b>간인</b>, 서명란 <b>날인</b> 순서입니다. 자세한 위치는 날인 가이드를 보세요.</li>
            <li>개인 보안서약서는 대표자와 종업원 ${staffList(info).length || 1}명분이 들어 있습니다. 각자 서명·날인합니다.</li>
            <li>입금계좌 신고서의 &lt;신고인&gt; 칸과 인감 칸은 손으로 기재·날인합니다. 통장 인감과 같은 도장을 쓰세요.</li>
            ${info.doc_date ? '' : '<li>작성일을 비워 두어 날짜 칸이 빈칸입니다. 날인하는 날짜를 손으로 적어 주세요.</li>'}</ul>`
          : '<div class="muted">① 기본 정보를 먼저 저장하면 내려받을 수 있습니다.</div>'}</div></article>
      ${['biz_reg', 'bankbook', 'lease'].map((k, i) => S[k] && (k !== 'lease' || info.own === '임차' || S[k].files.length) ? art(S[k], `4-${i + 1}`, upBody(S[k])) : '').join('')}
      <div class="ob-banner warn ob-sens">🔒 <b>신분증·주민등록등본·인감증명서·재산세 과세증명서·법인 서류</b>는 개인정보 보호를 위해 파트너센터에 올리지 마세요. 아래 발송 목록에 따라 <b>우편으로만</b> 받습니다.</div>
      ${art(S.mail, 5, `<div class="ob-mail">${items.filter((x) => !x.group).length}종 · <b>${esc(MAIL_TO)}</b></div>
        ${S.mail.doc?.data?.sent ? `<div class="ob-sum">${esc(S.mail.doc.data.date || '')} 발송${S.mail.doc.data.tracking ? ` · 등기번호 ${esc(S.mail.doc.data.tracking)}` : ''}</div>` : ''}
        <button class="btn small" data-mlist ${S.apply.doc ? '' : 'disabled'}>🖨 발송 목록 출력 (동봉용)</button>
        ${editable ? `<button class="btn small ${S.mail.done ? '' : 'primary'}" data-mail>${S.mail.done ? '발송 정보 수정' : '발송했어요'}</button>` : ''}`)}
    </div>

    ${editable ? `<div class="ob-submit"><div>${canSubmit ? '필수 단계가 모두 끝났습니다.' : `필수 단계 ${req.length - ready}개가 남았습니다: ${req.filter((x) => !x.done).map((x) => esc(x.t.title)).join(', ')}`}</div>
      <button class="btn primary" id="obSubmit" ${canSubmit ? '' : 'disabled'}>${app.status === 'revise' ? '보완 후 다시 제출' : '본사에 제출'}</button></div>` : ''}`;

  bindDownloads(main);
  bindMakeDocs(main, info, app);
  main.querySelectorAll('[data-rmfile]').forEach((b) => b.onclick = async () => {
    if (!confirm('이 첨부파일을 삭제할까요?')) return;
    await sb.storage.from(BUCKET).remove([b.dataset.path]);
    const { error: e } = await sb.from('onboard_files').delete().eq('id', b.dataset.rmfile); if (e) return fail(e);
    toast('삭제했습니다.'); render();
  });
  main.querySelectorAll('[data-up]').forEach((inp) => inp.onchange = async () => {
    const key = inp.closest('[data-k]').dataset.k, list = [...inp.files];
    if (list.some((x) => x.size > 20 * 1024 * 1024)) return toast('20MB 이하 파일만 올릴 수 있습니다.', true);
    try {
      for (const file of list) {
        const ext = (file.name.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0].toLowerCase();
        const path = `onboard/${app.id}/${crypto.randomUUID()}${ext}`;
        const { error: ue } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream' }); if (ue) throw ue;
        const { error: fe } = await sb.from('onboard_files').insert({ app_id: app.id, doc_key: key, file_name: file.name, storage_path: path, size: file.size }); if (fe) throw fe;
      }
      const ex = docs.find((d) => d.doc_key === key);   // 첨부하면 '보완 필요' 표시가 풀리도록 기록 갱신
      if (ex) await sb.from('onboard_docs').update({ data: { ...ex.data, _touched: Date.now() } }).eq('id', ex.id);
      else await sb.from('onboard_docs').insert({ app_id: app.id, doc_key: key, data: { _touched: Date.now() } });
      toast('첨부했습니다.'); render();
    } catch (e) { fail(e); }
  });
  const on = (sel, fn) => main.querySelectorAll(sel).forEach((b) => b.onclick = fn);
  on('[data-info]', () => { st.obEdit = 'apply'; render(); });
  on('[data-notice]', () => noticeDialog(app, S.notice.doc));
  on('[data-mail]', () => mailDialog(app, S.mail.doc));
  const sub = main.querySelector('#obSubmit');
  if (sub) sub.onclick = async () => {
    if (yes && !confirm('결격사유 확인에 "예" 항목이 있습니다. 그래도 제출할까요?')) return;
    if (!confirm('본사에 제출할까요? 제출 후에는 본사 검토가 끝날 때까지 수정할 수 없습니다.')) return;
    const { error: e } = await sb.from('onboard_apps').update({ status: 'submitted' }).eq('id', app.id);
    if (e) return fail(e); toast('제출했습니다.'); render();
  };
}

// ---------- 본사: 개설 신청 검토 ----------
async function viewOnboardAdmin(main) {
  if (st.obId) return viewOnboardDetail(main);
  const { data: apps, error } = await sb.from('onboard_apps').select('*').order('updated_at', { ascending: false });
  if (error) throw error;
  const f = st.obFilter || 'active';
  const groups = { active: ['submitted', 'revise', 'approved', 'draft'], submitted: ['submitted'], revise: ['revise'], approved: ['approved'], draft: ['draft'], issued: ['issued'] };
  const list = apps.filter((a) => groups[f].includes(a.status)).sort((a, b) => (a.status === 'submitted' ? 0 : 1) - (b.status === 'submitted' ? 0 : 1));
  const cnt = (k) => apps.filter((a) => groups[k].includes(a.status)).length;
  main.innerHTML = `<div class="bar"><h2>대리점 개설 신청</h2></div>
    <div class="chips" style="margin-bottom:12px;flex-wrap:wrap">${[['active', '진행 중'], ['submitted', '검토 대기'], ['revise', '보완 요청'], ['approved', '검토 완료'], ['draft', '작성 중'], ['issued', '코드 발급']]
      .map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-of="${k}">${l} ${cnt(k)}</button>`).join('')}</div>
    <div class="card list">${list.length ? list.map((a) => `<div class="item" data-ob="${a.id}">
      <span class="ob-chip ${a.status}">${OB_LABEL[a.status]}</span>
      <div><div class="t">${esc(a.company_name || '(상호 미입력)')}</div>
        <div class="meta"><span>대표 ${esc(a.ceo_name || '-')}</span><span>${esc(a.phone || '')}</span><span>신청번호 ${a.id}</span>${a.issued_code ? `<span>코드 ${esc(a.issued_code)}</span>` : ''}</div></div>
      <div class="right">${a.submitted_at ? '제출 ' + fmt(a.submitted_at).slice(0, 10) : '수정 ' + fmt(a.updated_at).slice(0, 10)}</div></div>`).join('')
      : '<div class="empty">해당하는 신청이 없습니다. 신규 대리점은 가입 후 [가입 승인]에서 구분을 \'신규 대리점\'으로 승인하면 서류를 작성할 수 있습니다.</div>'}</div>`;
  main.querySelectorAll('[data-of]').forEach((b) => b.onclick = () => { st.obFilter = b.dataset.of; render(); });
  main.querySelectorAll('[data-ob]').forEach((el) => el.onclick = () => { st.obId = Number(el.dataset.ob); render(); });
}

function infoTable(d) {
  const val = (f) => { const v = d[f.k]; return f.type === 'checks' ? (v || []).join(', ') : f.type === 'check' ? (v ? '예' : '아니오') : v || ''; };
  return OB_INFO.map((s) => {
    const fs = s.f.filter((f) => val(f) !== '' && !(f.type === 'check' && !d[f.k]));
    const rws = [s.rows, ...(s.rows2 || [])].filter(Boolean).map((r) => {
      const rr = (d[r.k] || []).filter((x) => Object.values(x).some(Boolean));
      return rr.length ? `<tr><th>${esc(r.l)}</th><td>${rr.map((x) => esc(r.cols.map(([k]) => x[k]).filter(Boolean).join(' / '))).join('<br>')}</td></tr>` : '';
    }).join('');
    return fs.length || rws ? `<tr class="g"><td colspan="2">${esc(s.t)}</td></tr>${fs.map((f) => `<tr><th>${esc(f.l)}</th><td>${esc(val(f)).replace(/\n/g, '<br>')}</td></tr>`).join('')}${rws}` : '';
  }).join('');
}

async function viewOnboardDetail(main) {
  const { data: app, error } = await sb.from('onboard_apps').select('*').eq('id', st.obId).maybeSingle();
  if (error) throw error;
  if (!app) { st.obId = null; return render(); }
  const { types, docs, files } = await loadOnboard(app.id);
  const info = docs.find((x) => x.doc_key === 'apply')?.data || {};
  const states = types.map((t) => ({ t, ...docState(t, docs, files, info) }));
  const issued = app.status === 'issued';
  const rec = app.received || {};
  const items = mailItems(info).filter((x) => !x.group);
  const recN = items.filter((x) => rec[x.k]).length;
  const nd = docs.find((x) => x.doc_key === 'notice')?.data;
  const yes = noticeYes(nd);
  const body = (x) => {
    const k = x.t.key;
    if (k === 'apply') return x.doc ? `<details class="ob-det"><summary>입력 내용 보기 — ${esc(info.corp_type || '')}사업자 · 연대보증인 ${esc(info.g_name || '-')}</summary><table class="tbl ob-vals">${infoTable(info)}</table></details>
      <button class="btn small primary" data-pdf="all">⬇ 개설 서류 전체 PDF (신청서·계약서·신고서·서약서)</button>` : '<div class="muted">아직 작성하지 않았습니다.</div>';
    if (k === 'notice') return nd ? `<ol class="ob-q small">${OB_NOTICE.map((q, i) => `<li class="${yes[i] ? 'bad' : ''}"><div>${esc(q)}</div><b>${esc(nd[`q${i + 1}`] || '-')}</b></li>`).join('')}</ol>` : '<div class="muted">아직 확인하지 않았습니다.</div>';
    if (k === 'mail') return x.doc?.data?.sent ? `<div class="ob-sum">${esc(x.doc.data.date || '')} 발송${x.doc.data.tracking ? ` · 등기번호 ${esc(x.doc.data.tracking)}` : ''}</div>` : '<div class="muted">아직 발송 표시가 없습니다.</div>';
    return x.files.length ? commonFilesHtml(x.files) : '<div class="muted">첨부 없음</div>';
  };
  main.innerHTML = `
    <div class="bar"><button class="btn" id="back">← 목록</button><div class="grow"></div>
      ${!issued ? `<button class="btn small" id="revise">보완 요청</button>
        <button class="btn small" id="approve" ${app.status === 'approved' ? 'disabled' : ''}>검토 완료</button>
        <button class="btn small primary" id="issue">🏷 코드 발급</button>` : ''}</div>
    <section class="ob-hero admin"><div><h2>${esc(app.company_name || '(상호 미입력)')}</h2>
      <p>대표 ${esc(app.ceo_name || '-')} · ${esc(app.phone || '-')} · ${esc(app.email || '-')}<br>${esc(app.address || '')}</p>
      <p>신청번호 ${app.id} · <span class="ob-chip ${app.status}">${OB_LABEL[app.status]}</span>${app.issued_code ? ` · 발급 코드 <b>${esc(app.issued_code)}</b>` : ''} · 원본 수령 <b data-recn="b">${recN}/${items.length}</b></p></div>
      ${stepper(app.status)}</section>
    ${yes.some(Boolean) ? `<div class="ob-banner warn">⚠ <b>결격사유 확인에서 "예"로 답한 문항이 ${yes.filter(Boolean).length}개 있습니다.</b> 가맹점모집인 등록 가능 여부를 먼저 확인하세요.</div>` : ''}
    ${app.hq_note ? `<div class="ob-banner warn"><b>대리점에 전달한 안내</b><div class="ob-note">${esc(app.hq_note)}</div></div>` : ''}
    <div class="ob-docs">${states.filter((x) => x.required || x.files.length || x.doc).map((x) => `
      <article class="ob-doc ${x.hq === 'revise' ? 'rev' : ''}" data-k="${esc(x.t.key)}">
        <div class="ob-doc-head"><span class="ob-ic">${x.t.kind === 'form' ? '📝' : '📎'}</span>
          <div class="ob-doc-t"><b>${esc(x.t.title)}</b> ${x.required ? '<span class="ob-req">필수</span>' : '<span class="ob-opt">선택</span>'}</div>
          ${docChip(x, false)}</div>
        ${x.hq === 'revise' && x.doc?.revise_note ? `<div class="ob-note">보완 사유: ${esc(x.doc.revise_note)}</div>` : ''}
        <div class="ob-doc-body">${body(x)}
          ${!issued && (x.doc || x.files.length) ? `<div class="ob-acts"><button class="btn small" data-dok>✓ 확인</button><button class="btn small danger" data-drev>보완 요청</button></div>` : ''}
        </div></article>`).join('')}</div>

    <section class="card ob-recv"><div class="bar"><h3>원본 서류 수령 체크</h3><div class="grow"></div>
      <span class="muted" data-recn>${recN}/${items.length} 수령</span> <button class="btn small" data-mlistr>🖨 수령 현황 출력</button></div>
      ${!info.corp_type ? '<div class="muted">기본 정보가 없어 목록을 만들 수 없습니다.</div>' : `<table class="tbl ob-rtbl">${mailItems(info).map((x) => x.group ? `<tr class="g"><td colspan="4">${esc(x.group)}</td></tr>`
        : `<tr><td class="c"><input type="checkbox" data-rcv="${x.k}" ${rec[x.k] ? 'checked' : ''} ${issued ? 'disabled' : ''}></td><td>${esc(x.t)}${x.s ? ' <span class="ob-s">개인정보</span>' : ''}</td><td class="c">${x.n}부</td>
          <td class="muted">${rec[x.k] ? `${esc(rec[x.k].at || '')} ${esc(rec[x.k].by || '')}` : esc(x.note)}</td></tr>`).join('')}</table>`}
      <p class="hint">개인정보가 담긴 원본은 파트너센터에 스캔해 올리지 말고 기존 문서 보관 절차대로 보관하세요.</p></section>`;

  main.querySelector('#back').onclick = () => { st.obId = null; render(); };
  bindDownloads(main);
  bindMakeDocs(main, info, app);
  main.querySelectorAll('[data-mlistr]').forEach((b) => b.onclick = () => printMailList(info, app, rec));
  const recNote = {}; mailItems(info).forEach((x) => { if (!x.group) recNote[x.k] = x.note || ''; });
  main.querySelectorAll('[data-rcv]').forEach((c) => c.onchange = async () => {
    const k = c.dataset.rcv, cell = c.closest('tr').lastElementChild, r2 = { ...rec };
    if (c.checked) r2[k] = { at: new Date().toISOString().slice(0, 10), by: me.contact_name || me.email || '' }; else delete r2[k];
    c.disabled = true;
    const { error: e } = await sb.from('onboard_apps').update({ received: r2 }).eq('id', app.id);
    c.disabled = false;
    if (e) { c.checked = !c.checked; return fail(e); }
    if (c.checked) rec[k] = r2[k]; else delete rec[k];
    cell.textContent = rec[k] ? `${rec[k].at} ${rec[k].by}` : recNote[k];
    const n = items.filter((x) => rec[x.k]).length;
    main.querySelectorAll('[data-recn]').forEach((el) => { el.textContent = el.dataset.recn === 'b' ? `${n}/${items.length}` : `${n}/${items.length} 수령`; });
  });
  const setDoc = async (key, patch) => {
    const ex = docs.find((d) => d.doc_key === key);
    const r = ex ? await sb.from('onboard_docs').update(patch).eq('id', ex.id) : await sb.from('onboard_docs').insert({ app_id: app.id, doc_key: key, ...patch });
    if (r.error) throw r.error;
  };
  main.querySelectorAll('[data-dok]').forEach((b) => b.onclick = async () => {
    try { await setDoc(b.closest('[data-k]').dataset.k, { status: 'ok', revise_note: '' }); toast('확인 처리했습니다.'); render(); } catch (e) { fail(e); }
  });
  main.querySelectorAll('[data-drev]').forEach((b) => b.onclick = () => {
    const key = b.closest('[data-k]').dataset.k;
    modal('서류 보완 요청', `<label class="field"><span>보완 사유 <small>(대리점 화면에 그대로 보입니다)</small></span><textarea name="note" rows="3" required></textarea></label>`,
      async (v) => { await setDoc(key, { status: 'revise', revise_note: v.note.trim() }); toast('보완 요청을 표시했습니다. 위의 [보완 요청]으로 대리점에 돌려보내세요.'); render(); }, '저장');
  });
  const rv = main.querySelector('#revise');
  if (rv) rv.onclick = async () => {
    const { data: acc } = await sb.from('profiles').select('email,contact_name').eq('id', app.user_id).maybeSingle();
    const to = acc?.email || app.email || '';
    modal('대리점에 보완 요청', `<p class="hint">대리점이 다시 서류를 고쳐 제출할 수 있게 됩니다. 서류별 보완 사유도 함께 표시됩니다.</p>
    <label class="field"><span>전체 안내 <small>(선택)</small></span><textarea name="note" rows="3">${esc(app.hq_note || '')}</textarea></label>
    ${to ? `<label class="ob-mailchk"><input type="checkbox" name="mail" checked> 가입 메일 <b>${esc(to)}</b>로 보완 요청 메일 보내기 <small class="muted">(메일 프로그램에 내용이 채워져 열립니다)</small></label>` : '<p class="hint">가입 메일 주소가 없어 메일은 보낼 수 없습니다.</p>'}`,
    async (v, f) => {
      const { error: e } = await sb.from('onboard_apps').update({ status: 'revise', hq_note: v.note.trim() }).eq('id', app.id); if (e) throw e;
      if (to && f.querySelector('[name=mail]')?.checked) {
        const fixes = states.filter((x) => x.hq === 'revise').map((x) => `- ${x.t.title}${x.doc?.revise_note ? `: ${x.doc.revise_note}` : ''}`);
        const who = app.ceo_name || acc?.contact_name || '';
        const bodyTxt = [`${app.company_name || ''} ${who ? `${who} 대표님` : ''}, 안녕하세요.`.trim(), '한국정보통신(KICC) 채널영업2팀입니다.', '',
          '제출해 주신 대리점 개설 서류에 보완이 필요한 부분이 있어 안내드립니다.', '',
          ...(fixes.length ? ['[보완할 서류]', ...fixes, ''] : []), ...(v.note.trim() ? ['[안내 사항]', v.note.trim(), ''] : []),
          'KICC 파트너센터에 로그인하신 뒤 [개설 신청] 화면에서 수정해 다시 제출해 주세요.', location.origin + location.pathname, '',
          '감사합니다.', `${me.contact_name || ''} 드림`.trim()].join('\n');
        const subj = `[KICC 파트너센터] 대리점 개설 서류 보완 요청${app.company_name ? ` - ${app.company_name}` : ''}`;
        location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(bodyTxt)}`;
      }
      toast('보완 요청했습니다.'); render();
    }, '보완 요청');
  };
  const ap = main.querySelector('#approve');
  if (ap) ap.onclick = async () => {
    const missing = states.filter((x) => x.required && x.hq !== 'ok');
    if (missing.length && !confirm(`확인하지 않은 필수 항목이 ${missing.length}건 있습니다. 그래도 검토 완료로 바꿀까요?`)) return;
    const { error: e } = await sb.from('onboard_apps').update({ status: 'approved', hq_note: '' }).eq('id', app.id); if (e) return fail(e);
    toast('검토 완료로 바꿨습니다.'); render();
  };
  const is = main.querySelector('#issue');
  if (is) is.onclick = () => modal('대리점 코드 발급', `<p class="hint">발급하면 대리점이 등록되고, 이 계정은 <b>대표자</b> 권한으로 바뀌어 파트너센터의 모든 메뉴를 쓸 수 있습니다.</p>
    ${recN < items.length ? `<div class="ob-banner warn">원본 서류 ${items.length - recN}종을 아직 수령 체크하지 않았습니다.</div>` : ''}
    <div class="row2"><label class="field"><span>대리점 코드</span><input type="text" name="code" required inputmode="numeric"></label>
    <label class="field"><span>대리점명</span><input type="text" name="name" required value="${esc(app.company_name || '')}"></label></div>`,
    async (v) => {
      const { error: e } = await sb.rpc('issue_agency_code', { aid: app.id, acode: v.code.trim(), aname: v.name.trim() }); if (e) throw e;
      toast(`코드 ${v.code.trim()} 를 발급했습니다.`); boot();
    }, '코드 발급');
}

// =====================================================================
//  전자계약 (특약서) — 대리점: 등록한 날인 이미지로 온라인 날인 / 본사: 출력본에 실물 날인
// =====================================================================
const CT_ST = { draft: ['작성 중', 'gray'], sent: ['대리점 날인 대기', 'blue'], agency_signed: ['본사 날인 대기', 'orange'],
  completed: ['체결 완료', 'green'], rejected: ['수정 요청', 'red'], cancelled: ['취소', 'gray'] };
const CT_EV = { created: '계약서 작성', sent: '대리점에 날인 요청', viewed: '대리점 열람', signed: '대리점 동의·날인', rejected: '대리점 수정 요청',
  recalled: '본사 회수', completed: '본사 날인 · 체결 완료', cancelled: '계약 취소', resent: '수정 후 다시 요청' };
const SEAL_KINDS = ['사용인감', '법인인감', '대표자 도장', '대표자 서명'];
const SEAL_ST = { pending: ['승인 대기', 'orange'], approved: ['사용 가능', 'green'], rejected: ['반려', 'red'] };
const ctBadge = (s) => `<span class="ct-st ${CT_ST[s]?.[1] || 'gray'}">${CT_ST[s]?.[0] || s}</span>`;
const ctNo = (id) => `C-${String(id).padStart(5, '0')}`;
async function sha256(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf instanceof ArrayBuffer ? buf : buf.buffer ? buf : await buf.arrayBuffer());
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function getBytes(path) {
  const { data, error } = await sb.storage.from(BUCKET).download(path);
  if (error) throw new Error('파일을 불러오지 못했습니다.');
  return new Uint8Array(await data.arrayBuffer());
}
const myName = () => me.contact_name || me.email;

// 도장 사진 → 흰 배경 제거 + 여백 자르기 (PNG)
async function cleanSeal(file) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('이미지를 열 수 없습니다.')); i.src = URL.createObjectURL(file); });
  const k = Math.min(1, 900 / Math.max(img.width, img.height)), W = Math.round(img.width * k), H = Math.round(img.height * k);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H), p = d.data; let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i], gg = p[i + 1], b = p[i + 2], light = (r + gg + b) / 3, sat = Math.max(r, gg, b) - Math.min(r, gg, b);
    let a = 255;
    if (light > 210 && sat < 45) a = 0;                                   // 흰 종이
    else if (light > 170 && sat < 30) a = Math.round(((210 - light) / 40) * 255); // 옅은 그림자
    p[i + 3] = Math.min(p[i + 3], a);
    if (p[i + 3] > 60) { const px = (i / 4) % W, py = Math.floor(i / 4 / W); if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
  }
  g.putImageData(d, 0, 0);
  if (x1 < 0) throw new Error('도장 모양을 찾지 못했습니다. 흰 종이에 찍은 도장을 밝은 곳에서 찍어 주세요.');
  const pad = 6, w = x1 - x0 + 1, h = y1 - y0 + 1, out = document.createElement('canvas');
  out.width = w + pad * 2; out.height = h + pad * 2;
  out.getContext('2d').drawImage(c, x0, y0, w, h, pad, pad, w, h);
  return new Promise((res) => out.toBlob(res, 'image/png'));
}

// 계인·간인 자동 위치 (PDF 좌표, pt). 종이 계약서 방식을 그대로 옮김: 도장 하나를 두 장의 경계에 반씩
//  · 계인: 첫 장 왼쪽 끝·오른쪽 끝(같은 높이, 대리점=을 자리라 가운데보다 아래)에 반쪽씩 → 출력한 2부를 옆으로 맞대면 하나의 도장
//  · 간인: 쪽 경계마다 앞 장 아래 끝 + 다음 장 위 끝(같은 가로 위치, 대리점=을 자리라 오른쪽)에 반쪽씩 → 쪽을 위아래로 맞대면 하나의 도장
function ctAutoMarks(sizes, on, w = 57) {
  if (!on || !sizes || sizes.length < 2) return [];
  const n = sizes.length - 1, s1 = sizes[1], gy = Math.round(s1.h * 0.42);
  const out = [{ t: '계인', p: 1, x: 0, y: gy, w }, { t: '계인', p: 1, x: Math.round(s1.w), y: gy, w }];
  for (let p = 1; p < n; p++) {
    out.push({ t: '간인', p, x: Math.round(sizes[p].w * 0.62), y: 0, w });
    out.push({ t: '간인', p: p + 1, x: Math.round(sizes[p + 1].w * 0.62), y: Math.round(sizes[p + 1].h), w });
  }
  return out;
}
function ctMarkSummary(marks = []) {
  const k = (t) => marks.filter((m) => (m.t || '날인') === t);
  const sign = k('날인'), gy = k('계인').length, gn = Math.ceil(k('간인').length / 2);
  return [sign.length ? `서명란 ${sign.length}곳(${[...new Set(sign.map((m) => m.p))].join(', ')}쪽)` : '',
    gy ? '계인 1곳(첫 장 좌우 끝에 반씩)' : '', gn ? `간인 ${gn}곳(쪽 경계마다 반씩)` : ''].filter(Boolean).join(' · ');
}

// 서명란 자동 찾기: 문서에서 "(인)"·"(서명)"·"(날인)" 자리를 찾고, 가장 가까운 당사자 표시("을"·대리점명 vs "갑"·한국정보통신)로 대리점 쪽만 고른다
function ctFindSignSpots(pages, agName) {
  const core = String(agName || '').replace(/㈜|\(주\)|주식회사/g, '').trim();
  const spots = [], keys = [];
  const KEY = [[/(^|[\s"“'‘(\[「<])(을)(?=[\s"”'’)\]」>:：,]|$)/g, 'ag'], [/(^|[\s"“'‘(\[「<])(갑)(?=[\s"”'’)\]」>:：,]|$)/g, 'hq'],
    [/한국정보통신|KICC/g, 'hq'], [/대리점/g, 'ag']];
  if (core.length >= 2) KEY.push([new RegExp(core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'ag']);
  for (let n = 1; n < pages.length; n++) {
    const items = (pages[n] || []).slice().sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const ln = lines.find((l) => Math.abs(l.y - it.y) < Math.max(2, it.size * 0.45));
      if (ln) ln.items.push(it); else lines.push({ y: it.y, size: it.size, items: [it] });
    }
    for (const ln of lines) {
      ln.items.sort((a, b) => a.x - b.x);
      let txt = '', pos = [], prevEnd = null;
      for (const it of ln.items) {
        if (prevEnd !== null && it.x - prevEnd > it.size * 0.25) { txt += ' '; pos.push(null); }
        const chars = [...it.str];
        chars.forEach((ch, k) => { txt += ch; pos.push(it.x + (it.w * (k + 0.5)) / chars.length); });
        prevEnd = it.x + it.w;
      }
      const at = (i) => { for (let j = i; j < pos.length; j++) if (pos[j] != null) return pos[j]; return pos[pos.length - 1]; };
      for (const m of txt.matchAll(/\(\s*(인|印|서명|날인|직인|서명\s*또는\s*인|서명\s*또는\s*날인)\s*\)/g)) {
        const x = (at(m.index) + at(m.index + m[0].length - 1)) / 2;
        spots.push({ p: n, x: Math.round(x), y: Math.round(ln.y + ln.size * 0.35), size: ln.size });
      }
      for (const [re, side] of KEY) for (const m of txt.matchAll(re)) {
        const i = m.index + (m[1] ? m[1].length : 0);
        keys.push({ p: n, x: at(i), y: ln.y, side });
      }
    }
  }
  // 각 서명란에서 위·왼쪽으로 가장 가까운 당사자 표시를 찾는다
  const judged = spots.map((s) => {
    let best = null, bd = Infinity;
    for (const k of keys) {
      if (k.p !== s.p || k.y < s.y - s.size * 1.5 || k.y > s.y + 220) continue;
      const dx = k.x > s.x + 20 ? (k.x - s.x) * 3 : s.x - k.x, dy = k.y - s.y;
      const d = Math.hypot(dx, dy * 1.4);
      if (d < bd) { bd = d; best = k; }
    }
    return { ...s, side: best?.side || null };
  });
  let mine = judged.filter((s) => s.side === 'ag');
  if (!mine.length && judged.length && judged.every((s) => !s.side)) mine = [judged[judged.length - 1]]; // 표시가 전혀 없으면 마지막 서명란
  return { all: judged, mine };
}

// PDF 쪽들을 그리고(날인 위치 표시) 클릭 처리
async function ctRenderPages(box, bytes, marks, { onPageClick, onMarkClick, sealUrl } = {}) {
  const V = await import('./viewer.js?v=7956aee');
  const doc = await V.loadPdfBytes(bytes.slice());
  box.innerHTML = '';
  const width = Math.min(760, box.clientWidth || 760);
  const sizes = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const wrap = document.createElement('div'); wrap.className = 'ct-pg';
    const cv = document.createElement('canvas'); wrap.appendChild(cv);
    const lab = document.createElement('div'); lab.className = 'ct-pgno'; lab.textContent = `${n} / ${doc.numPages}쪽`; wrap.appendChild(lab);
    box.appendChild(wrap);
    const sz = await V.renderPdfPage(doc, n, cv, width); sizes[n] = sz;
    const s = width / sz.w;
    marks.forEach((m, i) => {
      if (m.p !== n) return;
      const el = document.createElement('div'); el.className = 'ct-mark' + (sealUrl ? ' seal' : '') + (m.t ? ' auto' : '');
      Object.assign(el.style, { left: `${(m.x - m.w / 2) * s}px`, top: `${(sz.h - m.y - m.w / 2) * s}px`, width: `${m.w * s}px`, height: `${m.w * s}px` });
      el.innerHTML = sealUrl ? `<img src="${esc(sealUrl)}" alt="">` : `<span>${m.t ? `대리점<br>${esc(m.t)}` : '대리점<br>날인'}</span>`;
      if (m.t) el.title = m.t === '계인' ? '계인 — 첫 장 좌우 끝에 반씩 (자동)' : '간인 — 쪽 경계에 반씩 (자동)';
      if (onMarkClick) el.onclick = (e) => { e.stopPropagation(); if (!m.t) onMarkClick(i); };
      wrap.appendChild(el);
    });
    if (onPageClick) wrap.onclick = (e) => {
      const r = cv.getBoundingClientRect();
      onPageClick({ p: n, x: Math.round((e.clientX - r.left) / s), y: Math.round(sz.h - (e.clientY - r.top) / s) });
    };
  }
  return { pages: doc.numPages, sizes };
}

async function viewContracts(main) {
  const { error: te } = await sb.from('contracts').select('id', { head: true, count: 'exact' }).limit(1);
  if (te && /contracts|schema cache|does not exist/i.test(te.message || '')) {
    main.innerHTML = `<div class="empty"><b>전자계약 데이터베이스가 아직 준비되지 않았습니다.</b><br>${isAdmin()
      ? '데이터베이스 변경이 반영되면 자동으로 열립니다. GitHub Actions의 [데이터베이스 변경 자동 반영] 결과를 확인해 주세요.' : '본사에서 준비 중입니다. 잠시 후 다시 확인해 주세요.'}</div>`;
    return;
  }
  if (isAdmin() && st.ctEdit) return ctEditView(main);
  if (st.ctId) return ctDetailView(main);
  return isAdmin() ? ctListHq(main) : ctListAgency(main);
}

function ctRows(list) {
  if (!list.length) return '<div class="empty">계약이 없습니다.</div>';
  return `<div class="ct-list">${list.map((c) => `<button class="ct-row" data-ct="${c.id}">
    <div class="ct-r1">${ctBadge(c.status)}<b>${esc(c.title)}</b></div>
    <div class="ct-r2 muted">${ctNo(c.id)} · ${esc(c.kind)}${isAdmin() ? ` · ${esc(c.agency_code)} ${esc(agencyName(c.agency_code))}` : ''} · ${fmt(c.updated_at).slice(0, 10)}</div></button>`).join('')}</div>`;
}
function bindCtRows(root) { root.querySelectorAll('[data-ct]').forEach((b) => b.onclick = () => { st.ctId = Number(b.dataset.ct); window.scrollTo(0, 0); render(); }); }

// ---------- 본사: 목록 + 날인 이미지 승인 ----------
async function ctListHq(main) {
  const [{ data: list, error }, { data: seals }] = await Promise.all([
    sb.from('contracts').select('id,agency_code,title,kind,status,updated_at').order('updated_at', { ascending: false }),
    sb.from('agency_seals').select('*').order('registered_at', { ascending: false })]);
  if (error) throw error;
  const f = st.ctFilter || 'todo';
  const groups = { todo: (c) => ['agency_signed', 'rejected', 'draft'].includes(c.status), sent: (c) => c.status === 'sent',
    done: (c) => c.status === 'completed', all: () => true };
  const shown = list.filter(groups[f]);
  const cnt = (k) => list.filter(groups[k]).length;
  const pend = (seals || []).filter((s) => s.status === 'pending');
  main.innerHTML = `<div class="ct">
    <div class="lib-head"><h2>전자계약</h2><button class="btn primary" id="ctNew">+ 새 계약 (PDF 올리기)</button>
      <p class="muted">대리점은 등록한 날인 이미지로 온라인 날인하고, 본사는 날인본을 출력해 실물 도장을 찍은 뒤 스캔본을 올리면 체결이 끝납니다.</p></div>
    ${pend.length ? `<section class="card ct-sealq"><h3>날인 이미지 승인 대기 ${pend.length}건</h3>
      <p class="hint">대리점에서 우편으로 보낸 <b>전자날인 사용 동의서</b> 원본(법인인감 날인·인감증명서 첨부)을 받은 뒤 승인하세요.</p>
      <div class="ct-seals">${pend.map((s) => `<div class="ct-seal" data-seal="${esc(s.agency_code)}"><div class="ct-sealimg"><img data-src="${esc(s.image_path)}" alt=""></div>
        <div><b>${esc(s.agency_code)} ${esc(agencyName(s.agency_code))}</b><div class="muted">${esc(s.kind)} · ${esc(s.registered_name || '')} · ${fmt(s.registered_at)}</div>
        <div class="ct-btns"><button class="btn small primary" data-sok="${esc(s.agency_code)}">동의서 받음 · 승인</button><button class="btn small" data-sno="${esc(s.agency_code)}">반려</button></div></div></div>`).join('')}</div></section>` : ''}
    <div class="chips ct-chips">${[['todo', '처리할 일'], ['sent', '대리점 날인 대기'], ['done', '체결 완료'], ['all', '전체']].map(([k, l]) =>
      `<button class="chip ${f === k ? 'on' : ''}" data-cf="${k}">${l} ${cnt(k)}</button>`).join('')}</div>
    ${ctRows(shown)}
    ${(seals || []).some((s) => s.status !== 'pending') ? `<details class="ct-allseals"><summary>등록된 날인 이미지 전체 보기</summary><div class="ct-seals">${(seals || []).filter((s) => s.status !== 'pending').map((s) =>
      `<div class="ct-seal"><div class="ct-sealimg"><img data-src="${esc(s.image_path)}" alt=""></div><div><b>${esc(s.agency_code)} ${esc(agencyName(s.agency_code))}</b>
      <div class="muted">${esc(s.kind)} · <span class="ct-st ${SEAL_ST[s.status][1]}">${SEAL_ST[s.status][0]}</span>${s.approved_at ? ` · 승인 ${fmt(s.approved_at).slice(0, 10)} ${esc(s.approved_by || '')}` : ''}</div></div></div>`).join('')}</div></details>` : ''}
  </div>`;
  main.querySelectorAll('img[data-src]').forEach(async (im) => { im.src = await signedUrl(im.dataset.src); });
  main.querySelector('#ctNew').onclick = () => { st.ctEdit = 'new'; render(); };
  main.querySelectorAll('[data-cf]').forEach((b) => b.onclick = () => { st.ctFilter = b.dataset.cf; render(); });
  bindCtRows(main);
  main.querySelectorAll('[data-sok]').forEach((b) => b.onclick = async () => {
    if (!confirm(`${agencyName(b.dataset.sok)}의 동의서 원본을 받으셨나요?\n승인하면 이 이미지로 전자계약 날인이 가능해집니다.`)) return;
    const now = new Date().toISOString();
    const { error: e } = await sb.from('agency_seals').update({ status: 'approved', consent_at: now, approved_at: now, approved_by: myName(), note: null }).eq('agency_code', b.dataset.sok);
    if (e) return fail(e); toast('승인했습니다.'); render();
  });
  main.querySelectorAll('[data-sno]').forEach((b) => b.onclick = () => modal('날인 이미지 반려', '<label class="field"><span>사유 (대리점에 표시)</span><textarea name="note" rows="3" required placeholder="예) 도장이 흐려서 다시 찍어 올려 주세요."></textarea></label>', async (v) => {
    const { error: e } = await sb.from('agency_seals').update({ status: 'rejected', note: v.note }).eq('agency_code', b.dataset.sno);
    if (e) throw e; toast('반려했습니다.'); render();
  }, '반려'));
}

// ---------- 본사: 계약 작성·수정 (PDF + 날인 위치) ----------
async function ctEditView(main) {
  let c = null;
  if (st.ctEdit !== 'new') {
    const { data } = await sb.from('contracts').select('*').eq('id', st.ctEdit).maybeSingle(); c = data;
    if (!c || !['draft', 'rejected', 'sent'].includes(c.status)) { st.ctEdit = null; return render(); }
  }
  const mine = agencies;
  // marks: 사용자가 누른 서명란 날인만. 계인·간인(t 표시)은 쪽 크기로 자동 계산
  let bytes = c ? await getBytes(c.src_path) : null, newFile = null, marks = c ? c.marks.filter((m) => !m.t) : [], sizes = [];
  main.innerHTML = `<div class="ct">
    <div class="crumbs"><a href="#" id="ctBack">전자계약</a> › <span>${c ? `${ctNo(c.id)} 수정` : '새 계약'}</span></div>
    <div class="ct-edit">
      <form class="card ct-form" id="ctf">
        <label class="field"><span>대리점</span>${c ? `<input value="${esc(c.agency_code)} ${esc(agencyName(c.agency_code))}" disabled>` :
          `<select name="agency_code" class="ag-search" required><option value="">선택하세요</option>${mine.map((a) => `<option value="${esc(a.code)}">${esc(a.code)} · ${esc(a.name)}</option>`).join('')}</select>`}</label>
        <label class="field"><span>종류</span><select name="kind">${['특약서', '변경 합의서', '부속 합의서', '기타'].map((k) => `<option ${c?.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <label class="field"><span>계약명</span><input name="title" required maxlength="120" value="${esc(c?.title || '')}" placeholder="예) 2027년 수수료 특약서"></label>
        <label class="field"><span>대리점 안내 문구 (선택)</span><textarea name="memo" rows="3" placeholder="예) 12월 정산부터 적용되는 특약입니다.">${esc(c?.memo || '')}</textarea></label>
        <label class="field"><span>계약서 PDF ${c ? '(바꿀 때만)' : ''}</span><input type="file" id="ctFile" accept="application/pdf,.pdf" ${c ? '' : 'required'}></label>
        <div class="ct-markinfo"><div class="ct-mkhead"><b>서명란 날인 <span id="mkCnt">${marks.length}</span>곳</b><button type="button" class="btn small" id="mkFind">서명란 자동 찾기</button></div>
          <p class="hint">PDF를 올리면 대리점 쪽 서명란 “(인)” 자리를 자동으로 찾아 표시합니다. 잘못 잡힌 표시는 눌러서 지우고, 빠진 곳은 문서에서 직접 누르면 추가됩니다.</p>
          <label class="ct-auto"><input type="checkbox" id="mkAuto" checked> 계인·간인 자동으로 찍기
            <small>계인: 첫 장 좌우 끝에 반씩(2부를 옆으로 맞대면 하나) · 간인: 쪽 경계마다 앞 장 아래·다음 장 위에 반씩 — <span id="mkAutoCnt"></span></small></label>
          <label class="field inline"><span>도장 크기</span><select id="mkSize">${[[42, '작게 (1.5cm)'], [57, '보통 (2cm)'], [71, '크게 (2.5cm)']].map(([v, l]) => `<option value="${v}" ${v === 57 ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
        ${c?.status === 'rejected' && c.reject_reason ? `<div class="ct-warn"><b>대리점 수정 요청</b><br>${esc(c.reject_reason)}</div>` : ''}
        <div class="ct-btns"><button type="button" class="btn" id="ctSave">임시 저장</button><button class="btn primary" id="ctSend">대리점에 날인 요청</button></div>
      </form>
      <div class="ct-doc" id="ctDoc">${bytes ? '' : '<div class="empty">계약서 PDF를 선택하면 여기에 표시됩니다.</div>'}</div>
    </div></div>`;
  const docBox = main.querySelector('#ctDoc'), f = main.querySelector('#ctf');
  main.querySelector('#ctBack').onclick = (e) => { e.preventDefault(); st.ctEdit = null; render(); };
  const autoMarks = () => ctAutoMarks(sizes, main.querySelector('#mkAuto').checked, Number(main.querySelector('#mkSize').value));
  const redraw = async () => {
    main.querySelector('#mkCnt').textContent = marks.length;
    if (!bytes) { main.querySelector('#mkAutoCnt').textContent = ''; return; }
    const y = window.scrollY;
    const draw = () => ctRenderPages(docBox, bytes, [...marks, ...autoMarks()], {
      onPageClick: (pt) => { const w = Number(main.querySelector('#mkSize').value); marks.push({ ...pt, w }); redraw(); },
      onMarkClick: (i) => { marks.splice(i, 1); redraw(); } });
    const r = await draw();
    if (!sizes.length) { sizes = r.sizes; await draw(); } // 첫 표시 때 쪽 크기를 알고 나서 자동 위치 다시 그림
    const a = autoMarks();
    main.querySelector('#mkAutoCnt').textContent = main.querySelector('#mkAuto').checked
      ? (a.length ? ctMarkSummary(a) : '') : '사용 안 함';
    window.scrollTo(0, y);
  };
  const findSign = async (auto) => {
    if (!bytes) return toast('계약서 PDF를 먼저 선택하세요.', true);
    const V = await import('./viewer.js?v=7956aee');
    const code = c?.agency_code || f.querySelector('[name=agency_code]')?.value;
    const r = ctFindSignSpots(await V.pdfTextItems(await V.loadPdfBytes(bytes.slice())), code ? agencyName(code) : '');
    if (!r.mine.length) return toast(auto ? '서명란 “(인)”을 자동으로 찾지 못했습니다. 문서에서 도장 자리를 직접 눌러 주세요.' : '서명란 “(인)”을 찾지 못했습니다. 문서에서 직접 눌러 지정해 주세요.', true);
    const w = Number(main.querySelector('#mkSize').value);
    marks = r.mine.map((m) => ({ p: m.p, x: m.x, y: m.y, w }));
    toast(`서명란 ${r.all.length}곳 중 대리점 쪽 ${r.mine.length}곳을 표시했습니다. 위치를 확인해 주세요.`);
    await redraw();
  };
  main.querySelector('#mkFind').onclick = () => findSign(false).catch(fail);
  f.querySelector('[name=agency_code]')?.addEventListener('change', () => { if (bytes) findSign(true).catch(() => {}); });
  main.querySelector('#mkAuto').onchange = redraw;
  main.querySelector('#mkSize').onchange = redraw;
  main.querySelector('#ctFile').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (!PDF_EXT.test(file.name)) { toast('PDF 파일만 올릴 수 있습니다.', true); e.target.value = ''; return; }
    newFile = file; bytes = new Uint8Array(await file.arrayBuffer()); marks = []; sizes = []; await redraw();
    await findSign(true).catch(() => {});
  };
  await redraw();
  if (bytes && !marks.length) await findSign(true).catch(() => {}); // 서명란이 비어 있으면 자동으로 찾아 둠
  const save = async (send) => {
    const v = form(f);
    if (!c && !v.agency_code) throw new Error('대리점을 선택하세요.');
    if (!v.title.trim()) throw new Error('계약명을 입력하세요.');
    if (!bytes) throw new Error('계약서 PDF를 선택하세요.');
    if (send && !marks.length) throw new Error('서명란 날인 위치를 1곳 이상 지정하세요.');
    const code = c?.agency_code || v.agency_code;
    const row = { title: v.title.trim(), kind: v.kind, memo: v.memo.trim() || null, marks: [...marks, ...autoMarks()] };
    if (newFile) {
      const path = `${code}/contracts/${crypto.randomUUID()}_src.pdf`;
      const { error: ue } = await sb.storage.from(BUCKET).upload(path, newFile, { contentType: 'application/pdf' }); if (ue) throw ue;
      Object.assign(row, { src_path: path, src_name: newFile.name, src_hash: await sha256(bytes) });
    }
    if (send) Object.assign(row, { status: 'sent', reject_reason: null });
    let id = c?.id;
    if (c) { const { error: e } = await sb.from('contracts').update(row).eq('id', c.id); if (e) throw e; }
    else {
      const { data, error: e } = await sb.from('contracts').insert({ ...row, agency_code: code, status: send ? 'sent' : 'draft' }).select('id').single(); if (e) throw e;
      id = data.id; await sb.from('contract_events').insert({ contract_id: id, action: 'created' });
    }
    if (send) await sb.from('contract_events').insert({ contract_id: id, action: c && c.status !== 'draft' ? 'resent' : 'sent' });
    toast(send ? '대리점에 날인을 요청했습니다.' : '저장했습니다.');
    Object.assign(st, { ctEdit: null, ctId: id }); render();
  };
  const run = (send) => async (e) => { e.preventDefault(); const b = e.target; b.disabled = true; try { await save(send); } catch (err) { fail(err); b.disabled = false; } };
  main.querySelector('#ctSave').onclick = run(false);
  main.querySelector('#ctSend').onclick = run(true);
}

// ---------- 대리점: 목록 + 날인 이미지 ----------
async function ctListAgency(main) {
  const code = me.agency_code;
  const [{ data: list, error }, { data: seal }] = await Promise.all([
    sb.from('contracts').select('id,agency_code,title,kind,status,updated_at').order('updated_at', { ascending: false }),
    sb.from('agency_seals').select('*').eq('agency_code', code).maybeSingle()]);
  if (error) throw error;
  const todo = list.filter((c) => c.status === 'sent'), rest = list.filter((c) => c.status !== 'sent');
  main.innerHTML = `<div class="ct">
    <div class="lib-head"><h2>전자계약</h2><p class="muted">본사가 보낸 특약서 등을 확인하고, 등록한 날인 이미지로 온라인 날인합니다.</p></div>
    <section class="card ct-sealcard">${ctSealCard(seal)}</section>
    ${todo.length ? `<h3 class="section-title">날인할 계약 ${todo.length}건</h3>${ctRows(todo)}` : ''}
    <h3 class="section-title">계약 내역</h3>${ctRows(rest)}
  </div>`;
  bindCtRows(main); bindSealCard(main, seal);
}
function ctSealCard(seal) {
  const s = seal?.status;
  return `<div class="ct-sealhead"><div class="ct-sealimg big">${seal ? '<img id="sealImg" alt="">' : '<span class="muted">미등록</span>'}</div>
    <div class="ct-sealtxt"><h3>우리 대리점 날인 이미지 ${seal ? `<span class="ct-st ${SEAL_ST[s][1]}">${SEAL_ST[s][0]}</span>` : ''}</h3>
      ${!seal ? '<p>전자계약에 쓸 도장(사용인감 등)을 흰 종이에 찍어 사진으로 올려 주세요. 배경은 자동으로 지워집니다.</p>'
        : s === 'pending' ? `<p><b>동의서 원본을 우편으로 보내 주세요.</b> 본사가 받으면 승인되고, 그때부터 온라인 날인이 가능합니다.</p>`
        : s === 'rejected' ? `<p class="ct-warn">반려 사유: ${esc(seal.note || '-')}<br>도장을 다시 올려 주세요.</p>`
        : `<p>${esc(seal.kind)} · ${fmt(seal.approved_at).slice(0, 10)} 승인. 이 이미지로 날인합니다.</p>`}
      <ol class="ct-steps"><li class="${seal ? 'done' : 'now'}">도장 이미지 등록</li><li class="${s === 'approved' ? 'done' : seal ? 'now' : ''}">동의서 출력·법인인감 날인 후 우편 발송</li><li class="${s === 'approved' ? 'done' : ''}">본사 승인 → 온라인 날인 가능</li></ol>
      <div class="ct-btns"><button class="btn small ${seal ? '' : 'primary'}" id="sealUp">${seal ? '도장 다시 올리기' : '도장 이미지 등록'}</button>
        ${seal && s !== 'rejected' ? '<button class="btn small primary" id="consentPdf">전자날인 사용 동의서 (PDF)</button>' : ''}</div></div></div>`;
}
function bindSealCard(root, seal) {
  if (seal && root.querySelector('#sealImg')) signedUrl(seal.image_path).then((u) => { root.querySelector('#sealImg').src = u; });
  root.querySelector('#sealUp').onclick = () => {
    let blob = null;
    const w = modal('도장 이미지 등록', `<p class="hint">흰 종이에 도장을 선명하게 찍고, 그림자 없이 위에서 찍은 사진을 올려 주세요. 이미 배경이 없는 PNG 파일도 됩니다.</p>
      <label class="field"><span>종류</span><select name="kind">${SEAL_KINDS.map((k) => `<option>${k}</option>`).join('')}</select></label>
      <label class="field"><span>사진 / 이미지</span><input type="file" id="sealFile" accept="image/*" required></label>
      <div class="ct-sealprev" id="sealPrev"><span class="muted">미리보기</span></div>
      ${seal?.status === 'approved' ? '<p class="ct-warn">다시 올리면 본사 승인 전까지 온라인 날인을 할 수 없습니다.</p>' : ''}`, async (v) => {
      if (!blob) throw new Error('도장 사진을 선택하세요.');
      const path = `${me.agency_code}/seal/${crypto.randomUUID()}.png`;
      const { error: ue } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/png' }); if (ue) throw ue;
      const { error: re } = await sb.rpc('seal_register', { p_path: path, p_kind: v.kind }); if (re) throw re;
      toast('등록했습니다. 동의서를 출력해 우편으로 보내 주세요.'); render();
    }, '등록');
    w.querySelector('#sealFile').onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      const prev = w.querySelector('#sealPrev');
      try { blob = await cleanSeal(file); prev.innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="">`; }
      catch (err) { blob = null; prev.innerHTML = `<span class="ct-warn">${esc(err.message)}</span>`; }
    };
  };
  const cp = root.querySelector('#consentPdf'); if (cp) cp.onclick = async () => {
    cp.disabled = true;
    try { const bytes = await consentPdf(seal); saveBlob(new Blob([bytes], { type: 'application/pdf' }), `전자날인_사용_동의서_${agencyName(me.agency_code)}.pdf`); }
    catch (e) { fail(e); } finally { cp.disabled = false; }
  };
}

// 텍스트 줄바꿈 (pdf-lib)
function wrapText(font, text, size, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const ch of para) { if (font.widthOfTextAtSize(line + ch, size) > maxW) { out.push(line); line = ch.trim() ? ch : ''; } else line += ch; }
    out.push(line);
  }
  return out;
}

// 전자날인 사용 동의서 PDF
async function consentPdf(seal) {
  const K = await pdfKit(); const { PDFDocument, rgb, fontkit } = K.lib;
  const pdf = await PDFDocument.create(); pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(K.font, { subset: false });
  const png = await pdf.embedPng(await getBytes(seal.image_path));
  const pg = pdf.addPage([595.28, 841.89]); const L = 64, R = 595.28 - 64, black = rgb(0, 0, 0);
  let y = 770;
  const t = (s, size = 11, x = L, opt = {}) => pg.drawText(s, { x, y, size, font, color: black, ...opt });
  const title = '전자날인 사용 동의서';
  pg.drawText(title, { x: (595.28 - font.widthOfTextAtSize(title, 20)) / 2, y, size: 20, font, color: black }); y -= 50;
  const ag = agencies.find((a) => a.code === me.agency_code) || {};
  const rows = [['대리점명', ag.name || ''], ['대리점 코드', me.agency_code], ['대표자', me.contact_name || ''], ['등록 이미지 종류', seal.kind], ['등록일', fmt(seal.registered_at).slice(0, 10)]];
  rows.forEach(([k, v]) => { pg.drawRectangle({ x: L, y: y - 8, width: R - L, height: 26, borderColor: black, borderWidth: 0.6 });
    pg.drawLine({ start: { x: L + 120, y: y - 8 }, end: { x: L + 120, y: y + 18 }, thickness: 0.6, color: black }); t(k, 10.5, L + 10); t(v, 10.5, L + 132); y -= 26; });
  y -= 22;
  const body = `위 대리점(이하 "대리점")은 한국정보통신㈜(이하 "회사")와의 특약서·합의서 등 계약 문서를 회사가 운영하는 "KICC 파트너센터"에서 체결할 때, 아래 날인 이미지를 사용하는 것에 동의합니다.

1. 대리점 대표자가 파트너센터에 로그인하여 본인 확인 절차를 거친 뒤 "동의 및 날인"을 한 경우, 아래 이미지가 날인된 문서는 대리점이 실물 도장으로 날인한 것과 같은 효력이 있는 것으로 합니다.
2. 파트너센터는 날인 시각, 접속 정보, 본인 확인 방식, 문서 고유값(SHA-256)을 기록·보관하며, 이 기록은 체결 사실의 증빙으로 사용됩니다.
3. 대리점은 계정 정보가 타인에게 노출되지 않도록 관리하며, 날인 이미지의 변경·사용 중지가 필요하면 즉시 회사에 알립니다.
4. 보증(연대보증 포함)의 의사표시는 이 방식으로 하지 않으며, 관련 법령에 따라 서면으로 합니다.`;
  for (const line of wrapText(font, body, 10.5, R - L)) { t(line, 10.5); y -= 18; }
  y -= 10; t('[등록한 날인 이미지]', 10.5); y -= 12;
  const box = 110, sc = Math.min(box / png.width, box / png.height);
  pg.drawRectangle({ x: L, y: y - box - 10, width: box + 20, height: box + 20, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.6 });
  pg.drawImage(png, { x: L + 10 + (box - png.width * sc) / 2, y: y - box + (box - png.height * sc) / 2, width: png.width * sc, height: png.height * sc });
  y -= box + 50;
  t('20      년      월      일', 12, (595.28 - font.widthOfTextAtSize('20      년      월      일', 12)) / 2); y -= 44;
  t(`대리점명 : ${ag.name || ''}`, 12, 300); y -= 28;
  t('대 표 자 :                               (인)', 12, 300); y -= 16;
  t('※ 법인은 법인인감, 개인사업자는 개인인감으로 날인', 9, 300, { color: rgb(0.35, 0.35, 0.35) }); y -= 34;
  t('첨부 : 인감증명서 1부 (법인은 법인인감증명서)', 10.5); y -= 18;
  t('한국정보통신㈜ 귀중', 14, R - font.widthOfTextAtSize('한국정보통신㈜ 귀중', 14));
  pg.drawText(`보내실 곳: ${MAIL_TO}`, { x: L, y: 40, size: 8, font, color: rgb(0.35, 0.35, 0.35), maxWidth: R - L });
  return pdf.save();
}

// ---------- 계약 상세 (본사·대리점 공통) ----------
async function ctDetailView(main) {
  const [{ data: c, error }, { data: evs }] = await Promise.all([
    sb.from('contracts').select('*').eq('id', st.ctId).maybeSingle(),
    sb.from('contract_events').select('*').eq('contract_id', st.ctId).order('at')]);
  if (error) throw error;
  if (!c) { st.ctId = null; return render(); }
  const hq = isAdmin(), canSign = !hq && c.status === 'sent';
  const { data: seal } = await sb.from('agency_seals').select('*').eq('agency_code', c.agency_code).maybeSingle();
  if (canSign && !(evs || []).some((e) => e.action === 'viewed' && e.actor === me.id)) sb.rpc('contract_viewed', { p_id: c.id }).then(() => {});
  const step = { draft: 0, rejected: 0, sent: 1, agency_signed: 2, completed: 3, cancelled: -1 }[c.status];
  main.innerHTML = `<div class="ct">
    <div class="crumbs"><a href="#" id="ctBack">전자계약</a> › <span>${ctNo(c.id)}</span></div>
    <div class="ct-detail">
      <div class="ct-side">
        <section class="card ct-info">
          <div class="ct-r1">${ctBadge(c.status)}<span class="muted">${esc(c.kind)} · 문서번호 ${ctNo(c.id)}</span></div>
          <h2>${esc(c.title)}</h2>
          <div class="muted">${esc(c.agency_code)} ${esc(agencyName(c.agency_code))}</div>
          ${c.memo ? `<div class="ct-memo">${esc(c.memo)}</div>` : ''}
          ${c.status === 'rejected' && c.reject_reason ? `<div class="ct-warn"><b>수정 요청</b><br>${esc(c.reject_reason)}</div>` : ''}
          ${step >= 0 ? `<ol class="ct-steps h">${['본사 작성', '대리점 날인', '본사 날인', '체결 완료'].map((l, i) => `<li class="${i < step || step === 3 ? 'done' : i === step ? 'now' : ''}">${l}</li>`).join('')}</ol>
            <p class="ct-stepnow muted">${['', '지금 단계: 대리점 대표자의 동의·날인을 기다리는 중', '지금 단계: 본사가 출력해 실물 날인 후 날인본을 올릴 차례', ''][step] || ''}</p>` : ''}
          ${c.marks?.length ? `<p class="ct-stepnow muted">대리점 날인: ${esc(ctMarkSummary(c.marks))}</p>` : ''}
          <div class="ct-files">
            <button class="btn small" data-dl="src">원본 PDF</button>
            ${c.signed_path ? '<button class="btn small" data-dl="signed">대리점 날인본</button>' : ''}
            ${c.final_path ? '<button class="btn small primary" data-dl="final">체결 완료본</button>' : ''}
            <button class="btn small" id="ctVerify">파일 진위 확인</button>
          </div>
        </section>
        <section class="card ct-act" id="ctAct"></section>
        <section class="card ct-log"><h4>진행 이력</h4><ul>${(evs || []).map((e) => `<li><b>${esc(CT_EV[e.action] || e.action)}</b>
          <span class="muted">${fmt(e.at)} · ${esc(e.actor_name || '')}${hq && e.ip ? ` · IP ${esc(e.ip)}` : ''}</span>${e.detail?.reason ? `<div class="muted">${esc(e.detail.reason)}</div>` : ''}</li>`).join('') || '<li class="muted">기록 없음</li>'}</ul>
          ${c.signed_at ? `<div class="ct-proof"><div>날인자: ${esc(c.signed_name || '')} · ${esc(c.sign_method || '')}</div><div>서버 기록 시각: ${fmt(c.signed_at)}${hq && c.sign_ip ? ` · IP ${esc(c.sign_ip)}` : ''}</div>
            <div>원본 SHA-256: <code>${esc(c.src_hash)}</code></div><div>날인본 SHA-256: <code>${esc(c.signed_hash || '')}</code></div></div>` : ''}</section>
      </div>
      <div class="ct-doc" id="ctDoc"><div class="empty">문서를 불러오는 중…</div></div>
    </div></div>`;
  main.querySelector('#ctBack').onclick = (e) => { e.preventDefault(); st.ctId = null; render(); };
  const fileOf = { src: [c.src_path, c.src_name || `${ctNo(c.id)}_원본.pdf`], signed: [c.signed_path, `${ctNo(c.id)}_${c.title}_대리점날인본.pdf`],
    final: [c.final_path, c.final_name || `${ctNo(c.id)}_${c.title}_체결완료본.pdf`] };
  main.querySelectorAll('[data-dl]').forEach((b) => b.onclick = async () => {
    const [p, n] = fileOf[b.dataset.dl]; try { saveBlob(new Blob([await getBytes(p)]), n.replace(/[\\/:*?"<>|]/g, '_')); } catch (e) { fail(e); }
  });
  main.querySelector('#ctVerify').onclick = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.pdf,application/pdf';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return; const h = await sha256(await f.arrayBuffer());
      const hit = h === c.signed_hash ? '대리점 날인본' : h === c.src_hash ? '본사가 보낸 원본' : null;
      modal('파일 진위 확인', `<div class="${hit ? 'ct-ok' : 'ct-warn'}">${hit ? `✔ 이 파일은 파트너센터에 기록된 <b>${hit}</b>과 같습니다. 바뀐 곳이 없습니다.` : '✘ 파트너센터에 기록된 원본·날인본과 다릅니다. 내용이 바뀌었거나 다른 파일입니다.'}</div>
        <p class="hint">${esc(f.name)}<br>SHA-256: <code>${h}</code></p>`, async () => {}, '닫기');
    };
    inp.click();
  };
  const docBox = main.querySelector('#ctDoc');
  const showPath = c.signed_path || c.src_path;
  const sealUrl = !c.signed_path && canSign && seal?.status === 'approved' ? await signedUrl(seal.image_path) : null;
  ctRenderPages(docBox, await getBytes(showPath), c.signed_path ? [] : c.marks, { sealUrl }).catch(fail);
  const act = main.querySelector('#ctAct');
  if (hq) ctHqActions(act, c); else ctAgencyActions(act, c, seal, canSign);
  if (!act.innerHTML.trim()) act.remove();
}

function ctHqActions(act, c) {
  const btns = [];
  if (['draft', 'rejected', 'sent'].includes(c.status)) btns.push(`<button class="btn ${c.status === 'sent' ? '' : 'primary'}" id="hEdit">${c.status === 'sent' ? '회수해서 수정' : '수정 · 날인 요청'}</button>`);
  if (c.status === 'agency_signed') act.innerHTML = `<h4>본사 날인</h4><ol class="ct-howto"><li>대리점 날인본을 출력합니다. (마지막 쪽은 체결 확인서)</li><li>본사 날인란에 실물 도장을 찍고, 필요하면 간인합니다.</li><li>스캔한 PDF(또는 사진)를 올리면 체결이 완료됩니다.</li></ol>
    <div class="ct-btns"><button class="btn" data-dl2>출력용 날인본 받기</button><button class="btn primary" id="hFinal">본사 날인본 올리기</button></div>`;
  if (!['completed', 'cancelled'].includes(c.status)) btns.push('<button class="btn danger" id="hCancel">계약 취소</button>');
  if (btns.length) act.insertAdjacentHTML('beforeend', `<div class="ct-btns">${btns.join('')}</div>`);
  const q = (s) => act.querySelector(s);
  if (q('[data-dl2]')) q('[data-dl2]').onclick = () => document.querySelector('[data-dl="signed"]').click();
  if (q('#hEdit')) q('#hEdit').onclick = async () => {
    if (c.status === 'sent') {
      if (!confirm('대리점의 날인 요청을 회수하고 수정할까요?')) return;
      const { error } = await sb.from('contracts').update({ status: 'draft' }).eq('id', c.id); if (error) return fail(error);
      await sb.from('contract_events').insert({ contract_id: c.id, action: 'recalled' });
    }
    st.ctEdit = c.id; render();
  };
  if (q('#hCancel')) q('#hCancel').onclick = () => modal('계약 취소', '<label class="field"><span>사유</span><textarea name="reason" rows="3" required></textarea></label>', async (v) => {
    const { error } = await sb.from('contracts').update({ status: 'cancelled' }).eq('id', c.id); if (error) throw error;
    await sb.from('contract_events').insert({ contract_id: c.id, action: 'cancelled', detail: { reason: v.reason } }); toast('취소했습니다.'); render();
  }, '계약 취소');
  if (q('#hFinal')) q('#hFinal').onclick = () => modal('본사 날인본 올리기', `<p class="hint">본사 도장을 찍은 날인본을 스캔해 올려 주세요. 올리면 대리점도 체결 완료본을 내려받을 수 있습니다.</p>
    <label class="field"><span>파일 (PDF 또는 이미지)</span><input type="file" name="f" accept=".pdf,application/pdf,image/*" required></label>`, async (v, f) => {
    const file = f.querySelector('[name=f]').files[0]; if (!file) throw new Error('파일을 선택하세요.');
    const ext = (file.name.match(/\.[A-Za-z0-9]{1,5}$/) || ['.pdf'])[0].toLowerCase();
    const path = `${c.agency_code}/contracts/${crypto.randomUUID()}_final${ext}`;
    const { error: ue } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream' }); if (ue) throw ue;
    const { error } = await sb.from('contracts').update({ status: 'completed', final_path: path, final_name: `${ctNo(c.id)}_${c.title}_체결완료본${ext}`,
      final_at: new Date().toISOString(), final_by: myName() }).eq('id', c.id);
    if (error) throw error;
    await sb.from('contract_events').insert({ contract_id: c.id, action: 'completed', detail: { file: file.name } });
    toast('체결이 완료됐습니다.'); render();
  }, '올리기');
}

function ctAgencyActions(act, c, seal, canSign) {
  if (!canSign) {
    if (c.status === 'agency_signed') act.innerHTML = '<p>날인을 마쳤습니다. 본사가 날인하면 <b>체결 완료본</b>을 내려받을 수 있습니다.</p>';
    if (c.status === 'completed') act.innerHTML = '<p>체결이 완료됐습니다. 위의 <b>체결 완료본</b>을 보관해 주세요.</p>';
    if (c.status === 'rejected') act.innerHTML = '<p>수정 요청을 보냈습니다. 본사가 수정해서 다시 보내면 날인할 수 있습니다.</p>';
    return;
  }
  if (seal?.status !== 'approved') {
    act.innerHTML = `<h4>날인 전 준비</h4><p>본사 승인을 받은 날인 이미지가 있어야 날인할 수 있습니다. ${seal ? '동의서 원본을 우편으로 보내셨다면 본사 승인을 기다려 주세요.' : '전자계약 첫 화면에서 도장 이미지를 등록해 주세요.'}</p>
      <div class="ct-btns"><button class="btn" id="aReject">수정 요청</button></div>`;
  } else {
    act.innerHTML = `<h4>동의 및 날인</h4>
      <p class="hint">오른쪽 문서의 표시된 자리에 등록한 날인 이미지가 찍힙니다. 끝까지 읽고 진행해 주세요.</p>
      <form id="signF">
        <label class="ct-agree"><input type="checkbox" name="agree" required> 계약서 내용을 모두 확인했으며, 등록한 날인 이미지로 날인하는 데 동의합니다.</label>
        <label class="field"><span>본인 확인 — 파트너센터 비밀번호</span><input type="password" name="pw" required autocomplete="current-password"></label>
        <div class="ct-btns"><button type="button" class="btn" id="aReject">수정 요청</button><button class="btn primary">동의 및 날인</button></div>
      </form>`;
    act.querySelector('#signF').onsubmit = async (e) => {
      e.preventDefault(); const b = e.target.querySelector('.btn.primary'); b.disabled = true; b.textContent = '날인하는 중…';
      try { await ctSign(c, seal, e.target.pw.value); toast('날인했습니다. 본사 날인 후 체결이 완료됩니다.'); render(); }
      catch (err) { fail(err); b.disabled = false; b.textContent = '동의 및 날인'; }
    };
  }
  act.querySelector('#aReject').onclick = () => modal('수정 요청', '<label class="field"><span>수정이 필요한 내용</span><textarea name="reason" rows="4" required></textarea></label>', async (v) => {
    const { error } = await sb.rpc('contract_reject', { p_id: c.id, p_reason: v.reason }); if (error) throw error; toast('본사에 수정 요청을 보냈습니다.'); render();
  }, '보내기');
}

// 날인본 만들기: 원본 확인 → 날인 이미지 → 각 쪽 하단 문서번호 → 체결 확인서 → 업로드 → 서버 기록
async function ctSign(c, seal, pw) {
  const { error: ae } = await sb.auth.signInWithPassword({ email: me.email, password: pw });
  if (ae) throw new Error('비밀번호가 맞지 않습니다.');
  const src = await getBytes(c.src_path);
  const srcHash = await sha256(src);
  if (srcHash !== c.src_hash) throw new Error('원본 문서가 본사가 보낸 것과 다릅니다. 본사에 문의해 주세요.');
  const K = await pdfKit(); const { PDFDocument, rgb, fontkit } = K.lib;
  const pdf = await PDFDocument.load(src); pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(K.font, { subset: false });
  const png = await pdf.embedPng(await getBytes(seal.image_path));
  const pages = pdf.getPages(), now = new Date(), gray = rgb(0.45, 0.45, 0.45);
  c.marks.forEach((m) => {
    const pg = pages[m.p - 1]; if (!pg) return;
    const sc = Math.min(m.w / png.width, m.w / png.height), w = png.width * sc, h = png.height * sc;
    pg.drawImage(png, { x: m.x - w / 2, y: m.y - h / 2, width: w, height: h });
  });
  const foot = `KICC 파트너센터 전자계약 ${ctNo(c.id)} · 원본 ${srcHash.slice(0, 16)} · ${pages.length + 1}쪽 중`;
  pages.forEach((pg, i) => pg.drawText(`${foot} ${i + 1}쪽`, { x: 24, y: 12, size: 6.5, font, color: gray }));
  // 체결 확인서
  const ag = agencies.find((a) => a.code === c.agency_code) || {};
  const pg = pdf.addPage([595.28, 841.89]); const L = 60, R = 535; let y = 770;
  const T = (s, size = 10.5, x = L, color = rgb(0, 0, 0)) => pg.drawText(s, { x, y, size, font, color });
  const ti = '전자 체결 확인서'; pg.drawText(ti, { x: (595.28 - font.widthOfTextAtSize(ti, 19)) / 2, y, size: 19, font }); y -= 26;
  T('이 문서는 KICC 파트너센터에서 아래와 같이 대리점이 동의·날인했음을 확인합니다.', 9.5, L, gray); y -= 30;
  const ua = navigator.userAgent;
  const env = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'macOS' : '기타';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : '브라우저';
  const rows = [['문서 번호', ctNo(c.id)], ['계약명', `${c.title} (${c.kind})`], ['대리점', `${c.agency_code} ${ag.name || ''}`],
    ['날인자', `${myName()} (대표자 · ${me.email})`], ['본인 확인', '파트너센터 로그인 + 비밀번호 재확인'],
    ['날인 이미지', `${seal.kind} · 본사 승인 ${fmt(seal.approved_at).slice(0, 10)} (전자날인 사용 동의서 수령)`],
    ['동의 시각', `${fmt(now)} (이용 기기 기준, 서버 기록 시각은 파트너센터에 보관)`], ['접속 환경', `${env} · ${br}`],
    ['원본 SHA-256', srcHash], ['날인 위치', ctMarkSummary(c.marks)]];
  rows.forEach(([k, v]) => {
    const lines = wrapText(font, v, 9.5, R - L - 130), hh = Math.max(26, lines.length * 14 + 12);
    pg.drawRectangle({ x: L, y: y - hh + 18, width: R - L, height: hh, borderColor: rgb(0, 0, 0), borderWidth: 0.5 });
    pg.drawRectangle({ x: L, y: y - hh + 18, width: 118, height: hh, color: rgb(0.95, 0.95, 0.95), borderColor: rgb(0, 0, 0), borderWidth: 0.5 });
    T(k, 9.5, L + 10); lines.forEach((ln, i) => pg.drawText(ln, { x: L + 130, y: y - i * 14, size: 9.5, font }));
    y -= hh;
  });
  y -= 24;
  for (const ln of wrapText(font, `위 대리점은 본 문서(${pages.length}쪽)의 내용을 확인하고, 사전에 서면으로 동의한 날인 이미지로 날인하는 데 동의하였습니다. 한국정보통신㈜은 이 날인본을 출력하여 실물 날인함으로써 계약을 체결합니다.\n\n날인본의 진위는 파트너센터의 [파일 진위 확인] 기능으로 확인할 수 있으며, 파일이 한 글자라도 바뀌면 확인되지 않습니다.`, 10, R - L)) { T(ln, 10); y -= 17; }
  pg.drawText(`${foot} ${pages.length + 1}쪽`, { x: 24, y: 12, size: 6.5, font, color: gray });
  const out = await pdf.save();
  const signedHash = await sha256(out);
  const path = `${c.agency_code}/contracts/${crypto.randomUUID()}_signed.pdf`;
  const { error: ue } = await sb.storage.from(BUCKET).upload(path, new Blob([out], { type: 'application/pdf' }), { contentType: 'application/pdf' });
  if (ue) throw ue;
  const { error } = await sb.rpc('contract_sign', { p_id: c.id, p_src_hash: srcHash, p_signed_path: path, p_signed_hash: signedHash,
    p_method: '파트너센터 로그인 + 비밀번호 재확인', p_ua: ua });
  if (error) throw error;
}

// ---------- 대리점 검색 선택: 코드나 대리점명 일부를 입력해 빠르게 찾기 ----------
// <select class="ag-search">는 검색 입력칸으로 바뀌고(원래 select는 숨겨진 채 값만 보관), .agency-pick 체크 목록에는 검색칸이 붙습니다.
const agNorm = (s) => String(s || '').toLowerCase().replace(/㈜|\(주\)|주식회사|[\s·()]/g, '');
const agMatch = (code, text, q) => !q || agNorm(code).startsWith(q) || agNorm(String(text).split(' · ').slice(1).join(' · ') || text).includes(q);
function agSearchify(sel) {
  if (sel.dataset.enh) return; sel.dataset.enh = '1';
  const box = document.createElement('div'); box.className = 'agc-combo';
  const inp = document.createElement('input'); Object.assign(inp, { type: 'text', autocomplete: 'off', placeholder: '코드 또는 대리점명 입력' });
  const list = document.createElement('div'); list.className = 'agc-list'; list.hidden = true;
  sel.parentNode.insertBefore(box, sel); box.append(inp, list, sel);
  sel.hidden = true; sel.tabIndex = -1; if (sel.required) { sel.required = false; inp.required = true; }
  const label = () => (sel.value ? sel.selectedOptions[0]?.textContent || '' : '');
  let hits = [], cur = 0, prev = sel.value;
  inp.value = label();
  const draw = (q) => {
    hits = [...sel.options].filter((o) => o.value && agMatch(o.value, o.textContent, q));
    if (q) hits.sort((a, b) => (agNorm(b.value) === q) - (agNorm(a.value) === q));
    cur = Math.max(0, Math.min(cur, hits.length - 1));
    list.innerHTML = hits.length ? hits.map((o, i) => `<div class="agc-item${i === cur ? ' on' : ''}${o.value === sel.value ? ' sel' : ''}" data-i="${i}">${esc(o.textContent)}</div>`).join('')
      : '<div class="agc-none">일치하는 대리점이 없습니다</div>';
    list.hidden = false;
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const pick = (o) => {
    if (!o) return;
    sel.value = o.value; inp.value = o.textContent; list.hidden = true; inp.blur();
    if (sel.value !== prev) { prev = sel.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  };
  inp.onfocus = () => { inp.select(); cur = Math.max(0, [...sel.options].filter((o) => o.value).findIndex((o) => o.value === sel.value)); draw(''); };
  inp.oninput = (e) => { e.stopPropagation(); cur = 0; draw(agNorm(inp.value)); };
  inp.onchange = (e) => e.stopPropagation(); // 검색칸 자체 변경은 바깥 화면에 알리지 않음(값은 select로만)
  inp.onblur = () => setTimeout(() => { list.hidden = true; inp.value = label(); }, 120);
  inp.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (list.hidden) return draw(agNorm(inp.value));
      cur = (cur + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % Math.max(hits.length, 1);
      list.querySelectorAll('.agc-item').forEach((el, i) => el.classList.toggle('on', i === cur)); list.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); if (!list.hidden) pick(hits[cur]); }
    else if (e.key === 'Escape') { list.hidden = true; inp.value = label(); inp.blur(); }
  };
  list.onmousedown = (e) => e.preventDefault(); // 입력칸 포커스 유지
  list.onclick = (e) => { e.preventDefault(); // <label> 안에 있을 때 클릭이 입력칸으로 다시 가지 않게
    const it = e.target.closest('.agc-item'); if (it) pick(hits[+it.dataset.i]); };
}
function agFilterify(pickBox) {
  if (pickBox.dataset.enh) return; pickBox.dataset.enh = '1';
  const inp = document.createElement('input'); Object.assign(inp, { type: 'text', autocomplete: 'off', className: 'agc-filter', placeholder: '코드 또는 대리점명으로 찾기 (전체 선택·해제는 보이는 대리점에만 적용)' });
  pickBox.parentNode.insertBefore(inp, pickBox);
  inp.oninput = () => { const q = agNorm(inp.value);
    pickBox.querySelectorAll('label').forEach((l) => { const c = l.querySelector('input'); l.hidden = !agMatch(c?.value, l.textContent, q); }); };
  inp.onkeydown = (e) => { if (e.key === 'Enter') e.preventDefault(); };
}
const agEnhance = () => {
  document.querySelectorAll('select.ag-search:not([data-enh])').forEach(agSearchify);
  document.querySelectorAll('.agency-pick:not([data-enh])').forEach(agFilterify);
};
new MutationObserver(agEnhance).observe(document.body, { childList: true, subtree: true });
agEnhance();
