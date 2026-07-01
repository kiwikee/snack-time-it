// ============================================================
// 앱 설정
// ============================================================
// ⚠️ Firebase Realtime Database URL을 본인 프로젝트 걸로 바꿔주세요.
// 콘솔 > Realtime Database 상단에 표시되는 주소 (예: https://my-project-default-rtdb.firebaseio.com)
const FIREBASE_DB_URL = "https://it-snack-time-default-rtdb.asia-southeast1.firebasedatabase.app/";

// ---------- Firebase Realtime Database 연동 (SDK 없이 REST로) ----------
// 경로: /votes/{categoryId}/{itemId} = { shown: N, picked: N }
function isFirebaseConfigured(){
  return !FIREBASE_DB_URL.includes('YOUR-PROJECT-ID');
}

async function recordVote(catId, shownIdA, shownIdB, pickedId){
  if(!isFirebaseConfigured()) return; // 설정 전이면 조용히 스킵 (로컬 가짜 통계만 사용)
  const bump = { "shown": { ".sv": { "increment": 1 } } };
  const bumpPicked = { "shown": { ".sv": { "increment": 1 } }, "picked": { ".sv": { "increment": 1 } } };
  try{
    await Promise.all([
      fetch(`${FIREBASE_DB_URL}/votes/${catId}/${shownIdA}.json`, {
        method:'PATCH', body: JSON.stringify(shownIdA === pickedId ? bumpPicked : bump)
      }),
      fetch(`${FIREBASE_DB_URL}/votes/${catId}/${shownIdB}.json`, {
        method:'PATCH', body: JSON.stringify(shownIdB === pickedId ? bumpPicked : bump)
      }),
    ]);
  }catch(err){
    console.warn('투표 기록 실패 (네트워크/설정 확인 필요)', err);
  }
}

async function recordChampion(catId, itemId){
  if(!isFirebaseConfigured()) return; // 설정 전이면 조용히 스킵 (로컬 가짜 통계만 사용)
  try{
    await fetch(`${FIREBASE_DB_URL}/votes/${catId}/${itemId}.json`, {
      method:'PATCH', body: JSON.stringify({ "champCount": { ".sv": { "increment": 1 } } })
    });
  }catch(err){
    console.warn('챔피언 기록 실패 (네트워크/설정 확인 필요)', err);
  }
}

async function fetchRealStats(catId){
  if(!isFirebaseConfigured()) return null;
  try{
    const res = await fetch(`${FIREBASE_DB_URL}/votes/${catId}.json`);
    if(!res.ok) return null;
    return await res.json(); // { itemId: { shown, picked } } | null
  }catch(err){
    console.warn('통계 불러오기 실패', err);
    return null;
  }
}

const ROUND_STAGES = [16, 8, 4, 2]; // 각 라운드 시작 시점 아이템 수
const ROUND_MATCH_COUNTS = { 16:8, 8:4, 4:2, 2:1 };

let activeCategory = null;
let currentRoundItems = [];
let nextRoundItems = [];
let matchIndex = 0;
let answered = false;
let completedMatches = 0;
let TOTAL_MATCHES = 15;
let history = {};
let runnerUp = null;
let currentChampion = null;
let pendingNextRound = null;

const el = id => document.getElementById(id);
const screens = {
  intro: el('screen-intro'),
  roundintro: el('screen-roundintro'),
  game: el('screen-game'),
  result: el('screen-result'),
  stats: el('screen-stats'),
};

function showScreen(name){
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
  const inGame = (name === 'game');
  el('roundChip').classList.toggle('show', inGame);
  el('stepper').classList.toggle('show', inGame);
}

