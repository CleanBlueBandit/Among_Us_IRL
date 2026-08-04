function renderRoleRevealHtml(isImpostor) {
  const roleColor = isImpostor ? '#ff1a1a' : '#1ac8ff';
  const roleColorSoft = isImpostor ? 'rgba(255, 26, 26, 0.55)' : 'rgba(26, 200, 255, 0.55)';
  const roleColorFaint = isImpostor ? 'rgba(255, 26, 26, 0.12)' : 'rgba(26, 200, 255, 0.12)';
  const roleLabel = isImpostor ? 'IMPOSTOR' : 'CREWMATE';
  const roleDescription = isImpostor
    ? 'Kill and sabotage'
    : 'Do tasks and eject';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Role Reveal</title>
<style>
  :root{
    --glow: ${roleColor};
    --glow-soft: ${roleColorSoft};
    --glow-faint: ${roleColorFaint};
  }
  html, body{
    margin:0;
    padding:0;
    width:100%;
    height:100%;
    background:#000000;
    overflow:hidden;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  }
  .stage{
    position:relative;
    width:100vw;
    height:100vh;
    display:flex;
    align-items:center;
    justify-content:center;
    background:#000000;
  }

  /* -------------------- Starfield -------------------- */
  .particles{ position:absolute; inset:0; overflow:hidden; pointer-events:none; z-index:1; }
  .particle{
    position:absolute;
    width:2px; height:2px;
    background:rgba(255,255,255,0.6);
    border-radius:50%;
    animation: drift linear infinite;
    opacity:0;
  }
  @keyframes drift{
    0%{ opacity:0; transform:translateY(0); }
    10%{ opacity:0.7; }
    90%{ opacity:0.35; }
    100%{ opacity:0; transform:translateY(-40px); }
  }

  .vignette{
    position:absolute; inset:0;
    background: radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.85) 100%);
    pointer-events:none;
    z-index:3;
  }

  /* -------------------- Flash overlay for abrupt reveals -------------------- */
  .flash-overlay{
    position:absolute; inset:0;
    background: var(--glow-faint);
    opacity:0;
    pointer-events:none;
    z-index:5;
    transition: opacity 0.35s ease-out;
  }
  .flash-overlay.hit{
    opacity: 0.55;
    transition: opacity 0.05s linear;
  }

  /* -------------------- Flashlight sweep -------------------- */
  .spotlight-overlay{
    position:absolute; inset:0;
    z-index:6;
    pointer-events:none;
    opacity:0;
    transition: opacity 0.5s ease;
    background:
      radial-gradient(circle at 50% 50%, rgba(255,246,216,0.42) 0px, rgba(255,233,163,0.38) 100px, rgba(255,219,125,0.32) 180px, rgba(255,219,125,0) 180px),
      radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 0px, rgba(0,0,0,0) 180px, #000000 180px, #000000 100%);
  }
  .spotlight-overlay.active{
    opacity:1;
  }

  /* -------------------- Impostor / Crewmate effects -------------------- */
  .effects-layer{
    position:absolute; inset:0;
    overflow:hidden;
    pointer-events:none;
    z-index:4;
  }

  .blood-stem{
    position:absolute;
    top:-30px;
    border-radius: 0 0 50% 50% / 0 0 85% 85%;
    background: linear-gradient(to bottom, rgba(130,0,0,0.95), rgba(175,0,0,0.95) 55%, rgba(90,0,0,0.9));
    box-shadow: 0 0 8px rgba(120,0,0,0.5);
    animation-name: bloodStemGrow;
    animation-timing-function: cubic-bezier(.55,0,.85,.35);
    animation-fill-mode: forwards;
  }
  @keyframes bloodStemGrow{
    0%{ height:0px; opacity:0; }
    6%{ opacity:1; }
    100%{ height: var(--drip-len, 180px); opacity:1; }
  }

  .blood-tip{
    position:absolute;
    border-radius: 50% 50% 45% 45% / 60% 60% 40% 40%;
    background: rgba(150,0,0,0.95);
    opacity:0;
    animation-name: bloodTipFall;
    animation-timing-function: ease-in;
    animation-fill-mode: forwards;
  }
  @keyframes bloodTipFall{
    0%{ opacity:0.95; transform: translateY(0) scale(1); }
    100%{ opacity:0; transform: translateY(150px) scale(0.7); }
  }

  .task-icon{
    position:absolute;
    top:-30px;
    color: rgba(120, 230, 255, 0.85);
    text-shadow: 0 0 8px rgba(80,200,255,0.75), 0 0 18px rgba(80,200,255,0.35);
    opacity:0;
    animation-name: taskFall;
    animation-timing-function: linear;
    animation-fill-mode: forwards;
  }
  @keyframes taskFall{
    0%{ opacity:0; transform:translate(0,0) rotate(0deg); }
    10%{ opacity:0.9; }
    88%{ opacity:0.75; }
    100%{ opacity:0; transform:translate(var(--drift,20px), 360px) rotate(var(--rot,20deg)); }
  }

  /* -------------------- Scenes -------------------- */
  .scene{
    position:absolute;
    left:50%; top:50%;
    transform:translate(-50%,-50%);
    z-index:2;
    text-align:center;
    opacity:0;
    pointer-events:none;
    width:90vw;
  }
  .scene.visible{
    opacity:1;
  }
  .scene.fading{
    transition: opacity 1s ease;
    opacity:0;
  }
  .scene.fading-in{
    transition: opacity 1.6s ease;
    opacity:1;
  }

  #scene-shh span{
    font-size: clamp(1.8rem, 6vw, 3.2rem);
    letter-spacing: 1.2em;
    color: rgba(255,255,255,0.55);
    text-transform: lowercase;
    font-weight: 300;
  }

  #scene-role{
    font-size: clamp(1.6rem, 5vw, 3rem);
    color: rgba(255,255,255,0.85);
    font-weight: 300;
    letter-spacing: 0.05em;
    white-space: normal;
  }
  #scene-role .role-value{
    display:inline-block;
    font-weight: 800;
    color: var(--glow);
    text-shadow:
      0 0 10px var(--glow),
      0 0 25px var(--glow-soft),
      0 0 60px var(--glow-soft);
    opacity:0;
    letter-spacing: 0.08em;
  }
  #scene-role .role-value.pop-in{
    animation: popIn 0.35s cubic-bezier(.2,1.6,.35,1) forwards;
  }

  #scene-desc{
    font-size: clamp(1.4rem, 4.5vw, 2.4rem);
    color: rgba(255,255,255,0.85);
    font-weight: 300;
    letter-spacing: 0.03em;
  }
  #scene-desc .desc-label{
    white-space: pre;
  }
  #scene-desc .desc-value{
    display:inline-block;
    font-weight: 700;
    color: var(--glow);
    text-shadow:
      0 0 10px var(--glow),
      0 0 25px var(--glow-soft),
      0 0 60px var(--glow-soft);
    opacity:0;
  }
  #scene-desc .desc-value.pop-in{
    animation: popIn 0.35s cubic-bezier(.2,1.6,.35,1) forwards;
  }

  @keyframes popIn{
    0%{ opacity:0; transform: scale(1.7); filter: blur(6px); }
    55%{ opacity:1; transform: scale(0.92); filter: blur(0px); }
    100%{ opacity:1; transform: scale(1); filter: blur(0px); }
  }

  .cursor{
    display:inline-block;
    width: 2px;
    margin-left: 2px;
    background: rgba(255,255,255,0.85);
    animation: blink 0.9s steps(1) infinite;
  }
  @keyframes blink{
    0%, 49%{ opacity:1; }
    50%, 100%{ opacity:0; }
  }

  .blackout{
    position:absolute;
    inset:0;
    background:#000;
    z-index:10;
    opacity:0;
    pointer-events:none;
    transition: opacity 1.4s ease;
  }
  .blackout.active{
    opacity:1;
  }
