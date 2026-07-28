
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function getImpostorNames(data) {
  return Object.values(data.players)
    .filter(p => p.impostor)
    .map(p => p.username);
}


function buildImpostorList(names, baseDelay = 2.6) {
  return names
    .map((name, i) => {
      const delay = (baseDelay + i * 0.15).toFixed(2);
      return `<li style="animation-delay:${delay}s">${escapeHtml(name)}</li>`;
    })
    .join('\n');
}


function buildRestartControls(isHost, glowColor) {
  const button = isHost ? `
    <button id="restartBtn" class="restart-btn">Restart</button>
    <style>
      .restart-btn{
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 10;
        padding: 0.55rem 1.2rem;
        background: rgba(0,0,0,0.4);
        border: 1px solid ${glowColor};
        color: #fff;
        border-radius: 6px;
        font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
        font-size: 0.85rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        cursor: pointer;
        box-shadow: 0 0 12px ${glowColor}55;
        transition: background 0.2s ease, box-shadow 0.2s ease;
      }
      .restart-btn:hover{
        background: rgba(0,0,0,0.65);
        box-shadow: 0 0 20px ${glowColor}88;
      }
      .restart-btn:disabled{
        opacity: 0.6;
        cursor: not-allowed;
      }
    </style>
  ` : '';

  return `
    ${button}
    <script src="/socket.io/socket.io.js"></script>
    <script>
      (function(){
        const socket = io();
        socket.on('restart_game', () => {
          window.location.href = '/waiting';
        });
        ${isHost ? `
        const btn = document.getElementById('restartBtn');
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = 'Restarting...';
          try {
            const res = await fetch('/restart', { method: 'POST' });
            const json = await res.json();
            if (json.failed) {
              alert(json.message);
              btn.disabled = false;
              btn.textContent = 'Restart';
              return;
            }
            // host redirects itself the same way everyone else will
            window.location.href = '/waiting';
          } catch (e) {
            alert('Restart failed: ' + e.message);
            btn.disabled = false;
            btn.textContent = 'Restart';
          }
        });` : ''}
      })();
    </script>
  `;
}


