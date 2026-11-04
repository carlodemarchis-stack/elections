/* The shared top bar of the sub-pages. Load it first thing inside <body>:
     <script src="../nav.js" data-page="sources" data-ctx="Every source vs the result" data-chambers></script>
   data-page is the tab to highlight (scorecard | sources | guide); data-chambers adds an empty chamber switch
   (#chambers) for the page to fill. The map page has the same bar inline in index.html: change them together. */
(() => {
  const me = document.currentScript, d = me.dataset;
  const TABS = [['map', 'Map', '../'], ['scorecard', 'Scorecard', '../scorecard/'], ['sources', 'Every source', '../sources/'], ['guide', 'Guide', '../help/']];
  const APPS = [
    ['Formula 1','A season read lap by lap','#00d7b6','https://f1.aguywithascarf.com'],
    ['Tennis','The season, one player at a time','#f2c14e','https://tennis.aguywithascarf.com'],
    ['Football','Season towers, top 5 leagues','#2f9e58','https://top5.aguywithascarf.com'],
    ['NFL','Wins up, losses down','#4d94e0','https://nfl.aguywithascarf.com'],
    ['NBA','Season film and towers','#e0453f','https://nba.aguywithascarf.com'],
    ['NHL','Season film and towers','#2a9fd8','https://nhl.aguywithascarf.com'],
    ['World Cup','Road to the Final','#3fbe72','https://worldcupbracket.aguywithascarf.com'],
    ['PGA TOUR','Season Film','#57a34a','https://golf.aguywithascarf.com'],
    ['Athletics','World Record Film','#d98a3d','https://athletics.aguywithascarf.com']
  ];
  document.write(`<div id="topbar">
  <div id="ctx"><b>US Midterms 2026</b> · <span id="status">${d.ctx || ''}</span></div>
  ${d.chambers !== undefined ? '<div class="seg" id="chambers" role="tablist" aria-label="Chamber"></div>' : ''}
  ${TABS.map(([id, label, href]) => `<a class="pill${d.page === id ? ' on' : ''}" href="${href}">${label}</a>`).join('\n  ')}
  <button class="ic" id="moreBtn" title="More sports experiences" aria-label="More sports experiences"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
  <button class="ic" id="fsBtn" title="Fullscreen (f)" aria-label="Fullscreen"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5"/></svg></button>
  <div id="credit">Data: <a href="https://civicapi.org" target="_blank" rel="noopener">civicAPI</a><a class="agwas-ver" data-agwas-ver="midterms" href="https://dataviz.aguywithascarf.com/releases/#midterms"></a></div>
</div>
<div class="mod" id="mmodal" aria-hidden="true">
  <div class="mbox" role="dialog" aria-label="More sports experiences">
    <h3>More sports experiences</h3>
    <div class="applist">${APPS.map(a => `<a class="approw" href="${a[3]}" target="_blank" rel="noopener"><i style="background:${a[2]}"></i><span>${a[0]}<em>${a[1]}</em></span><span>↗</span></a>`).join('')}</div>
    <p style="margin-top:12px"><a href="https://dataviz.aguywithascarf.com" target="_blank" rel="noopener">See them all →</a></p>
  </div>
</div>`);
  document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('mmodal'), open = on => { modal.classList.toggle('on', on); modal.setAttribute('aria-hidden', on ? 'false' : 'true'); };
    document.getElementById('moreBtn').addEventListener('click', () => open(true));
    modal.addEventListener('click', e => { if (e.target === modal) open(false); });
    addEventListener('keydown', e => { if (e.key === 'Escape') open(false); });
    const fs = document.getElementById('fsBtn');
    if (document.documentElement.requestFullscreen) fs.addEventListener('click', () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}));
    else fs.hidden = true;
  });
})();