</style>
</head>
<body>
  <div class="stage">
    <div class="particles" id="particles"></div>

    <div class="scene" id="scene-shh">
      <span>sssh...</span>
    </div>

    <div class="scene" id="scene-role">
      <span id="roleIntro">your role is... </span><span class="role-value" id="roleValue">${roleLabel}</span>
    </div>

    <div class="scene" id="scene-desc">
      <span class="desc-label" id="descLabel"></span><span class="desc-value" id="descValue">${roleDescription}</span>
    </div>

    <div class="effects-layer" id="effectsLayer"></div>
    <div class="vignette"></div>
    <div class="flash-overlay" id="flashOverlay"></div>
    <div class="spotlight-overlay" id="spotlightOverlay"></div>
    <div class="blackout" id="blackout"></div>
  </div>

<script>
  const IS_IMPOSTOR = ${isImpostor ? 'true' : 'false'};

  // ---------------- Starfield ----------------
  const particleContainer = document.getElementById('particles');
  const starCount = 90;
  for (let i = 0; i < starCount; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const size = Math.random() * 2 + 1;
    p.style.width = size + 'px';
    p.style.height = size + 'px';
    p.style.left = Math.random() * 100 + 'vw';
    p.style.top = Math.random() * 100 + 'vh';
    p.style.animationDuration = (6 + Math.random() * 10) + 's';
    p.style.animationDelay = (Math.random() * 8) + 's';
    particleContainer.appendChild(p);
  }

  // ---------------- Helpers ----------------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function show(el) {
    el.classList.remove('fading');
    el.classList.add('visible', 'fading-in');
  }

  function hide(el) {
    el.classList.remove('fading-in');
    el.classList.add('fading');
    el.classList.remove('visible');
  }

  function flash() {
    const overlay = document.getElementById('flashOverlay');
    overlay.classList.add('hit');
    setTimeout(() => overlay.classList.remove('hit'), 90);
  }

  function typeText(el, text, speed) {
    return new Promise((resolve) => {
      el.textContent = '';
      const cursor = document.createElement('span');
      cursor.className = 'cursor';
      let i = 0;

      function step() {
        if (i < text.length) {
          el.textContent = text.slice(0, i + 1);
          el.appendChild(cursor);
          i++;
          setTimeout(step, speed);
        } else {
          setTimeout(() => {
            cursor.remove();
            resolve();
          }, 400);
        }
      }
      step();
    });
  }

  // ---------------- Flashlight sweep ----------------
  function easeInOutQuad(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  function setSpotlight(x, y) {
    const overlay = document.getElementById('spotlightOverlay');
    const pos = x + 'px ' + y + 'px';
    overlay.style.background =
      // warm, translucent flashlight beam — lets the text show through
      'radial-gradient(circle at ' + pos + ', ' +
        'rgba(255,246,216,0.42) 0px, rgba(255,233,163,0.38) 100px, ' +
        'rgba(255,219,125,0.32) 180px, rgba(255,219,125,0) 180px), ' +
      // fully opaque black immediately outside the beam — nothing else is visible
      'radial-gradient(circle at ' + pos + ', ' +
        'rgba(0,0,0,0) 0px, rgba(0,0,0,0) 180px, ' +
        '#000000 180px, #000000 100%)';
  }

  function tweenSpotlight(x1, y1, x2, y2, duration) {
    return new Promise((resolve) => {
      const start = performance.now();
      function frame(now) {
        const t = Math.min(1, (now - start) / duration);
        const e = easeInOutQuad(t);
        setSpotlight(x1 + (x2 - x1) * e, y1 + (y2 - y1) * e);
        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          resolve();
        }
      }
      requestAnimationFrame(frame);
    });
  }

  async function sweepSpotlightTo(targetX, targetY) {
    const overlay = document.getElementById('spotlightOverlay');
    const w = window.innerWidth;
    const h = window.innerHeight;
    const topLeft = { x: w * 0.08, y: h * 0.1 };
    const bottomRight = { x: w * 0.92, y: h * 0.9 };

    setSpotlight(topLeft.x, topLeft.y);
    overlay.classList.add('active');
    await sleep(60);
    await tweenSpotlight(topLeft.x, topLeft.y, bottomRight.x, bottomRight.y, 1100);
    document.getElementById('roleValue').classList.add('pop-in');
    await sleep(180);
    await tweenSpotlight(bottomRight.x, bottomRight.y, targetX, targetY, 950);
  }

  // ---------------- Role-specific effects ----------------
  function startBloodEffect() {
    const container = document.getElementById('effectsLayer');
    container.innerHTML = '';
    const count = 13;
    for (let i = 0; i < count; i++) {
      const leftPct = Math.random() * 96 + 2;
      const width = 4 + Math.random() * 5;
      const len = 90 + Math.random() * 250;
      const growDuration = 1.3 + Math.random() * 1.4;
      const startDelay = Math.random() * 1.2;

      const stem = document.createElement('div');
      stem.className = 'blood-stem';
      stem.style.left = leftPct + '%';
      stem.style.width = width + 'px';
      stem.style.setProperty('--drip-len', len + 'px');
      stem.style.animationDuration = growDuration + 's';
      stem.style.animationDelay = startDelay + 's';
      container.appendChild(stem);

      const tip = document.createElement('div');
      tip.className = 'blood-tip';
      tip.style.left = leftPct + '%';
      tip.style.top = (len - 38) + 'px';
      tip.style.width = (width + 4) + 'px';
      tip.style.height = (width + 6) + 'px';
      tip.style.animationDuration = (1 + Math.random() * 0.8) + 's';
      tip.style.animationDelay = (startDelay + growDuration * 0.85) + 's';
      container.appendChild(tip);
    }
  }

  function startTaskEffect() {
    const container = document.getElementById('effectsLayer');
    container.innerHTML = '';
    const icons = ['✓', '⚙', '✓', '✓'];
    const count = 16;
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'task-icon';
      el.textContent = icons[Math.floor(Math.random() * icons.length)];
      el.style.left = (Math.random() * 94 + 2) + '%';
      el.style.fontSize = (14 + Math.random() * 16) + 'px';
      const duration = 2.6 + Math.random() * 2.4;
      el.style.animationDuration = duration + 's';
      el.style.animationDelay = (Math.random() * 1.8) + 's';
      el.style.setProperty('--drift', (Math.random() * 70 - 35) + 'px');
      el.style.setProperty('--rot', (Math.random() * 70 - 35) + 'deg');
      container.appendChild(el);
    }
  }

  // ---------------- Sequence ----------------
  async function runSequence() {
    const sceneShh = document.getElementById('scene-shh');
    const sceneRole = document.getElementById('scene-role');
    const sceneDesc = document.getElementById('scene-desc');
    const roleValue = document.getElementById('roleValue');
    const descLabel = document.getElementById('descLabel');
    const descValue = document.getElementById('descValue');
    const blackout = document.getElementById('blackout');
    const spotlightOverlay = document.getElementById('spotlightOverlay');

    // Scene 0: pure darkness, stars settle in
    await sleep(1200);

    // Scene 1: "shhh..."
    show(sceneShh);
    await sleep(2600);
    hide(sceneShh);
    await sleep(1000);

    // Scene 2: "your role is... " then a flashlight sweeps the screen and lands on the role
    show(sceneRole);
    await sleep(700);

    const rect = roleValue.getBoundingClientRect();
    const targetX = rect.width ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const targetY = rect.width ? rect.top + rect.height / 2 : window.innerHeight / 2;

    await sweepSpotlightTo(targetX, targetY);
    
    flash();
    await sleep(2600);
    spotlightOverlay.classList.remove('active');
    await sleep(400);
    hide(sceneRole);
    await sleep(1000);

    // Scene 3: typewriter "Your role: " then abrupt description reveal
    show(sceneDesc);
    await typeText(descLabel, 'Your role: ', 65);
    await sleep(500);
    descValue.classList.add('pop-in');
    flash();
    if (IS_IMPOSTOR) {
      startBloodEffect();
    } else {
      startTaskEffect();
    }
    await sleep(3200);

    // Fade to black, then redirect
    blackout.classList.add('active');
    await sleep(1500);
    window.location.href = '/dashboard';
  }

  runSequence();
</script>
</body>
</html>`;
}

export {
  renderRoleRevealHtml
};