function renderImpostorWinHtml(data, isHost = false) {
  const impostorNames = getImpostorNames(data);
  const listItems = buildImpostorList(impostorNames);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Impostors Won</title>
<style>
  :root{
    --glow: #ff1a1a;
    --glow-soft: rgba(255, 26, 26, 0.55);
    --glow-faint: rgba(255, 26, 26, 0.12);
  }
  html, body{
    margin:0;
    padding:0;
    width:100%;
    height:100%;
    background:#050507;
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
  }
  .particles{ position:absolute; inset:0; overflow:hidden; pointer-events:none; }
  .particle{
    position:absolute;
    width:2px; height:2px;
    background:rgba(255,255,255,0.5);
    border-radius:50%;
    animation: drift linear infinite;
    opacity:0;
  }
  @keyframes drift{
    0%{ opacity:0; transform:translateY(0); }
    10%{ opacity:0.6; }
    90%{ opacity:0.3; }
    100%{ opacity:0; transform:translateY(-40px); }
  }
  .horizon{
    position:absolute;
    left:50%; top:50%;
    width:140vw; height:60vh;
    transform:translate(-50%,-50%) scaleX(0.2);
    background: radial-gradient(ellipse at center, var(--glow-soft) 0%, var(--glow-faint) 35%, transparent 70%);
    filter: blur(10px);
    opacity:0;
    animation: horizonRise 3.2s ease-out forwards;
    animation-delay: 0.3s;
  }
  @keyframes horizonRise{
    0%{ opacity:0; transform:translate(-50%,-50%) scaleX(0.1) scaleY(0.4); }
    40%{ opacity:0.9; }
    100%{ opacity:0.75; transform:translate(-50%,-50%) scaleX(1) scaleY(1); }
  }
  .line{
    position:absolute;
    left:50%; top:50%;
    width:0; height:2px;
    background: linear-gradient(90deg, transparent, var(--glow), transparent);
    box-shadow: 0 0 20px 4px var(--glow-soft);
    transform:translate(-50%,-50%);
    animation: lineExpand 1.6s ease-out forwards;
    animation-delay: 0.15s;
  }
  @keyframes lineExpand{
    0%{ width:0; opacity:0; }
    50%{ opacity:1; }
    100%{ width:80vw; opacity:0.8; }
  }
  .content{ position:relative; z-index:2; text-align:center; }
  .eyebrow{
    display:block;
    font-size:1rem;
    letter-spacing:0.6em;
    text-transform:uppercase;
    color: rgba(255, 90, 90, 0.55);
    opacity:0;
    margin-bottom:1.2rem;
    animation: fadeInSlight 1.2s ease forwards;
    animation-delay: 2.1s;
  }
  h1{
    margin:0;
    font-size: clamp(2.5rem, 9vw, 7rem);
    text-transform: uppercase;
    color: var(--glow);
    font-weight:800;
    opacity:0;
    filter: blur(14px);
    letter-spacing: 0.5em;
    animation:
      revealText 1.8s cubic-bezier(.2,.8,.2,1) forwards,
      pulseGlow 2.4s ease-in-out infinite;
    animation-delay: 0.6s, 3s;
    text-shadow:
      0 0 10px var(--glow),
      0 0 25px var(--glow-soft),
      0 0 60px var(--glow-soft),
      0 0 120px var(--glow-faint);
  }
  @keyframes revealText{
    0%{ opacity:0; filter: blur(20px); letter-spacing: 1.1em; transform: scale(1.15); }
    35%{ opacity:0.35; filter: blur(10px); }
    55%{ opacity:0.15; filter: blur(16px); }
    70%{ opacity:0.9; filter: blur(2px); letter-spacing: 0.6em; }
    100%{ opacity:1; filter: blur(0px); letter-spacing: 0.12em; transform: scale(1); }
  }
  @keyframes pulseGlow{
    0%, 100%{
      text-shadow: 0 0 10px var(--glow), 0 0 25px var(--glow-soft), 0 0 60px var(--glow-soft), 0 0 120px var(--glow-faint);
    }
    50%{
      text-shadow: 0 0 16px var(--glow), 0 0 40px var(--glow-soft), 0 0 90px var(--glow-soft), 0 0 160px var(--glow-faint);
    }
  }
  @keyframes fadeInSlight{
    from{ opacity:0; transform:translateY(6px); }
    to{ opacity:1; transform:translateY(0); }
  }
  .vignette{
    position:absolute; inset:0;
    background: radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.75) 100%);
    pointer-events:none;
    z-index:3;
  }
  .flicker-overlay{
    position:absolute; inset:0;
    background: var(--glow-faint);
    opacity:0;
    pointer-events:none;
    animation: flicker 0.15s steps(1) 3;
    animation-delay: 0.55s;
  }
  @keyframes flicker{ 0%{opacity:0;} 50%{opacity:0.15;} 100%{opacity:0;} }

  .impostor-list{
    position:relative;
    z-index:2;
    list-style:none;
    margin: 2.2rem 0 0;
    padding:0;
    display:flex;
    flex-wrap:wrap;
    gap:0.6rem 1rem;
    justify-content:center;
    max-width:70vw;
  }
  .impostor-list li{
    opacity:0;
    padding: 0.35rem 0.9rem;
    border: 1px solid var(--glow-soft);
    border-radius: 999px;
    color: #ffdddd;
    font-size: 0.95rem;
    letter-spacing: 0.05em;
    background: rgba(255, 26, 26, 0.07);
    text-shadow: 0 0 8px var(--glow-soft);
    animation: nameFadeIn 0.6s ease forwards;
  }
  @keyframes nameFadeIn{
    from{ opacity:0; transform:translateY(8px); }
    to{ opacity:1; transform:translateY(0); }
  }
