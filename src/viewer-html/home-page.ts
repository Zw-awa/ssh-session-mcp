import {
  sessions, escapeHtml, sessionDisplayName, getViewerBaseUrl,
  LOCAL_MODE, DEFAULT_VIEWER_REFRESH_MS,
} from '../server-state.js';
import { renderViewerDocument } from './page-shell.js';
import { HOME_PAGE_STYLES } from './page-styles.js';

function idleMinutes(updatedAt: string) { return Math.round((Date.now() - Date.parse(updatedAt)) / 60000); }
function badgeClass(m: number) { return m < 1 ? 'sb-active' : m < 5 ? 'sb-idle' : 'sb-stale'; }
function badgeLabel(m: number) { return m < 1 ? 'active' : m === 1 ? '1m idle' : m + 'm idle'; }

function buildClientScript(debug: boolean, baseUrl: string, refreshMs: number): string {
  const lines: string[] = [];
  const B = (s: string) => JSON.stringify(s);
  const D = String(debug);
  const BU = B(baseUrl);
  const RM = String(refreshMs);

  lines.push('var refreshMs=' + RM + ',debug=' + D + ',timer=null;');
  lines.push('function sr(){if(timer)clearTimeout(timer);timer=setTimeout(refresh,refreshMs);}');
  lines.push('function cs(id){if(!confirm("Close this session?"))return;fetch("/api/session/"+encodeURIComponent(id)+"/close",{method:"POST"}).then(r=>r.json()).then(d=>{if(d.ok)refresh();}).catch(()=>refresh());}');
  lines.push('function nls(){fetch("/api/sessions",{method:"POST"}).then(r=>r.json()).then(d=>{if(d.ok&&d.session)refresh();else alert("Failed: "+JSON.stringify(d));}).catch(e=>alert("Error: "+e.message));}');
  lines.push('function sac(id,el){var c=el.value.trim();if(!c)return;el.value="";fetch("/api/session/"+encodeURIComponent(id)+"/agent-input",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({command:c})}).then(r=>r.json()).then(d=>{if(!d.ok)alert(d.error||"Failed");else{var det=document.getElementById("detail-"+id);if(det&&det.style.display==="block"){det.innerHTML=\'<div style="color:#91a0b3;padding:8px 0">Refreshing...</div>\';Promise.all([fetch("/api/session/"+encodeURIComponent(id)+"/diagnostics").then(r=>r.json()),fetch("/api/session/"+encodeURIComponent(id)+"/history?maxLines=20").then(r=>r.json())]).then(function(r){var diag=r[0],hist=r[1],h="";h+=\'<div style="font-weight:700;color:#72d6d1;margin-bottom:4px">Diagnostics</div>\';h+=\'<div style="font-size:12px;color:#91a0b3;margin-bottom:8px">Terminal: \'+e(diag.terminalMode||"unknown");if(diag.runningCommand)h+=" | Running: "+e(diag.runningCommand.program||diag.runningCommand.commandId)+" ("+e(diag.runningCommand.status)+")";if(diag.session&&diag.session.inputLock&&diag.session.inputLock!=="none")h+=" | Lock: "+e(diag.session.inputLock);h+="</div>";if(diag.warnings&&diag.warnings.length>0){h+=\'<div style="font-size:12px;margin-bottom:8px">\';for(var w=0;w<diag.warnings.length;w++){var wn=diag.warnings[w];h+=\'<div style="color:\'+(wn.severity==="warning"?"#ffb84d":"#91a0b3")+\'">\'+e("["+wn.severity+"] "+wn.message)+"</div>";}h+="</div>";}h+=\'<div style="font-size:11px;color:#5a6b7d;margin-bottom:12px">Buffer: \'+e(String(diag.buffers.bufferStart)+"-"+String(diag.buffers.bufferEnd))+" | Events: "+e(String(diag.buffers.eventStartSeq)+"-"+String(diag.buffers.eventEndSeq))+" | History: "+e(String(diag.buffers.historyLineStart)+"-"+String(diag.buffers.historyLineEnd))+"</div>";h+=\'<div style="font-weight:700;color:#72d6d1;margin-bottom:4px">Recent History</div>\';if(hist.lines&&hist.lines.length>0){h+=\'<pre style="font-size:11px;color:#e6edf3;background:rgba(0,0,0,0.3);padding:8px;border-radius:4px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:0">\';for(var hi=0;hi<hist.lines.length;hi++){var ln=hist.lines[hi];var p=ln.type==="input"?" \\u25b6 ":ln.type==="control"?" \\u25b8 ":ln.type==="lifecycle"?" \\u25c9 ":"   ";h+=e(String(ln.line).padStart(5," ")+p+ln.text)+"\\n";}h+="</pre>";}else{h+=\'<div style="font-size:12px;color:#91a0b3">(no history yet)</div>\';}det.innerHTML=h;}).catch(function(){det.innerHTML=\'<div style="color:#f85149;padding:8px 0">Failed to load details.</div>\';});}}}).catch(e=>alert("Error: "+e.message));}');
  lines.push('function sck(id,key){fetch("/api/session/"+encodeURIComponent(id)+"/control",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:key})}).catch(()=>{});}');
  lines.push('function sa(id){fetch("/api/session/"+encodeURIComponent(id)+"/set-active",{method:"POST"}).then(r=>r.json()).then(d=>{if(d.ok)refresh();}).catch(()=>{});}');

  // toggleDetails
  lines.push('function td(id,btn){var d=document.getElementById("detail-"+id);if(!d)return;');
  lines.push('if(d.style.display==="block"){d.style.display="none";btn.textContent="Details";return;}');
  lines.push('d.style.display="block";d.innerHTML=\'<div style="color:#91a0b3;padding:8px 0">Loading...</div>\';btn.textContent="Hide";');
  lines.push('Promise.all([fetch("/api/session/"+encodeURIComponent(id)+"/diagnostics").then(r=>r.json()),');
  lines.push('fetch("/api/session/"+encodeURIComponent(id)+"/history?maxLines=20").then(r=>r.json())])');
  lines.push('.then(function(r){var diag=r[0],hist=r[1],h="";');
  lines.push('h+=\'<div style="font-weight:700;color:#72d6d1;margin-bottom:4px">Diagnostics</div>\';');
  lines.push('h+=\'<div style="font-size:12px;color:#91a0b3;margin-bottom:8px">Terminal: \'+e(diag.terminalMode||"unknown");');
  lines.push('if(diag.runningCommand)h+=" | Running: "+e(diag.runningCommand.program||diag.runningCommand.commandId)+" ("+e(diag.runningCommand.status)+")";');
  lines.push('if(diag.session&&diag.session.inputLock&&diag.session.inputLock!=="none")h+=" | Lock: "+e(diag.session.inputLock);h+="</div>";');
  lines.push('if(diag.warnings&&diag.warnings.length>0){h+=\'<div style="font-size:12px;margin-bottom:8px">\';for(var w=0;w<diag.warnings.length;w++){var wn=diag.warnings[w];h+=\'<div style="color:\'+(wn.severity==="warning"?"#ffb84d":"#91a0b3")+\'">\'+e("["+wn.severity+"] "+wn.message)+"</div>";}h+="</div>";}');
  lines.push('h+=\'<div style="font-size:11px;color:#5a6b7d;margin-bottom:12px">Buffer: \'+e(String(diag.buffers.bufferStart)+"-"+String(diag.buffers.bufferEnd))+" | Events: "+e(String(diag.buffers.eventStartSeq)+"-"+String(diag.buffers.eventEndSeq))+" | History: "+e(String(diag.buffers.historyLineStart)+"-"+String(diag.buffers.historyLineEnd))+"</div>";');
  lines.push('h+=\'<div style="font-weight:700;color:#72d6d1;margin-bottom:4px">Recent History</div>\';');
  lines.push('if(hist.lines&&hist.lines.length>0){h+=\'<pre style="font-size:11px;color:#e6edf3;background:rgba(0,0,0,0.3);padding:8px;border-radius:4px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all;margin:0">\';');
  lines.push('for(var hi=0;hi<hist.lines.length;hi++){var ln=hist.lines[hi];var p=ln.type==="input"?" \\u25b6 ":ln.type==="control"?" \\u25b8 ":ln.type==="lifecycle"?" \\u25c9 ":"   ";h+=e(String(ln.line).padStart(5," ")+p+ln.text)+"\\n";}h+="</pre>";}');
  lines.push('else{h+=\'<div style="font-size:12px;color:#91a0b3">(no history yet)</div>\';}');
  lines.push('d.innerHTML=h;}).catch(function(){d.innerHTML=\'<div style="color:#f85149;padding:8px 0">Failed to load details.</div>\';});}');

  // escape helper, badge helpers, renderCards
  lines.push('function e(t){var d=document.createElement("div");d.appendChild(document.createTextNode(t));return d.innerHTML;}');
  lines.push('function sc(m){return m<1?"sb-active":m<5?"sb-idle":"sb-stale";}');
  lines.push('function sl(m){return m<1?"active":m===1?"1m idle":m+"m idle";}');

  // renderCards
  lines.push('var asr=null;');  // activeSessionRef
  lines.push('function bck(sid,q){var ks=["ctrl_c","ctrl_d","enter","up","down","left","right","backspace","tab","esc"],ls=["C-c","C-d","Enter","\\u2191","\\u2193","\\u2190","\\u2192","BS","Tab","Esc"],h=\'<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">\';');
  lines.push('for(var i=0;i<ks.length;i++)h+=\'<button class="btn" onclick="sck(\'+q+sid+q+\',\'+q+ks[i]+q+\')">\'+ls[i]+\'</button>\';');
  lines.push('h+=\'<button class="btn" onclick="sa(\'+q+sid+q+\')" style="margin-left:8px">Set Active</button></div>\';return h;}');
  lines.push('function rc(ss,asr){var bu=' + BU + ',q="\'";if(!ss||ss.length===0)return \'<div class="empty-state">No active SSH sessions</div>\';');
  lines.push('return ss.map(function(s){');
  lines.push('var tu=bu+"/terminal/session/"+encodeURIComponent(s.sessionId);');
  lines.push('var m=Math.round((Date.now()-Date.parse(s.updatedAt))/60000);');
  lines.push('var dev=s.deviceId?" \\u2022 device="+e(s.deviceId):"";');
  lines.push('var cn=s.connectionName?" \\u2022 connection="+e(s.connectionName):"";');
  lines.push('var lk=s.inputLock==="agent"?\'<span class="status-badge sb-locked">AI active</span>\':s.inputLock==="user"?\'<span class="status-badge sb-locked">user only</span>\':"";');
  lines.push('var act=asr&&s.sessionRef===asr?\'<span class="status-badge sb-active-star" style="background:#6dd3ce;color:#08242a">\\u2605 active</span>\':"";');
  lines.push('var dd=\'<div id="detail-\'+e(s.sessionId)+\'" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)"></div>\';');
  lines.push('var ai=debug?\'<div style="margin-top:10px;display:flex;gap:6px"><input id="agentCmd-\'+e(s.sessionId)+\'" placeholder="Command as agent..." style="flex:1;padding:4px 8px;border:1px solid var(--line);border-radius:4px;background:var(--panel);color:var(--text);font:inherit;font-size:12px" onkeydown="if(event.key===\'+q+\'Enter\'+q+\'){sac(\'+q+e(s.sessionId)+q+\',this);event.preventDefault()}"><button class="btn" onclick="sac(\'+q+e(s.sessionId)+q+\',document.getElementById(\'+q+\'agentCmd-\'+e(s.sessionId)+q+\'))">Send</button></div>\':"";');
  lines.push('var ck=debug?bck(e(s.sessionId),q):"";');
  lines.push('return \'<div class="session-card" id="card-\'+e(s.sessionId)+\'"><div class="session-header"><div><div class="session-title">\'+e(s.sessionName||s.sessionRef||s.sessionId)+\' <span class="status-badge sb-badge \'+sc(m)+\'">\'+sl(m)+\'</span>\'+lk+act+\'</div><div class="session-meta">\'+e(s.user)+\'@\'+e(s.host)+\':\'+s.port+dev+cn+\'</div></div><div class="session-actions"><a href="\'+tu+\'" class="btn btn-primary" target="_blank">Terminal</a><button class="btn" onclick="td(\'+q+e(s.sessionId)+q+\',this)" style="margin-left:4px">Details</button><button class="btn btn-danger" onclick="cs(\'+q+e(s.sessionId)+q+\')" style="margin-left:4px">Close</button></div></div><div class="session-meta sb-stats">Created: \'+new Date(s.createdAt).toLocaleString()+\' \\u2022 Last activity: \'+new Date(s.updatedAt).toLocaleString()+(s.idleExpiresAt?" \\u2022 Idle expires: "+new Date(s.idleExpiresAt).toLocaleString():"")+\'</div>\'+dd+ai+ck+\'</div>\';');
  lines.push('}).join("");}');

  // refresh with soft updates
  lines.push('var prevIds="";');
  lines.push('function refresh(){fetch("/api/sessions").then(r=>r.json()).then(function(data){asr=data.activeSessionRef;var c=document.getElementById("sessions");if(!c){sr();return;}');
  lines.push('var ids=(data.sessions||[]).map(function(s){return s.sessionId;}).sort().join(",");');
  lines.push('if(ids!==prevIds){prevIds=ids;var open={};c.querySelectorAll("[id^=\\"detail-\\"]").forEach(function(d){if(d.style.display==="block")open[d.id.replace("detail-","")]=d.innerHTML;});');
  lines.push('var n=rc(data.sessions,asr);c._lh=n;c.innerHTML=n;');
  lines.push('for(var id in open){var d=document.getElementById("detail-"+id);if(d){d.style.display="block";d.innerHTML=open[id];}var b=c.querySelector("[onclick*=\\"td(\'"+id+"\'\\"]");if(b)b.textContent="Hide";}}');
  lines.push('else{(data.sessions||[]).forEach(function(s){var card=document.getElementById("card-"+s.sessionId);if(!card)return;');
  lines.push('var m=Math.round((Date.now()-Date.parse(s.updatedAt))/60000);');
  lines.push('var bd=card.querySelector(".sb-badge");if(bd){bd.className="status-badge sb-badge "+sc(m);bd.textContent=sl(m);}');
  lines.push('var lk=card.querySelector(".sb-locked");');
  lines.push('if(s.inputLock==="agent"){if(!lk){var t=card.querySelector(".session-title");if(t){var sp=document.createElement("span");sp.className="status-badge sb-locked";sp.textContent="AI active";t.appendChild(sp);}}}');
  lines.push('else if(s.inputLock==="user"){if(!lk){var t=card.querySelector(".session-title");if(t){var sp=document.createElement("span");sp.className="status-badge sb-locked";sp.textContent="user only";t.appendChild(sp);}}}');
  lines.push('else{if(lk)lk.remove();}');
  lines.push('var st=card.querySelector(".sb-stats");if(st){st.textContent="Created: "+new Date(s.createdAt).toLocaleString()+" \\u2022 Last activity: "+new Date(s.updatedAt).toLocaleString()+(s.idleExpiresAt?" \\u2022 Idle expires: "+new Date(s.idleExpiresAt).toLocaleString():"");}');
  lines.push('var act=card.querySelector(".sb-active-star");if(asr&&s.sessionRef===asr){if(!act){var t=card.querySelector(".session-title");if(t){var sp=document.createElement("span");sp.className="status-badge sb-active-star";sp.style="background:#6dd3ce;color:#08242a";sp.textContent="\\u2605 active";t.appendChild(sp);}}}else{if(act)act.remove();}');
  lines.push('});}sr();}).catch(function(){sr();});}');
  lines.push('sr();window.addEventListener("pagehide",function(){if(timer)clearTimeout(timer);},{once:true});');

  return lines.join('\n');
}

