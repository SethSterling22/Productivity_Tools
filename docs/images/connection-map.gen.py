BG="#0d0d0d"; PANEL="#161616"; LIME="#bcbf56"; CORAL="#f27e63"
TEXT="#ededed"; MUTED="#8f8f84"; CLUSTER="#111111"; CB="#2e2e2e"; LINE="#71716a"
MONO="DejaVu Sans Mono, monospace"
W,H = 1620,1045
out=[]
def esc(s): return s.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")
def cluster(x,y,w,h,label):
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{CLUSTER}" stroke="{CB}" stroke-width="1.2"/>')
    out.append(f'<text x="{x+14}" y="{y+23}" font-family="{MONO}" font-size="13" fill="{MUTED}" letter-spacing="1.5">{esc(label.upper())}</text>')
def box(x,y,w,h,title,subs=(),accent=LIME):
    if isinstance(subs,str): subs=(subs,)
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="4" fill="{PANEL}" stroke="{accent}" stroke-width="1.3"/>')
    ty = y+24 if len(subs)<2 else y+22
    out.append(f'<text x="{x+w/2}" y="{ty}" text-anchor="middle" font-family="{MONO}" font-size="15" fill="{TEXT}" font-weight="bold">{esc(title)}</text>')
    for i,s in enumerate(subs):
        out.append(f'<text x="{x+w/2}" y="{ty+19+i*17}" text-anchor="middle" font-family="{MONO}" font-size="12.5" fill="{MUTED}">{esc(s)}</text>')
    return {"cx":x+w/2,"cy":y+h/2,"t":y,"b":y+h,"l":x,"r":x+w}
def edge(pts,label=None,lx=None,ly=None,dash=False):
    d="M "+" L ".join(f"{px} {py}" for px,py in pts)
    da=' stroke-dasharray="6 5"' if dash else ''
    out.append(f'<path d="{d}" fill="none" stroke="{LINE}" stroke-width="1.6"{da} marker-end="url(#ar)"/>')
    if label:
        tw=len(label)*7.1+12
        out.append(f'<rect x="{lx-tw/2}" y="{ly-11}" width="{tw}" height="21" rx="3" fill="{BG}" stroke="{CB}" stroke-width="0.8"/>')
        out.append(f'<text x="{lx}" y="{ly+4}" text-anchor="middle" font-family="{MONO}" font-size="12.5" fill="{MUTED}">{esc(label)}</text>')

out.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">')
out.append(f'<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="{LINE}"/></marker></defs>')
out.append(f'<rect width="{W}" height="{H}" fill="{BG}"/>')
out.append(f'<text x="40" y="46" font-family="{MONO}" font-size="25" fill="{TEXT}" font-weight="bold">REBECA — connection map</text>')
out.append(f'<text x="40" y="70" font-family="{MONO}" font-size="13.5" fill="{MUTED}">self-hosted assistant · channels, LLMs, data stores, APIs and homelab nodes</text>')