</style>
</head>
<body>
  <div class="stage">
    <div class="particles" id="particles"></div>
    <div class="horizon"></div>
    <div class="line"></div>
    <div class="flicker-overlay"></div>
    <div class="content">
      <span class="eyebrow">${data.gameState.winCondition}</span>
      <h1>Impostors Won</h1>
      <ul class="impostor-list">
${listItems}
      </ul>
    </div>
    <div class="vignette"></div>
    ${buildRestartControls(isHost, '#ff1a1a')}
  </div>

<script>
  const container = document.getElementById('particles');
  const count = 60;
  for(let i=0;i<count;i++){
    const p = document.createElement('div');
    p.className = 'particle';
    const size = Math.random()*2 + 1;
    p.style.width = size+'px';
    p.style.height = size+'px';
    p.style.left = Math.random()*100 + 'vw';
    p.style.top = Math.random()*100 + 'vh';
    p.style.animationDuration = (6 + Math.random()*10) + 's';
    p.style.animationDelay = (Math.random()*8) + 's';
    container.appendChild(p);
  }
</script>
</body>
</html>`;
}


function renderCrewmateWinHtml(data, isHost = false) {
  const impostorNames = getImpostorNames(data);
  const listItems = buildImpostorList(impostorNames);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Crewmates Won</title>
<style>
  :root{
    --glow: #1ac8ff;
    --glow-soft: rgba(26, 200, 255, 0.55);
    --glow-faint: rgba(26, 200, 255, 0.12);
  }
  html, body{
    margin:0;
    padding:0;
    width:100%;
    height:100%;
    background:#050507;
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
  }
  .particles{ position:absolute; inset:0; overflow:hidden; pointer-events:none; }
  .particle{
    position:absolute;
    width:2px; height:2px;
    background:rgba(255,255,255,0.5);
    border-radius:50%;
    animation: drift linear infinite;
    opacity:0;
  }
  @keyframes drift{
    0%{ opacity:0; transform:translateY(0); }
    10%{ opacity:0.6; }
    90%{ opacity:0.3; }
    100%{ opacity:0; transform:translateY(-40px); }
  }
  .horizon{
    position:absolute;
    left:50%; top:50%;
    width:140vw; height:60vh;
    transform:translate(-50%,-50%) scaleX(0.2);
    background: radial-gradient(ellipse at center, var(--glow-soft) 0%, var(--glow-faint) 35%, transparent 70%);
    filter: blur(10px);
    opacity:0;
    animation: horizonRise 3.2s ease-out forwards;
    animation-delay: 0.3s;
  }
  @keyframes horizonRise{
    0%{ opacity:0; transform:translate(-50%,-50%) scaleX(0.1) scaleY(0.4); }
    40%{ opacity:0.9; }
    100%{ opacity:0.75; transform:translate(-50%,-50%) scaleX(1) scaleY(1); }
  }
  .line{
    position:absolute;
    left:50%; top:50%;
    width:0; height:2px;
    background: linear-gradient(90deg, transparent, var(--glow), transparent);
    box-shadow: 0 0 20px 4px var(--glow-soft);
    transform:translate(-50%,-50%);
    animation: lineExpand 1.6s ease-out forwards;
    animation-delay: 0.15s;
  }
  @keyframes lineExpand{
    0%{ width:0; opacity:0; }
    50%{ opacity:1; }
    100%{ width:80vw; opacity:0.8; }
  }
  .content{ position:relative; z-index:2; text-align:center; }
  .eyebrow{
    display:block;
    font-size:1rem;
    letter-spacing:0.6em;
    text-transform:uppercase;
    color: rgba(90, 200, 255, 0.55);
    opacity:0;
    margin-bottom:1.2rem;
    animation: fadeInSlight 1.2s ease forwards;
    animation-delay: 2.1s;
  }
  h1{
    margin:0;
    font-size: clamp(2.5rem, 9vw, 7rem);
    text-transform: uppercase;
    color: var(--glow);
    font-weight:800;
    opacity:0;
    filter: blur(14px);
    letter-spacing: 0.5em;
    animation:
      revealText 1.8s cubic-bezier(.2,.8,.2,1) forwards,
      pulseGlow 2.4s ease-in-out infinite;
    animation-delay: 0.6s, 3s;
    text-shadow:
      0 0 10px var(--glow),
      0 0 25px var(--glow-soft),
      0 0 60px var(--glow-soft),
      0 0 120px var(--glow-faint);
  }
  @keyframes revealText{
    0%{ opacity:0; filter: blur(20px); letter-spacing: 1.1em; transform: scale(1.15); }
    35%{ opacity:0.35; filter: blur(10px); }
    55%{ opacity:0.15; filter: blur(16px); }
    70%{ opacity:0.9; filter: blur(2px); letter-spacing: 0.6em; }
    100%{ opacity:1; filter: blur(0px); letter-spacing: 0.12em; transform: scale(1); }
  }
  @keyframes pulseGlow{
    0%, 100%{
      text-shadow: 0 0 10px var(--glow), 0 0 25px var(--glow-soft), 0 0 60px var(--glow-soft), 0 0 120px var(--glow-faint);
    }
    50%{
      text-shadow: 0 0 16px var(--glow), 0 0 40px var(--glow-soft), 0 0 90px var(--glow-soft), 0 0 160px var(--glow-faint);
    }
  }
  @keyframes fadeInSlight{
    from{ opacity:0; transform:translateY(6px); }
    to{ opacity:1; transform:translateY(0); }
  }
  .vignette{
    position:absolute; inset:0;
    background: radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.75) 100%);
    pointer-events:none;
    z-index:3;
  }
  .flicker-overlay{
    position:absolute; inset:0;
    background: var(--glow-faint);
    opacity:0;
    pointer-events:none;
    animation: flicker 0.15s steps(1) 3;
    animation-delay: 0.55s;
  }
  @keyframes flicker{ 0%{opacity:0;} 50%{opacity:0.15;} 100%{opacity:0;} }

  .impostor-list{
    position:relative;
    z-index:2;
    list-style:none;
    margin: 2.2rem 0 0;
    padding:0;
    display:flex;
    flex-wrap:wrap;
    gap:0.6rem 1rem;
    justify-content:center;
    max-width:70vw;
  }
  .impostor-list li{
    opacity:0;
    padding: 0.35rem 0.9rem;
    border: 1px solid var(--glow-soft);
    border-radius: 999px;
    color: #ddf6ff;
    font-size: 0.95rem;
    letter-spacing: 0.05em;
    background: rgba(26, 200, 255, 0.07);
    text-shadow: 0 0 8px var(--glow-soft);
    animation: nameFadeIn 0.6s ease forwards;
  }
  @keyframes nameFadeIn{
    from{ opacity:0; transform:translateY(8px); }
    to{ opacity:1; transform:translateY(0); }
  }
</style>
</head>
<body>
  <div class="stage">
    <div class="particles" id="particles"></div>
    <div class="horizon"></div>
    <div class="line"></div>
    <div class="flicker-overlay"></div>
    <div class="content">
      <span class="eyebrow">${data.gameState.winCondition}</span>
      <h1>Crewmates Won</h1>
      <ul class="impostor-list">
${listItems}
      </ul>
    </div>
    <div class="vignette"></div>
    ${buildRestartControls(isHost, '#1ac8ff')}
  </div>

<script>
  const container = document.getElementById('particles');
  const count = 60;
  for(let i=0;i<count;i++){
    const p = document.createElement('div');
    p.className = 'particle';
    const size = Math.random()*2 + 1;
    p.style.width = size+'px';
    p.style.height = size+'px';
    p.style.left = Math.random()*100 + 'vw';
    p.style.top = Math.random()*100 + 'vh';
    p.style.animationDuration = (6 + Math.random()*10) + 's';
    p.style.animationDelay = (Math.random()*8) + 's';
    container.appendChild(p);
  }
</script>
</body>
</html>`;
}


export {
  renderImpostorWinHtml,
  renderCrewmateWinHtml,
  getImpostorNames
};