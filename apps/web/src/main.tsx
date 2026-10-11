import { useEffect, useState } from "react";
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api, bootstrap, clearPendingEvents, createQueue, getCatalog, getLikes, getMe, getProgram, minutes, nextQueue, requestDeletion, setLike, setPreferences, type Bootstrap, type ListeningSession, type Program } from "./api";
import { MiniPlayer, PlayerButton, PlayerProvider, usePlayer } from "./player";
import "./styles.css";

function App() {
  const [boot, setBoot] = useState<{ me: Bootstrap; session: ListeningSession } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void bootstrap().then(setBoot).catch((reason) => setError(reason instanceof Error ? reason.message : "暂时没连上，点这里再试一次")); }, []);
  if (error) return <main className="startup-error"><h1>声音时间机器</h1><p>{error}</p><button className="primary-button" onClick={() => location.reload()}>重新试一次</button></main>;
  if (!boot) return <main className="startup-error"><h1>声音时间机器</h1><p>正在准备收音机…</p></main>;
  return <PlayerProvider sessionId={boot.session.session_id} analyticsEnabled={boot.session.analytics_enabled}><BrowserRouter><Shell boot={boot.me} /></BrowserRouter></PlayerProvider>;
}

function Shell({ boot }: { boot: Bootstrap }) {
  const location = useLocation();
  return <div className="app-shell"><header><Link to="/" className="brand">声音时间机器</Link><span>熟悉的声音，慢慢听</span></header><main className="content"><Routes>
    <Route path="/" element={<Home boot={boot} />} /><Route path="/eras" element={<Eras />} /><Route path="/programs/:id" element={<Detail />} />
    <Route path="/me" element={<Me boot={boot} />} /><Route path="/me/likes" element={<Likes />} /><Route path="/me/preferences" element={<Preferences />} />
    <Route path="/privacy" element={<Privacy />} /><Route path="/admin" element={<Admin />} /><Route path="*" element={<Home boot={boot} />} />
  </Routes></main><MiniPlayer />
  {!location.pathname.startsWith("/admin") && <nav className="bottom-nav" aria-label="主导航"><NavLink to="/">今日电台</NavLink><NavLink to="/eras">年代声音</NavLink><NavLink to="/me">我的</NavLink></nav>}</div>;
}