function shuffle(arr){
  const a = [...arr];
  for(let i = a.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function hashStr(s){
  let h = 0;
  for(let i = 0; i < s.length; i++){ h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return h;
}
function worstScore(text){ return 42 + (hashStr(text) % 53); } // 42~94

function roundLabel(n){
  const map = {16:'16강', 8:'8강', 4:'4강', 2:'결승'};
  return map[n] || `${n}강`;
}

/* ---------- stepper ---------- */
function renderStepper(){
  const wrap = el('stepper');
  wrap.innerHTML = '';
  ROUND_STAGES.forEach(stage => {
    const div = document.createElement('div');
    const isCurrent = currentRoundItems.length === stage;
    const isDone = currentRoundItems.length < stage;
    div.className = 'step' + (isCurrent ? ' current' : '') + (isDone ? ' done' : '');
    const fillPct = isDone ? 100 : isCurrent ? Math.round((matchIndex / stage) * 100) : 0;
    div.innerHTML = `
      <div class="step-track"><div class="step-fill" style="width:${fillPct}%"></div></div>
      <div class="step-label">${roundLabel(stage)}</div>
    `;
    wrap.appendChild(div);
  });
}

function renderCategoryList(){
  const wrap = el('catList');
  wrap.innerHTML = '';
  CATEGORIES.forEach(cat => {
    const div = document.createElement('div');
    div.className = 'cat-card';
    div.innerHTML = `
      <div class="cat-top">
        <span class="cat-emoji">${cat.emoji}</span>
        <span class="cat-title">${cat.title}</span>
        <span class="cat-count">16강</span>
      </div>
      <div class="cat-desc">${cat.desc}</div>
      <div class="cat-actions">
        <button class="cat-btn" data-play="${cat.id}">시작하기 ▶</button>
        <button class="cat-btn ghost" data-stats="${cat.id}">📊 통계만 보기</button>
      </div>
    `;
    wrap.appendChild(div);
  });
  wrap.querySelectorAll('[data-play]').forEach(btn=>{
    btn.addEventListener('click', ()=> startCategory(btn.dataset.play));
  });
  wrap.querySelectorAll('[data-stats]').forEach(btn=>{
    btn.addEventListener('click', ()=> openStats(btn.dataset.stats, null));
  });
}

function beginRound(items){
  currentRoundItems = items;
  nextRoundItems = [];
  matchIndex = 0;
  if(items.length === 4) history.top4 = [...items];
}

function startCategory(catId){
  activeCategory = CATEGORIES.find(c => c.id === catId);
  TOTAL_MATCHES = activeCategory.items.length - 1;
  completedMatches = 0;
  history = {};
  runnerUp = null;
  beginRound(shuffle(activeCategory.items));
  showScreen('game');
  renderMatch();
}

function renderMatch(){
  const itemA = currentRoundItems[matchIndex];
  const itemB = currentRoundItems[matchIndex + 1];
  const matchNum = Math.floor(matchIndex / 2) + 1;
  const totalInRound = currentRoundItems.length / 2;

  el('roundChip').textContent = `${activeCategory.title} · ${roundLabel(currentRoundItems.length)} · ${matchNum}/${totalInRound}`;
  el('emojiA').textContent = itemA.e;
  el('textA').textContent = itemA.t;
  el('emojiB').textContent = itemB.e;
  el('textB').textContent = itemB.t;

  ['A','B'].forEach(k=>{
    el('opt'+k).classList.remove('locked','picked');
  });

  renderStepper();
  answered = false;
}

function burstConfetti(x, y, color){
  const colors = [color, '#FFC700', '#FF4D8D', '#00E0B8', '#7C5CFF'];
  for(let i = 0; i < 18; i++){
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = x + 'px';
    c.style.top = y + 'px';
    c.style.background = colors[Math.floor(Math.random() * colors.length)];
    c.style.width = (6 + Math.random() * 6) + 'px';
    c.style.height = c.style.width;
    c.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
    const dx = (Math.random() - 0.5) * 220;
    c.style.transform = `translateX(${dx}px)`;
    c.style.animationDuration = (0.8 + Math.random() * 0.6) + 's';
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 1600);
  }
}

function pick(choice){
  if(answered) return;
  answered = true;

  const itemA = currentRoundItems[matchIndex];
  const itemB = currentRoundItems[matchIndex + 1];
  const winner = choice === 'a' ? itemA : itemB;
  const loser = choice === 'a' ? itemB : itemA;
  nextRoundItems.push(winner);
  if(currentRoundItems.length === 2) runnerUp = loser;
  completedMatches++;

  // 실제 투표 기록 (결과/통계 페이지에서 사용, Firebase 설정 전이면 조용히 무시됨)
  recordVote(activeCategory.id, itemA.id, itemB.id, winner.id);

  el('optA').classList.add('locked');
  el('optB').classList.add('locked');
  const pickedNode = el('opt' + (choice === 'a' ? 'A' : 'B'));
  pickedNode.classList.add('picked');

  const rect = pickedNode.getBoundingClientRect();
  burstConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2, choice === 'a' ? '#FFC700' : '#FF4D8D');

  renderStepper();

  // 통계 노출 없이 짧은 피드백 후 바로 다음 매치로 (속도감 우선)
  setTimeout(advanceMatch, 420);
}

el('optA').addEventListener('click', () => pick('a'));
el('optB').addEventListener('click', () => pick('b'));
[el('optA'), el('optB')].forEach((node, idx) => {
  node.addEventListener('keydown', e => {
    if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); pick(idx === 0 ? 'a' : 'b'); }
  });
});

