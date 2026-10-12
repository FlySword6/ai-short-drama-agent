import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, ArrowUpRight, Box, ChevronRight, Clapperboard, Command, FileText, Film, House, Images, Menu, Plus, Search, Settings2, Workflow, X } from 'lucide-react';
import { Brand, Modal, Tag, Toast } from './components';
import { AssetPage, FlowPage, ScriptPage, SettingsPage, StoryboardPage, Studio } from './pages';
import { readDraft, saveDraft, type Draft, type Page } from './model';
import ProductionPage from './production';

const DirectorWorkspace = lazy(() => import('./director/DirectorWorkspace'));

const navigation = [
  { id: 'studio' as Page, label: '创作首页', en: 'Studio', icon: House },
  { id: 'production' as Page, label: '真实项目', en: 'Production', icon: Film },
  { id: 'script' as Page, label: '剧本工作区', en: 'Script', icon: FileText },
  { id: 'storyboard' as Page, label: '分镜工作台', en: 'Storyboard', icon: Clapperboard },
  { id: 'director' as Page, label: '3D 导演台', en: 'Director', icon: Box },
  { id: 'assets' as Page, label: '视觉参考库', en: 'Visuals', icon: Images },
];
const commands = [...navigation, { id: 'flow' as Page, label: '短剧制作流程', en: 'Workflow', icon: Workflow }, { id: 'settings' as Page, label: '工作台设置', en: 'Settings', icon: Settings2 }];
function routeFromHash(): { page: Page; step: number } {
  const oldStep = /^#step-([1-9])$/.exec(location.hash);
  if (oldStep) return { page: 'flow', step: Number(oldStep[1]) };
  const [page, value] = location.hash.replace(/^#\/?/, '').split('/');
  return { page: commands.some(item => item.id === page) ? page as Page : 'studio', step: /^[1-9]$/.test(value ?? '') ? Number(value) : 1 };
}

export default function App() {
  const [{ draft: loaded, error: storageError }] = useState(readDraft);
  const [draft, setDraft] = useState(loaded);
  const [route, setRoute] = useState(routeFromHash);
  const [mobileNav, setMobileNav] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((text: string) => {
    if (timer.current) clearTimeout(timer.current);
    setToast(text); timer.current = setTimeout(() => setToast(''), 4500);
  }, []);
  useEffect(() => {
    if (storageError) notify('本地草稿无法读取，现显示参考样例；原保存内容尚未改动。');
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [storageError, notify]);
  useEffect(() => {
    const change = () => { setRoute(routeFromHash()); setMobileNav(false); window.scrollTo({ top: 0 }); };
    const keys = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(value => !value); }
      if (event.key === 'Escape') setMobileNav(false);
    };
    window.addEventListener('hashchange', change); window.addEventListener('keydown', keys);
    return () => { window.removeEventListener('hashchange', change); window.removeEventListener('keydown', keys); };
  }, []);
  function go(page: Page, step?: number) {
    const hash = `#/${page}${page === 'flow' ? `/${step ?? 1}` : ''}`;
    if (location.hash === hash) setMobileNav(false);
    else location.hash = hash;
  }
  function save(next: Draft = draft) {
    try { const saved = saveDraft(next); setDraft(saved); notify(`已保存到本浏览器 · 草稿 V${saved.revision}`); }
    catch { notify('未能保存，浏览器存储可能不可用或已满。请导出草稿留存。'); }
  }
  const props = { draft, setDraft, save, go, notify };
  const current = commands.find(item => item.id === route.page)!;
  return <div className="app-shell">
    <a className="skip-link" href="#main-content" onClick={e => { e.preventDefault(); document.getElementById('main-content')?.focus(); document.getElementById('main-content')?.scrollIntoView(); }}>跳到主要内容</a>
    {mobileNav && <button className="nav-backdrop" onClick={() => setMobileNav(false)} aria-label="关闭导航菜单" />}
    <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`} aria-label="主导航"><div className="sidebar-brand"><Brand /><button className="icon-button mobile-only" onClick={() => setMobileNav(false)} aria-label="收起导航"><X size={19} /></button></div>
      <button className="create-button" onClick={() => { setMobileNav(false); go('production'); window.scrollTo({ top: 0 }); }}><Plus size={17} /><span>新建项目</span><span className="create-shortcut"><ArrowUpRight size={14} /></span></button>
      <span className="nav-section-label">工作空间 <span>WORKSPACE</span></span><nav className="main-nav">{navigation.map(item => <a href={`#/${item.id}`} key={item.id} aria-current={route.page === item.id ? 'page' : undefined}><item.icon size={18} strokeWidth={1.6} /><span>{item.label}</span>{route.page === item.id && <span className="nav-active-dot" />}</a>)}</nav>
      <div className="nav-rule" /><span className="nav-section-label">探索与学习 <span>EXPLORE</span></span><nav className="main-nav"><a href="#/flow/1" aria-current={route.page === 'flow' && route.step !== 5 ? 'page' : undefined}><Workflow size={18} strokeWidth={1.6} /><span>短剧制作流程</span><Tag>9 步</Tag></a><a href="#/flow/5" aria-current={route.page === 'flow' && route.step === 5 ? 'page' : undefined}><Box size={18} strokeWidth={1.6} /><span>白模预演</span><span className="nav-mini">3D</span></a></nav>
      <div className="sidebar-project"><div><span className="tiny-light" />当前练习</div><button onClick={() => go('storyboard')}><span className="project-letter">赴</span><span><strong>赴约，交手之前</strong><small>2 人物 · 4 镜头</small></span><ChevronRight size={13} /></button></div>
      <div className="sidebar-bottom"><div className="preview-note"><span className="status-icon"><Film size={17} /></span><div><strong>你的个人创作空间</strong><p>从一个镜头开始。</p></div></div><button className={`profile-button ${route.page === 'settings' ? 'active' : ''}`} onClick={() => go('settings')}><span className="profile-avatar">我</span><span><strong>个人工作台</strong><small>本地预览版本</small></span><Settings2 size={17} /></button></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="topbar-left"><button className="icon-button mobile-only" onClick={() => setMobileNav(value => !value)} aria-label="打开导航菜单" aria-expanded={mobileNav}><Menu size={20} /></button><span className="breadcrumb">工作空间 <ChevronRight size={12} /><strong>{current.label}</strong></span></div><div className="topbar-right"><button className="topbar-create" onClick={() => { go('production'); window.scrollTo({ top: 0 }); }}><Plus size={14} />新建项目</button><button aria-label="快速查找" className="search-trigger" onClick={() => { setQuery(''); setSearchOpen(true); }}><Search size={14} /><span>快速查找</span><kbd>⌘ K</kbd></button><span className="local-state"><i />本地预览</span><span className="top-avatar" aria-label="个人空间">我</span></div></header>
      <main id="main-content" tabIndex={-1} className={`main-content page-${route.page}`}><AnimatePresence mode="wait" initial={false}><motion.div key={route.page} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.18 }}>
        {route.page === 'studio' && <Studio {...props} onNew={() => setNewOpen(true)} />}
        {route.page === 'production' && <ProductionPage />}
        {route.page === 'script' && <ScriptPage {...props} />}
        {route.page === 'storyboard' && <StoryboardPage {...props} />}
        {route.page === 'director' && <Suspense fallback={<p className="notice">正在准备 3D 导演台…</p>}><DirectorWorkspace notify={notify} /></Suspense>}
        {route.page === 'assets' && <AssetPage {...props} />}
        {route.page === 'flow' && <FlowPage {...props} step={route.step} />}
        {route.page === 'settings' && <SettingsPage {...props} />}
      </motion.div></AnimatePresence></main>
    </div>
    <Modal open={newOpen} onClose={() => setNewOpen(false)} title="一个故事，从这里开始。"><p className="muted">在真实项目中保存剧本并运行拆解，或先查看编辑样例。</p><div className="start-options"><button onClick={() => { setNewOpen(false); go('production'); }}><Film size={24} /><div><strong>创建真实项目</strong><p>保存剧本、运行 Agent、检查并采用结果</p></div><ArrowRight size={18} /></button><button onClick={() => { setNewOpen(false); go('script'); }}><FileText size={24} /><div><strong>查看编辑样例</strong><p>本浏览器的演示剧本与分镜</p></div><ArrowRight size={18} /></button></div><p className="modal-footnote">真实生成需本地后端、PostgreSQL 和模型代理；模型调用可能计费。</p></Modal>
    <Modal open={searchOpen} onClose={() => setSearchOpen(false)} title="快速查找" className="command-modal"><div className="command-input"><Search size={19} /><input autoFocus aria-label="查找工作区" placeholder="试试：分镜、剧本、流程…" value={query} onChange={e => setQuery(e.target.value)} /></div><div className="command-results">{commands.filter(item => `${item.label} ${item.en}`.toLowerCase().includes(query.toLowerCase())).map(item => <button key={item.id} onClick={() => { setSearchOpen(false); go(item.id); }}><item.icon size={18} /><span>{item.label}</span><ArrowUpRight size={15} /></button>)}{!commands.some(item => `${item.label} ${item.en}`.toLowerCase().includes(query.toLowerCase())) && <p className="muted">没有匹配的工作区，换个词试试。</p>}</div><div className="command-footer"><Command size={12} /><span>K 打开 / Esc 关闭</span></div></Modal>
    <Toast text={toast} />
  </div>;
}