function Home({ boot }: { boot: Bootstrap }) {
  const [program, setProgram] = useState<Program | null>(null); const [queueId, setQueueId] = useState<string | null>(null); const [notice, setNotice] = useState("想听哪个年代？可以换一换。");
  const player = usePlayer();
  const load = async () => {
    try {
      const session = await getMe();
      const response = await createQueue(player.sessionId, session.preferences.era, session.preferences.category, "today");
      if (response.result === "PROGRAM" && response.program) { setProgram(response.program); setQueueId(response.queue_id); setNotice("想听哪个年代？可以换一换。"); }
      else { setProgram(null); setNotice("这里还没有节目，换个年代试试。"); }
    } catch (error) { setNotice(error instanceof Error ? error.message : "暂时没连上，点这里再试一次"); }
  };
  useEffect(() => { void load(); }, []);
  const change = async () => {
    if (!queueId) return load();
    try {
      const response = await nextQueue(queueId);
      if (response.result === "PROGRAM" && response.program) { setProgram(response.program); setQueueId(response.queue_id); } else setNotice("这里暂时只有这段，换个年代试试。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "换节目失败，请重试。"); }
  };
  return <section className="radio-page"><p className="eyebrow">今日电台</p><div className="radio" aria-label="收音机"><div className="radio-speaker" /><div className="radio-dial">{program?.era_label ?? "正在找声音"}</div><div className="radio-knobs" aria-hidden="true"><i /><i /></div></div>
    {program ? <><Link to={`/programs/${program.id}`} className="program-card"><span>{program.era_label} · {program.category_label}</span><strong>{program.title}</strong><small>{minutes(program.duration_ms)}</small></Link><PlayerButton program={program} queueId={queueId} full /><button className="secondary-button" onClick={() => void change()}>换个节目</button></> : <><p className="notice">{notice}</p><button className="primary-button" onClick={() => void load()}>再试一次</button><Link className="secondary-link" to="/eras">选择年代</Link></>}
    <p className="hint">{notice}</p></section>;
}

function Eras() {
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof getCatalog>> | null>(null); const [era, setEra] = useState("all"); const [category, setCategory] = useState("all"); const [program, setProgram] = useState<Program | null>(null); const [queueId, setQueueId] = useState<string | null>(null); const [notice, setNotice] = useState(""); const player = usePlayer(); const loadGeneration = useState({ current: 0 })[0];
  useEffect(() => { void getCatalog().then(setCatalog).catch((error) => setNotice(error.message)); }, []);
  const categories = catalog?.combinations.filter((item) => era === "all" || item.era === era).map((item) => item.category) ?? [];
  const preview = async (nextEra = era, nextCategory = category) => {
    const generation = ++loadGeneration.current;
    try { const response = await createQueue(player.sessionId, nextEra, nextCategory, "era"); if (generation !== loadGeneration.current) return; if (response.result === "PROGRAM" && response.program) { setProgram(response.program); setQueueId(response.queue_id); setNotice(""); } else { setProgram(null); setNotice("这个年代暂时没有节目了。"); } } catch (error) { if (generation === loadGeneration.current) setNotice(error instanceof Error ? error.message : "暂时没连上。"); }
  };
  const chooseEra = (value: string) => { const nextCategory = value !== "all" && category !== "all" && !catalog?.combinations.some((item) => item.era === value && item.category === category) ? "all" : category; setEra(value); setCategory(nextCategory); void preview(value, nextCategory); };
  return <section><h1>想听哪个年代？</h1><p className="hint">先选一选，确认“就听这个”才会换声音。</p><OptionGroup label="年代" values={[{ value: "all", label: "都可以" }, ...(catalog?.eras ?? [])]} value={era} onChange={chooseEra} /><OptionGroup label="类型" values={[{ value: "all", label: "都可以" }, ...(catalog?.categories ?? []).filter((item) => category === "all" || categories.includes(item.value))]} value={category} onChange={(value) => { setCategory(value); void preview(era, value); }} />
    {program ? <div className="preview-card"><span>{program.era_label} · {program.category_label}</span><strong>{program.title}</strong><PlayerButton program={program} queueId={queueId} full /></div> : <p className="notice">{notice || "请选择年代和类型。"}</p>}</section>;
}

function OptionGroup({ label, values, value, onChange }: { label: string; values: Array<{ value: string; label: string }>; value: string; onChange: (value: string) => void }) { return <fieldset className="options"><legend>{label}</legend><div>{values.map((item) => <button key={item.value} className={value === item.value ? "option selected" : "option"} onClick={() => onChange(item.value)}>{item.label}</button>)}</div></fieldset>; }

function Detail() {
  const id = location.pathname.split("/").pop() ?? ""; const [program, setProgram] = useState<Program | null>(null); const [error, setError] = useState(""); const [copied, setCopied] = useState(false); const player = usePlayer();
  useEffect(() => { void getProgram(id).then(({ program: item }) => setProgram(item)).catch((reason) => setError(reason.message)); }, [id]);
  const toggleLike = async () => { if (!program) return; const before = program.is_liked; setProgram({ ...program, is_liked: !before }); try { await setLike(program.id, !before); } catch (reason) { setProgram({ ...program, is_liked: before }); setError(reason instanceof Error ? reason.message : "没保存上，再点一次试试。"); } };
  const share = async () => { const url = `${location.origin}/programs/${program?.id}?src=share`; try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setError(`请复制这个链接：${url}`); } };
  if (error && !program) return <section><h1>这段声音暂时不能听了</h1><p className="notice">{error}</p><Link className="primary-button" to="/">听听其他节目</Link></section>;
  if (!program) return <p>正在准备节目…</p>;
  const source = program.source_kind === "archive_original" ? "原声" : program.source_kind === "ai_reconstruction" ? "AI 重制" : "现代演绎";
  return <section className="detail"><Link to="/" className="back">返回今日电台</Link><p className="eyebrow">{program.era_label} · {program.category_label}</p><h1>{program.title}</h1><p className="source">{source}{program.display_year ? ` · ${program.display_year}年` : ""}</p><p>{program.source_note}</p><p className="progress">已听 {minutes(player.current?.id === program.id ? player.positionMs : 0)}／共 {minutes(program.duration_ms)}</p><PlayerButton program={program} full /><button className="secondary-button" onClick={() => void toggleLike()}>{program.is_liked ? "已喜欢" : "喜欢这个声音"}</button><button className="secondary-button" onClick={() => void share()}>分享给家人</button>{copied && <p className="hint">链接已复制，您可以发给家人。</p>}{error && <p className="notice">{error}</p>}</section>;
}

function Me({ boot }: { boot: Bootstrap }) { const [liked, setLiked] = useState(0); const [notice, setNotice] = useState(""); useEffect(() => { void getLikes().then((result) => setLiked(result.items.length)).catch(() => undefined); }, []); const clear = async () => { if (!confirm("清除后，本浏览器中的偏好和喜欢的声音可能找不回。确定清除吗？")) return; try { await requestDeletion(); clearPendingEvents(); location.reload(); } catch (error) { setNotice(error instanceof Error ? error.message : "暂时没能清除，请重试。"); } }; const copyProduct = async () => { try { await navigator.clipboard.writeText(location.origin); setNotice("产品链接已复制。"); } catch { setNotice("请复制地址栏中的链接。") } }; return <section><h1>我的收音机</h1><p className="hint">收听偏好和喜欢的声音会保存在这个浏览器中；清除浏览器数据后可能找不回。</p><Link className="menu-link" to="/me/likes">喜欢的声音 <span>{liked ? `${liked} 段` : ""}</span></Link><Link className="menu-link" to="/me/preferences">收听偏好</Link><button className="menu-link" onClick={() => void copyProduct()}>分享收音机</button><Link className="menu-link" to="/privacy">隐私说明</Link><button className="danger-link" onClick={() => void clear()}>清除我的数据</button>{boot.feature_flags.wechatEnabled && <p className="hint">微信登录已由安全配置启用。</p>}{notice && <p className="notice">{notice}</p>}</section>; }

function Likes() { const [items, setItems] = useState<Array<Program & { available: boolean }>>([]); const [notice, setNotice] = useState(""); const load = () => void getLikes().then((result) => setItems(result.items)).catch((error) => setNotice(error.message)); useEffect(load, []); const remove = async (program: Program) => { try { await setLike(program.id, false); load(); } catch (error) { setNotice(error instanceof Error ? error.message : "没保存上，再点一次试试。"); } }; return <section><Link to="/me" className="back">返回我的</Link><h1>喜欢的声音</h1>{!items.length ? <p className="notice">还没有喜欢的声音，听到喜欢的点一下爱心。</p> : items.map((program) => <article className="like-item" key={program.id}><div><strong>{program.title}</strong><span>{program.era_label} · {program.category_label}</span>{!program.available && <small>暂时无法收听</small>}</div>{program.available ? <Link className="secondary-link" to={`/programs/${program.id}`}>播放</Link> : null}<button className="secondary-button" onClick={() => void remove(program)}>取消喜欢</button></article>)}{notice && <p className="notice">{notice}</p>}</section>; }

function Preferences() { const [preferences, setLocal] = useState<Bootstrap["preferences"] | null>(null); const [notice, setNotice] = useState(""); useEffect(() => { void getMe().then((me) => setLocal(me.preferences)).catch((error) => setNotice(error.message)); }, []); if (!preferences) return <p>正在读取偏好…</p>; const save = async () => { try { await setPreferences(preferences); setNotice("已经保存，之后打开今日电台时会使用这个选择。"); } catch (error) { setNotice(error instanceof Error ? error.message : "暂时没保存上，请重试。"); } }; return <section><Link to="/me" className="back">返回我的</Link><h1>收听偏好</h1><OptionGroup label="常听年代" values={[{ value: "all", label: "都可以" }, { value: "1970s", label: "70年代" }, { value: "1980s", label: "80年代" }, { value: "1990s", label: "90年代" }, { value: "2000s", label: "00年代" }]} value={preferences.era} onChange={(era) => setLocal({ ...preferences, era: era as Bootstrap["preferences"]["era"] })} /><OptionGroup label="常听类型" values={[{ value: "all", label: "都可以" }, { value: "news", label: "新闻" }, { value: "storytelling", label: "评书" }, { value: "novel", label: "小说" }, { value: "opera", label: "戏曲" }]} value={preferences.category} onChange={(category) => setLocal({ ...preferences, category: category as Bootstrap["preferences"]["category"] })} /><label className="toggle"><input type="checkbox" checked={preferences.tuning_sound_enabled} onChange={(event) => setLocal({ ...preferences, tuning_sound_enabled: event.target.checked })} />打开换台音效（开发版尚无正式音效）</label><label className="toggle"><input type="checkbox" checked={preferences.analytics_enabled} onChange={(event) => setLocal({ ...preferences, analytics_enabled: event.target.checked })} />允许保存非必要收听数据，帮助改进产品</label><button className="primary-button" onClick={() => void save()}>保存</button>{notice && <p className="notice">{notice}</p>}</section>; }

function Privacy() { return <section><Link to="/me" className="back">返回我的</Link><h1>隐私说明</h1><p>本地开发版使用匿名游客身份提供收听、偏好和喜欢功能。不会收集手机号、联系人、位置或设备指纹。</p><p>非必要的收听统计默认关闭；您可以在“收听偏好”中打开或关闭。关闭后仍可收听和喜欢，但不会继续上传已排队的分析事件。</p><p>“清除我的数据”会撤销当前游客会话、删除偏好、喜欢、反馈与可关联分析事件。开发 fixture 和本地数据库不代表生产数据处理方案。</p></section>; }

function Admin() {
  const [token, setToken] = useState(""); const [items, setItems] = useState<Array<{ id: string; title: string; status: string; version: number }>>([]); const [notice, setNotice] = useState("运营入口需要服务端配置的本地令牌。"); const [file, setFile] = useState<File | null>(null); const [assetId, setAssetId] = useState(""); const [title, setTitle] = useState("开发示例：新节目草稿");
  const headers = () => ({ "x-admin-token": token });
  const load = async () => { try { const output = await api<{ items: Array<{ id: string; title: string; status: string; version: number }> }>("/admin/programs", { headers: headers() }); setItems(output.items); setNotice("已读取运营节目列表。"); } catch (error) { setNotice(error instanceof Error ? error.message : "无法读取运营数据。"); } };
  const upload = async () => { if (!file) return setNotice("请先选择 WAV 音频文件。"); try { const form = new FormData(); form.append("file", file); const uploaded = await api<{ asset_id: string }>("/admin/uploads", { method: "POST", headers: headers(), body: form }); const completed = await api<{ asset_id: string; duration_ms: number }>(`/admin/uploads/${uploaded.asset_id}/complete`, { method: "POST", headers: headers() }); setAssetId(completed.asset_id); setNotice(`音频已校验，可用时长 ${minutes(completed.duration_ms)}。`); } catch (error) { setNotice(error instanceof Error ? error.message : "上传或校验失败。"); } };
  const createDraft = async () => { if (!assetId) return setNotice("请先上传并校验音频。"); try { const created = await api<{ id: string }>("/admin/programs", { method: "POST", headers: headers(), body: JSON.stringify({ title, era: "1970s", category: "news", audio_asset_id: assetId, source_kind: "modern_performance", era_basis: "开发工作台人工选择的年代示例", source_note: "开发环境中的合成测试音，不对应真实节目。", is_excerpt: true, excerpt_label: "开发测试片段", source_url: "https://example.invalid/development-fixture", source_title: "开发 fixture 说明", source_type: "development_fixture", usage_basis: "development_fixture_only", evidence_ref: "本地测试 WAV；不可用于生产" }) }); setNotice(`草稿已创建：${created.id}`); await load(); } catch (error) { setNotice(error instanceof Error ? error.message : "创建草稿失败。"); } };
  const action = async (id: string, path: string, body?: unknown) => { try { await api(`/admin/programs/${id}/${path}`, { method: "POST", headers: headers(), body: body ? JSON.stringify(body) : undefined }); await load(); } catch (error) { setNotice(error instanceof Error ? error.message : "操作失败。"); } };
  return <section><h1>本地运营工作台</h1><p className="hint">仅用于开发验收；生产需替换为受控运营身份提供方。页面不保存令牌。</p><label>本地运营令牌<input value={token} onChange={(event) => setToken(event.target.value)} type="password" /></label><div className="admin-form"><h2>1. 上传并校验 WAV</h2><input type="file" accept="audio/wav,.wav" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><button className="secondary-button" onClick={() => void upload()}>上传并校验</button><h2>2. 创建草稿</h2><label>节目标题<input value={title} onChange={(event) => setTitle(event.target.value)} /></label><p className="hint">开发版示例固定为 70 年代新闻、现代演绎，并明确写入 fixture 来源／使用依据；真实发布前必须填入已核查资料。</p><button className="secondary-button" onClick={() => void createDraft()}>创建草稿</button></div><button className="primary-button" onClick={() => void load()}>读取节目</button><p className="notice">{notice}</p>{items.map((item) => <article className="admin-item" key={item.id}><strong>{item.title}</strong><span>{item.status} · 版本 {item.version}</span><div>{item.status === "draft" && <button onClick={() => void action(item.id, "submit")}>送审</button>}{item.status === "in_review" && <><button onClick={() => void action(item.id, "review", { decision: "approved" })}>审核通过</button><button onClick={() => void action(item.id, "publish")}>发布</button></>}{item.status === "published" && <button onClick={() => void action(item.id, "offline")}>下架</button>}</div></article>)}</section>;
}

import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(<App />);