export function renderViewerHomePage(debug = false) {
  const baseUrl = getViewerBaseUrl() || '';
  const refreshMs = DEFAULT_VIEWER_REFRESH_MS;

  const cards = (() => {
    const list = [...sessions.values()].filter(s => !s.closed).map(s => ({ ...s.summary(), lock: s.inputLock })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (list.length === 0) return '<div class="empty-state">No active SSH sessions</div>';
    return list.map(s => {
      const tu = baseUrl + '/terminal/session/' + encodeURIComponent(s.sessionId);
      const m = idleMinutes(s.updatedAt);
      const lk = s.lock === 'agent' ? 'AI active' : s.lock === 'user' ? 'user only' : '';
      return [
        '<div class="session-card"><div class="session-header"><div>',
        '<div class="session-title">' + escapeHtml(sessionDisplayName(s)) + ' <span class="status-badge ' + badgeClass(m) + '">' + badgeLabel(m) + '</span>' + (lk ? '<span class="status-badge sb-locked">' + escapeHtml(lk) + '</span>' : '') + '</div>',
        '<div class="session-meta">' + s.user + '@' + s.host + ':' + s.port + (s.deviceId ? ' \u2022 device=' + escapeHtml(s.deviceId) : '') + (s.connectionName ? ' \u2022 connection=' + escapeHtml(s.connectionName) : '') + '</div>',
        '</div><div class="session-actions">',
        '<a href="' + tu + '" class="btn btn-primary" target="_blank">Terminal</a>',
        '<button class="btn" onclick="td(\'' + escapeHtml(s.sessionId) + '\',this)">Details</button>',
        '<button class="btn btn-danger" onclick="cs(\'' + escapeHtml(s.sessionId) + '\')">Close</button>',
        '</div></div>',
        '<div class="session-meta">Created: ' + new Date(s.createdAt).toLocaleString() + ' \u2022 Last activity: ' + new Date(s.updatedAt).toLocaleString() + (s.idleExpiresAt ? ' \u2022 Idle expires: ' + new Date(s.idleExpiresAt).toLocaleString() : '') + '</div>',
        '<div id="detail-' + escapeHtml(s.sessionId) + '" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)"></div>',
        debug ? '<div style="margin-top:10px;display:flex;gap:6px"><input id="agent-cmd-' + escapeHtml(s.sessionId) + '" placeholder="Command as agent..." style="flex:1;padding:4px 8px;border:1px solid var(--line);border-radius:4px;background:var(--panel);color:var(--text);font:inherit;font-size:12px" onkeydown="if(event.key===&apos;Enter&apos;){sac(&apos;' + escapeHtml(s.sessionId) + '&apos;,this);event.preventDefault()}"><button class="btn" onclick="sac(&apos;' + escapeHtml(s.sessionId) + '&apos;,document.getElementById(&apos;agent-cmd-' + escapeHtml(s.sessionId) + '&apos;))">Send</button></div>' : '',
        debug ? '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px"><button class="btn" onclick="sck(\'' + escapeHtml(s.sessionId) + '\',\'ctrl_c\')">C-c</button><button class="btn" onclick="sck(\'' + escapeHtml(s.sessionId) + '\',\'ctrl_d\')">C-d</button><button class="btn" onclick="sck(\'' + escapeHtml(s.sessionId) + '\',\'enter\')">Enter</button><button class="btn" onclick="sck(\'' + escapeHtml(s.sessionId) + '\',\'up\')">\u2191</button><button class="btn" onclick="sck(\'' + escapeHtml(s.sessionId) + '\',\'down\')">\u2193</button><button class="btn" onclick="sck(\'' + escapeHtml(s.sessionId) + '\',\'left\')">\u2190</button><button class="btn" onclick="sck(\'' + escapeHtml(s.sessionId) + '\',\'right\')">\u2192</button><button class="btn" onclick="sck(\'' + escapeHtml(s.sessionId) + '\',\'backspace\')">BS</button><button class="btn" onclick="sck(\'' + escapeHtml(s.sessionId) + '\',\'tab\')">Tab</button><button class="btn" onclick="sck(\'' + escapeHtml(s.sessionId) + '\',\'esc\')">Esc</button><button class="btn" onclick="sa(\'' + escapeHtml(s.sessionId) + '\')" style="margin-left:8px">Set Active</button></div>' : '',
        '</div>',
      ].join('');
    }).join('');
  })();

  return renderViewerDocument({
    title: 'SSH Session MCP Viewer',
    styles: HOME_PAGE_STYLES,
    headExtras: '',
    body: [
      '<header><h1>SSH Session MCP Viewer</h1><div class="subtitle">Real-time SSH session monitoring</div></header>',
      '<main>',
      LOCAL_MODE ? '<div style="margin-bottom:15px"><button class="btn btn-primary" onclick="nls()">+ New Local Session</button></div>' : '',
      '<div class="sessions" id="sessions">' + cards + '</div>',
      '</main>',
      '<footer><div>SSH Session MCP \u2022 Auto-refresh: ' + refreshMs + 'ms</div><div>Viewer base URL: <code>' + escapeHtml(baseUrl) + '</code></div></footer>',
    ].join('\n'),
    bodyExtras: '<script>\n' + buildClientScript(debug, baseUrl, refreshMs) + '\n</script>',
  });
}