# tier 1 — channels
cluster(530,98,560,98,"channels")
tg=box(550,128,160,54,"Telegram","text + voice",CORAL)
gw=box(730,128,160,54,"Galaxy Watch","voice-first",CORAL)
db=box(910,128,160,54,"Dashboard","browser",CORAL)
# tier 2 — tailscale edge
cluster(440,236,740,106,"tailscale edge — ocra-n8n")
f443=box(460,268,220,58,"Funnel :443","public · Telegram webhook")
f10k=box(700,268,220,58,"Funnel :10000","public · watch token")
srv =box(940,268,220,58,"Serve :8443","tailnet · Google OAuth")
# tier 3 — core services
cluster(400,386,820,152,"core services — docker · ocra")
n8n=box(420,418,230,76,"n8n",("Telegram router","tool webhooks"))
ac =box(690,418,250,76,"assistant-core",("Rebeca — agent loop","model router · auth gate"))
hm =box(980,418,220,76,"Hermes gateway","brain · fs · shell")
out.append(f'<text x="700" y="522" text-anchor="middle" font-family="{MONO}" font-size="12.5" fill="{MUTED}">n8n &#8646; assistant-core · webhooks :5678 / X-Internal-Token</text>')
out.append(f'<text x="1090" y="522" text-anchor="middle" font-family="{MONO}" font-size="12.5" fill="{MUTED}">assistant-core &#8594; Hermes · localhost :8080</text>')
# tier 4 — row A
cluster(40,600,470,215,"llms — task router, local-first")
box(60,640,430,54,"Ollama · omarchy (8 GB)","qwen3:8b · deepseek-r1:8b · qwen2.5-coder:7b")
box(60,704,430,54,"Ollama · Sadida (4 GB)","qwen3:1.7b · deepseek-r1:1.5b · qwen2.5-coder:3b")
box(60,762,430,48,"Claude API","claude-sonnet-5-5 — last resort",CORAL)
cluster(545,600,290,215,"data stores")
box(565,640,250,62,"PostgreSQL",("chat memory","sessions"))
box(565,718,250,62,"Qdrant","vectors — RAG 768d")
cluster(870,600,690,215,"integrations & apis")
box(890,640,330,54,"Linear API","GraphQL — tasks · projects · subtasks")
box(1230,640,310,54,"Google Calendar","OAuth2 — events")
box(890,704,215,54,"SearXNG","web search")
box(1115,704,215,54,"Nextcloud · Aery","WebDAV / OCS")
box(1340,704,200,54,"Prometheus","PromQL")
# tier 4 — row B
cluster(40,855,470,145,"voice — sadida only")
box(60,893,215,72,"Whisper STT","speech → text")
box(295,893,195,72,"Piper TTS","text → speech")
cluster(545,855,290,145,"homelab nodes — ssh")
box(565,893,250,72,"7 nodes",("ocra · sadida · omarchy · aery","sram · sacro · xelor"))
cluster(870,855,690,145,"second brain")
vault=box(890,893,310,72,"Git vault (Markdown)",("Obsidian vault","auto-indexed → Qdrant"))
ghb  =box(1240,893,300,72,"GitHub",("two-way sync","every 15 min"))

# ── edges ──
edge([(tg["cx"],tg["b"]),(tg["cx"],220),(f443["cx"],220),(f443["cx"],f443["t"])])
edge([(gw["cx"],gw["b"]),(gw["cx"],220),(f10k["cx"],220),(f10k["cx"],f10k["t"])])
edge([(db["cx"],db["b"]),(db["cx"],220),(srv["cx"],220),(srv["cx"],srv["t"])])
edge([(f443["cx"],f443["b"]),(f443["cx"],368),(n8n["cx"],368),(n8n["cx"],n8n["t"])])
edge([(f10k["cx"],f10k["b"]),(f10k["cx"],368),(ac["cx"],368),(ac["cx"],ac["t"])])
edge([(srv["cx"],srv["b"]),(srv["cx"],368),(ac["cx"]+70,368),(ac["cx"]+70,ac["t"])])
edge([(n8n["r"],440),(ac["l"],440)])
edge([(ac["l"],472),(n8n["r"],472)])
edge([(ac["r"],456),(hm["l"],456)])
edge([(740,538),(740,565),(275,565),(275,600)],"/api/chat · embeddings",430,565)
edge([(820,538),(820,600)],"memory · vectors",820,572)
edge([(900,538),(900,578),(1180,578),(1180,600)],"JSON · WebDAV · PromQL",1070,578)
edge([(490,538),(490,558),(1400,558),(1400,600)],"GraphQL · OAuth2",1265,558)
edge([(780,538),(780,542),(20,542),(20,929),(60,929)],"audio",300,542)
edge([(860,538),(860,568),(527,568),(527,929),(565,929)],"SSH exec / PTY",640,568)
edge([(hm["r"],456),(1600,456),(1600,929),(ghb["r"],929)],"read/write + git push",1410,456)
edge([(vault["r"],929),(ghb["l"],929)])
out.append('</svg>')
open('/tmp/diag/map.svg','w').write("\n".join(out))