function advanceMatch(){
  matchIndex += 2;
  if(matchIndex >= currentRoundItems.length){
    if(nextRoundItems.length === 1){
      showChampion(nextRoundItems[0]);
      return;
    }
    // 라운드 전환 안내 화면 (16강→8강→4강→결승 진입 시 유지)
    showRoundIntro(nextRoundItems);
    return;
  }
  renderMatch();
}

function showRoundIntro(nextItems){
  const nextCount = nextItems.length;
  const label = roundLabel(nextCount);
  const flavor = {
    8: { emoji:'🔥', desc:'절반이 걸러졌어요. 이제부터 진짜 최악들끼리 붙습니다.' },
    4: { emoji:'⚡', desc:'네 개만 남았어요. 여기부터는 다 만만치 않은 것들이에요.' },
    2: { emoji:'👑', desc:'드디어 결승! 이 둘 중 하나가 최종 챔피언이 됩니다.' },
  }[nextCount] || { emoji:'🎉', desc:'다음 라운드로 넘어갑니다.' };

  el('riEmoji').textContent = flavor.emoji;
  el('riEyebrow').textContent = `${roundLabel(currentRoundItems.length)} 종료`;
  el('riTitle').textContent = `${label} 진출!`;
  el('riDesc').textContent = flavor.desc;

  pendingNextRound = nextItems;
  showScreen('roundintro');
}

el('riNextBtn').addEventListener('click', () => {
  beginRound(pendingNextRound);
  showScreen('game');
  renderMatch();
});

el('retryBtn').addEventListener('click', () => startCategory(activeCategory.id));
el('logoBtn').addEventListener('click', () => showScreen('intro'));
el('toIntroBtn').addEventListener('click', () => showScreen('intro'));
el('backFromStats').addEventListener('click', () => showScreen('intro'));

async function buildRankedList(cat){
  const real = await fetchRealStats(cat.id); // null이면 미설정 상태
  return [...cat.items]
    .map(item => {
      const r = real && real[item.id];
      if(r && r.shown > 0){
        // 실데이터: 이 항목이 "더 최악"으로 뽑힌 비율
        const pct = Math.round(((r.picked || 0) / r.shown) * 100);
        return { ...item, score: pct, votes: r.picked || 0, real: true };
      }
      // 아직 투표 데이터가 없으면 고정 해시값으로 대체 (완전히 랜덤하게 안 튀도록)
      return { ...item, score: worstScore(item.t), votes: 0, real: false };
    })
    .sort((x, y) => y.score - x.score);
}

function renderRankRows(container, ranked, ctx){
  container.innerHTML = '';
  ranked.forEach((item, i) => {
    const rank = i + 1;
    const isChamp = ctx && ctx.champion && ctx.champion.t === item.t;
    const isRunner = ctx && ctx.runnerUp && ctx.runnerUp.t === item.t;
    const row = document.createElement('div');
    row.className = 'stats-row'
      + (rank <= 3 ? ' top' : '')
      + (isChamp || isRunner ? ' me' : '');
    const rankClass = rank === 1 ? 'r1' : rank === 2 ? 'r2' : rank === 3 ? 'r3' : '';
    row.innerHTML = `
      <div class="stats-rank ${rankClass}">${rank}</div>
      <div class="stats-body">
        <div class="stats-label">
          <span class="name">${item.e} ${item.t}</span>
          ${isChamp ? '<span class="me-badge">내 1위</span>' : isRunner ? '<span class="me-badge">내 2위</span>' : ''}
        </div>
        <div class="stats-meter">
          <div class="stats-bar-track"><div class="stats-bar-fill" style="width:${item.score}%"></div></div>
          <span class="stats-score">${item.score}%${item.real ? ` <span style="opacity:.55;font-weight:500;">(${item.votes}번 선택됨)</span>` : ''}</span>
        </div>
      </div>
    `;
    container.appendChild(row);
  });
}

async function showChampion(champion){
  currentChampion = champion;
  recordChampion(activeCategory.id, champion.id);
  el('champEmoji').textContent = champion.e;
  el('champText').textContent = champion.t;
  el('runnerUpText').textContent = `2위: ${runnerUp.e} ${runnerUp.t}`;
  el('resultCatLabel').textContent = `${activeCategory.emoji} ${activeCategory.title} · 최종 결과`;

  const grid = el('top4Grid');
  grid.innerHTML = '';
  (history.top4 || []).forEach(item => {
    const div = document.createElement('div');
    const isChamp = item.t === champion.t;
    const isRunner = runnerUp && item.t === runnerUp.t;
    div.className = 'recap-item' + (isChamp ? ' gold' : isRunner ? ' silver' : '');
    div.innerHTML = `<span class="re">${item.e}</span><span>${item.t}${isChamp ? ' 🏆' : isRunner ? ' 🥈' : ''}</span>`;
    grid.appendChild(div);
  });

  el('rankCallout').textContent = '📊 전체 통계 불러오는 중...';
  el('resultStatsList').innerHTML = '';
  showScreen('result');

  const ranked = await buildRankedList(activeCategory);
  const champRank = ranked.findIndex(x => x.t === champion.t) + 1;
  el('rankCallout').textContent = champRank === 1
    ? `🎯 다들 이걸 최악으로 꼽았어요. 전체 통계에서도 1위예요.`
    : `📊 전체 통계에서는 ${champRank}위에 해당해요. 사람마다 최악은 다르니까요.`;
  el('resultStatsSub').textContent = isFirebaseConfigured()
    ? '실제 참여자들의 누적 선택 통계예요. 내가 고른 항목은 강조돼요.'
    : '(통계 연동 전 임시 수치예요. 내가 고른 항목은 강조돼요.)';

  renderRankRows(el('resultStatsList'), ranked, { champion, runnerUp });
}

async function openStats(catId, ctx){
  const cat = CATEGORIES.find(c => c.id === catId);

  el('statsTitle').textContent = `📊 ${cat.emoji} ${cat.title} 최악 승률 랭킹`;
  el('statsSub').textContent = '불러오는 중...';
  el('statsList').innerHTML = '';
  showScreen('stats');

  const ranked = await buildRankedList(cat);
  el('statsSub').textContent = isFirebaseConfigured()
    ? '실제 참여자들이 지금까지 "더 최악"으로 고른 누적 비율이에요.'
    : '(아직 통계 연동 전이라 임시 수치예요.)';
  renderRankRows(el('statsList'), ranked, ctx);
}

renderCategoryList();
