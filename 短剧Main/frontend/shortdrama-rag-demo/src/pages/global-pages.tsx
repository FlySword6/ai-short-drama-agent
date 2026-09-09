import {
  Archive,
  ArrowClockwise,
  ArrowRight,
  CaretLeft,
  CaretRight,
  CloudArrowUp,
  DotsThree,
  FolderPlus,
  DownloadSimple,
  FilmSlate,
  FolderSimple,
  Funnel,
  Info,
  MagicWand,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  SquaresFour,
  Trash,
  TreeStructure,
  UploadSimple,
  User,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
/* 显式 React import：门禁（node:test + tsx classic JSX）真渲染断言与 Vite react-jsx 双兼容——
   s10-lifen.test.ts D4d 行为断言会 renderToStaticMarkup 本文件的 AssetKindTreeView，
   classic 变换发出 React.createElement，没有值级 React 会 ReferenceError（同 asset-shared.tsx 既有模式）。 */
import * as React from "react";
import { ApiClientError, api } from "../api";
import { ASSET_UPLOAD_ACTIVITY_EVENT, ASSET_UPLOAD_FILE_ACCEPT, ASSET_UPLOAD_SETTLED_EVENT, assetLibraryPendingCount, audioTraitListFromInput, isAudioUploadFile, isExcelUploadFile, isVideoUploadFile } from "../asset-upload-tracker";
import {
  ASSET_KIND_OPTIONS,
  ASSET_LIBRARY_PAGE_SIZE,
  AssetKindSelectOptions,
  UNCATEGORIZED_KIND,
  UNCATEGORIZED_KIND_LABEL,
  assetKindClusterViews,
  assetKindGroupValue,
  assetKindMatches,
  assetTagMatches,
  collectAssetTags,
  countAssetsByKind,
  countRawAssetKinds,
  ingestAssetVerified,
  outOfRangePageTarget,
  pageCount,
  paginateItems,
  paginationWindow,
  roleForAssetKind,
  tagSuggestionsFor,
  type AssetKindCategory,
} from "../components/asset-shared";
import { AssetDetailModal, AssetKindThumb, ReviewLegendHelp, TagFilterInput } from "../components/asset-widgets";
import { HomeActivityStrip, HomeStartGuide, ResumeWorkCard } from "../components/home-next-step";
import { ConfigOptionChips } from "../components/config-option-chips";
import { listCapabilityTiers, type CapabilityTier } from "../capability-tiers";
import {
  DEFAULT_ASPECT_RATIO,
  DEFAULT_IMAGE_RESOLUTION,
  DEFAULT_VIDEO_RESOLUTION,
  EMPTY_PROJECT_CONFIG,
  listAspectRatioOptions,
  listConfigOptions,
  pickDefault,
} from "../project-config";
import {
  REVIEW_FILTER_OPTIONS,
  reviewFilterMatches,
  withDemoReviewStatus,
  type AssetReviewBucket,
} from "../components/review-actions";
import { ReviewPill } from "../components/review-panels";
import { UserMenu } from "../components/user-menu";
import { AccountCreditsMenuRow } from "../components/credits-pill";
import { UserSearchInput, resolveDirectoryUser, viewerChipLabel } from "../components/user-search-input";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { cn } from "../components/ui/cn";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Badge,
  EmptyState,
  ErrorState,
  Field,
  Input,
  RoleBadge,
  Select,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "../components/ui/primitives";
import { demoCommonAssets, demoPersonalAssets, demoProjects, registerDemoSessionProject } from "../demo";
import { pickResumeProject } from "../home-next-step";
import { MaterialIngestPanel, projectNameFromFileName } from "./material-agent-page";
import { ReferenceTestsPage } from "./reference-tests-page";
import { navigate, projectStoryboardPath } from "../routing";
import { AUDIO_INGEST_CATEGORIES } from "../types";
import type { Asset, AssetSearchResult, AudioIngestCategory, JsonAssetIngestItem, Project, User as UserType } from "../types";
import {
  DEMO_DIRECTORY,
  canCreateProject,
  canSeeAdminConsole,
  type UserDirectoryRecord,
} from "../operations";
import { capabilityGate, type CapabilitiesState } from "../capabilities-state";
import { CapabilityActionSlot } from "../components/capability-notice";
import {
  IconButton,
  StatusBadge,
  assetKindLabel,
  assetKindRawTitle,
  assetName,
  relativeTimeLabel,
  useResource,
} from "../ui";
import {
  filterProjects,
  humanErrorMessage,
  projectBoardColumn,
  useSlowLoading,
  PROJECT_BOARD_COLUMNS,
  type ProjectBoardColumn,
} from "./batch-generate-drawer";
import { businessErrorMessage } from "../error-copy";

function uploadFileLooksAudio(file: File): boolean {
  return file.type.startsWith("audio/") || /\.(mp3|wav|ogg|opus|m4a|aac|flac|pcm)$/i.test(file.name);
}

export interface PageRuntimeProps {
  demoMode: boolean;
  notify: (message: string, kind?: "info" | "success" | "error") => void;
  user: UserType;
  /* S12-1：入口显隐唯一真源（me/capabilities）。三态必填、不可空——「没传」曾经
     和「读不到」一起并进 null，界面据此把接口故障说成了降权。 */
  capabilities: CapabilitiesState;
  /* F12：账号/积分入口放页面右上惯例位（同一 UserMenu 弹层,与 rail 底组同组件）。
     可选：只有项目列表页等公约入口页消费；App 壳 runtime 一定带。 */
  onLogout?: () => void;
}

/* 裁决 2（S10 丽芬批）：「已完成」tab 摘除——后端项目 status 仅 active/archived
   （仓根 src/modules/production/routes.ts updateProjectSchema），completed 桶恒空。
   逻辑层在 batch-generate-drawer（他线文件）：ProjectFilterTab 类型合同不动；
   completed→桶 死值映射由死值清理线按裁决另行收敛，与本线同向。
   R2 看板化(批次一卡 3):PROJECT_FILTER_TABS/分页常量随状态 tab 与列表分页一起退役——
   看板列归组(projectBoardColumn)取代状态过滤,列内滚动取代翻页。 */

export function ProjectsPage({ demoMode, notify, user, capabilities, onLogout }: PageRuntimeProps): React.JSX.Element {
  /* S12-1：新建项目入口=capabilities 驱动（member 且平台开关关时不显示）。
     四值闸门：读取中给占位、读不到给重试位，都不算「不许你建」。 */
  const createGate = capabilityGate(capabilities, canCreateProject);
  const allowCreate = createGate === "allowed";
  const { data, loading, error, retry, setData } = useResource(() => api.projects(), { items: demoProjects, count: demoProjects.length }, demoMode, []);
  const [query, setQuery] = useState("");
  /* R2 看板化(批次一卡 3,放行单③④):状态 tab 退役,改看板列归组(备戏/在拍/送审/已交,
     projectBoardColumn);筛选排序三 Select 与搜索保留在看板头部工具行。 */
  const [ownerFilter, setOwnerFilter] = useState<"" | "mine">("");
  const [genreFilter, setGenreFilter] = useState("");
  const [sortBy, setSortBy] = useState<"updated" | "created" | "name">("updated");
  const [showCreate, setShowCreate] = useState(false);
  /* S30：⌘K「新建项目」深链(?create=1)——打开既有新建弹窗后立刻剥参;
     查清了确实没权限(denied)只剥参不动作,弹窗按钮本就按同一权限显隐。
     权限还没落地(读取中/读不到)整条挂起：先剥参就把用户的意图丢了,而「读不到」
     不是结论——看板里那个位置摆着「没读到 · 重试」,重试读回来这一条接着开弹窗。
     卡 6 选题雷达 CTA 落点:topic 参数一并预填剧名。 */
  const locationSearch = window.location.search;
  useEffect(() => {
    const params = new URLSearchParams(locationSearch);
    if (params.get("create") !== "1") return;
    if (createGate === "loading" || createGate === "unavailable") return;
    navigate("/projects", { replace: true });
    if (allowCreate) {
      const topic = params.get("topic")?.trim();
      if (topic) setName(topic);
      setShowCreate(true);
    }
  }, [locationSearch, allowCreate, createGate]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  /* S12-3：新建项目增强——负责人默认自己；谁可以看这部剧（仅查看）批量添加；题材；图片/视频审核策略+指定审核人。 */
  const [genre, setGenre] = useState("");
  /* S24-B：体裁建议接 genre_suggestions 词表接口（登录可读）；接口失败人话
     降级——显示提示、可直接输入,不回退写死的旧数组。 */
  const [genreSuggestList, setGenreSuggestList] = useState<string[]>([]);
  const [genreSuggestFailed, setGenreSuggestFailed] = useState(false);
  useEffect(() => {
    if (demoMode) return;
    let active = true;
    api.vocabularyGenres()
      .then((list) => { if (active) setGenreSuggestList(list); })
      .catch(() => { if (active) setGenreSuggestFailed(true); });
    return () => { active = false; };
  }, [demoMode]);
  const [viewerNames, setViewerNames] = useState<string[]>([]);
  const [viewerInput, setViewerInput] = useState("");
  const [imageStrategy, setImageStrategy] = useState("pending_review");
  const [videoStrategy, setVideoStrategy] = useState("pending_review");
  const [reviewerName, setReviewerName] = useState("");
  /* #151：新建项目采集画幅/清晰度默认值（project.md §2.1）。
     选项全部从能力矩阵推导（active 可点、冻结置灰带原因），不写死；
     画幅共用、清晰度图片/视频分开存（2026-08-06 裁决）。 */
  const [configTiers, setConfigTiers] = useState<CapabilityTier[]>([]);
  const [aspectRatio, setAspectRatio] = useState<string | null>(DEFAULT_ASPECT_RATIO);
  const [imageResolution, setImageResolution] = useState<string | null>(DEFAULT_IMAGE_RESOLUTION);
  const [videoResolution, setVideoResolution] = useState<string | null>(DEFAULT_VIDEO_RESOLUTION);
  useEffect(() => {
    if (!showCreate) return;
    let active = true;
    Promise.all([
      listCapabilityTiers("image", demoMode, { includeFrozen: true }).catch(() => null),
      listCapabilityTiers("video", demoMode, { includeFrozen: true }).catch(() => null),
    ]).then(([image, video]) => {
      if (!active) return;
      /* 读不到就保持空数组——chips 区显示「先建项目也行」的说明，不拿假清单糊。 */
      setConfigTiers([...(image?.tiers ?? []), ...(video?.tiers ?? [])]);
    });
    return () => { active = false; };
  }, [showCreate, demoMode]);
  const ratioOptions = useMemo(() => listAspectRatioOptions(configTiers), [configTiers]);
  const imageResOptions = useMemo(() => listConfigOptions(configTiers, "image", "resolution"), [configTiers]);
  const videoResOptions = useMemo(() => listConfigOptions(configTiers, "video", "resolution"), [configTiers]);
  /* 值域到达后校正默认选中：产品默认（9:16 / 1K / 720p）在可点集里就用它，否则取第一个可点值。 */
  useEffect(() => {
    if (configTiers.length === 0) return;
    setAspectRatio((current) => (current && ratioOptions.some((o) => o.available && o.value === current) ? current : pickDefault(ratioOptions, DEFAULT_ASPECT_RATIO)));
  }, [ratioOptions, configTiers.length]);
  useEffect(() => {
    if (configTiers.length === 0) return;
    setImageResolution((current) => (current && imageResOptions.some((o) => o.available && o.value === current) ? current : pickDefault(imageResOptions, DEFAULT_IMAGE_RESOLUTION)));
  }, [imageResOptions, configTiers.length]);
  useEffect(() => {
    if (configTiers.length === 0) return;
    setVideoResolution((current) => (current && videoResOptions.some((o) => o.available && o.value === current) ? current : pickDefault(videoResOptions, DEFAULT_VIDEO_RESOLUTION)));
  }, [videoResOptions, configTiers.length]);
  /* S17-A1：用户目录改走 /users/directory 搜索（任何登录用户可用），缓存经 onResolve 并进 */
  const [directory, setDirectory] = useState<UserDirectoryRecord[]>([]);
  useEffect(() => {
    if (demoMode) setDirectory(DEMO_DIRECTORY);
  }, [demoMode]);
  const mergeDirectory = (users: UserDirectoryRecord[]) => {
    setDirectory((current) => {
      const seen = new Set(current.map((user) => user.id));
      const extras = users.filter((user) => !seen.has(user.id));
      return extras.length > 0 ? [...current, ...extras] : current;
    });
  };
  const resolveUser = (nameOrDisplay: string): UserDirectoryRecord | null => resolveDirectoryUser(directory, nameOrDisplay);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [deletingId, setDeletingId] = useState("");
  /* S10-D5（丽芬批）：项目信息可编辑——名称/说明走后端既有 PATCH /api/v1/projects/:project_id
     （仓根 src/modules/production/routes.ts updateProjectSchema：name/description/status）。 */
  const [editing, setEditing] = useState<Project | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const projects = data?.items ?? [];
  /* wire 字段是 owner_user_id（后端 toProject，仓根 src/modules/production/service.ts）；
     旧 owner_id 读法恒 undefined，任何人都被当成当前用户。 */
  const ownerLabel = useCallback(
    (project: Project) => (!project.owner_user_id || project.owner_user_id === user.id ? user.display_name : "项目成员"),
    [user],
  );
  /* 条 1：题材建议=列表里真实出现的 genre（动态，不做死枚举）；筛选=负责人+题材，排序=更新/创建/名称。 */
  const genreOptions = Array.from(new Set(projects.map((project) => project.genre?.trim() || "").filter(Boolean))).sort();
  const visible = useMemo(() => {
    const filtered = filterProjects(projects, "all", query, ownerLabel)
      .filter((project) => (ownerFilter === "mine" ? project.owner_user_id === user.id || !project.owner_user_id : true))
      .filter((project) => (genreFilter ? (project.genre ?? "") === genreFilter : true));
    const sorted = [...filtered];
    if (sortBy === "name") sorted.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    else {
      const key = sortBy === "created" ? "created_at" : "updated_at";
      sorted.sort((a, b) => new Date(b[key] ?? 0).getTime() - new Date(a[key] ?? 0).getTime());
    }
    return sorted;
  }, [projects, query, ownerLabel, ownerFilter, genreFilter, sortBy, user.id]);
  /* 看板列归组:搜索/筛选后的 visible 按列分流;列内顺序=上面的排序结果。 */
  const boardByColumn = useMemo(() => {
    const map: Record<ProjectBoardColumn, Project[]> = { prepare: [], shooting: [], review: [], delivered: [] };
    for (const project of visible) map[projectBoardColumn(project)].push(project);
    return map;
  }, [visible]);
  /* K2G：「继续上次工作」呈现项=非归档里最近被碰的一个项目（多项目取最近；推导与降级单源在 home-next-step）。 */
  const resumeProject = useMemo(() => pickResumeProject(projects), [projects]);

  async function createProject(): Promise<void> {
    if (!name.trim()) return notify("请输入项目名称", "error");
    if (demoMode) {
      const project: Project = { id: `demo-project-${Date.now()}`, name: name.trim(), description: description.trim(), status: "进行中", episode_count: 0, asset_count: 0, shot_count: 0 };
      /* K2O/GP-04：登记进 demo 会话，项目页/顶栏才能按 projectId 找回这个项目的真名。 */
      registerDemoSessionProject(project);
      setData((current) => ({ items: [project, ...(current?.items ?? [])], count: (current?.count ?? 0) + 1 }));
      setShowCreate(false);
      setName("");
      setDescription("");
      setGenre("");
      setViewerNames([]);
      setReviewerName("");
      setAspectRatio(DEFAULT_ASPECT_RATIO);
      setImageResolution(DEFAULT_IMAGE_RESOLUTION);
      setVideoResolution(DEFAULT_VIDEO_RESOLUTION);
      notify("离线示例项目只保存在当前页面，未写入服务", "info");
      return;
    }
    setCreating(true);
    try {
      const project = await api.createProject({ name: name.trim(), description: description.trim() || null });
      /* S12-3：创建后落运营字段——题材+审核策略（PATCH）、仅查看成员（viewer 角色）；
         逐步执行、单步失败如实报（项目已建，剩余可在项目设置补）。 */
      const followUps: string[] = [];
      /* S24-B：输入过的体裁写入共享建议词表（best-effort，失败不阻塞创建，
         题材本身走下面的 PATCH 落库）。 */
      if (genre.trim()) {
        try {
          await api.addVocabularyGenre(genre.trim());
          const saved = genre.trim();
          setGenreSuggestList((current) => (current.includes(saved) ? current : [...current, saved]));
        } catch { /* 建议词写入失败不阻塞创建 */ }
      }
      try {
        await api.patchProjectOperations(project.id, {
          genre: genre || null,
          reviewPolicies: {
            image: { defaultStrategy: imageStrategy, reviewerUserId: reviewerName.trim() ? resolveUser(reviewerName)?.id ?? null : null },
            video: { defaultStrategy: videoStrategy, reviewerUserId: reviewerName.trim() ? resolveUser(reviewerName)?.id ?? null : null },
          },
        });
      } catch { followUps.push("题材/审核策略"); }
      /* #151：画幅/清晰度默认值补写——项目已建成，这步失败如实进 followUps（项目设置里可补）。 */
      if (aspectRatio || imageResolution || videoResolution) {
        try {
          await api.updateProjectGenerationConfig(project.id, {
            ...EMPTY_PROJECT_CONFIG,
            aspectRatio,
            imageResolution,
            videoResolution,
          });
        } catch { followUps.push("画幅/清晰度默认值"); }
      }
      for (const viewerName of viewerNames) {
        const target = resolveUser(viewerName);
        if (!target) { followUps.push(`「${viewerName}」（仅查看）`); continue; }
        try { await api.addProjectMember(project.id, { userId: target.id, role: "viewer" }); }
        catch { followUps.push(`「${viewerName}」（仅查看）`); }
      }
      setData((current) => ({ items: [project, ...(current?.items ?? [])], count: (current?.count ?? 0) + 1 }));
      setShowCreate(false);
      setName("");
      setDescription("");
      setGenre("");
      setViewerNames([]);
      setReviewerName("");
      setAspectRatio(DEFAULT_ASPECT_RATIO);
      setImageResolution(DEFAULT_IMAGE_RESOLUTION);
      setVideoResolution(DEFAULT_VIDEO_RESOLUTION);
      notify(followUps.length > 0 ? `项目已创建；${followUps.join("、")}没配上，可在项目设置里补` : "项目已创建", followUps.length > 0 ? "info" : "success");
      navigate(projectStoryboardPath(project.id));
    } catch (reason) {
      /* 条 4：写操作失败不许静默——开关关闭后端 403 时给明确提示（根因已查明）。 */
      notify(
        reason instanceof ApiClientError && reason.status === 403
          ? "当前账号未开通建项权限，请联系管理员开通。"
          : businessErrorMessage(reason, "创建项目失败，请重试"),
        "error",
      );
    } finally {
      setCreating(false);
    }
  }

  async function moveProjectToTrash(): Promise<void> {
    if (!deleting) return;
    if (demoMode) {
      notify("离线演示不会把项目写入回收站。", "info");
      setDeleting(null);
      return;
    }
    setDeletingId(deleting.id);
    try {
      await api.deleteProject(deleting.id);
      setData((current) => current ? { items: current.items.filter((project) => project.id !== deleting.id), count: Math.max(0, current.count - 1) } : current);
      notify("项目已移入回收站", "success");
      setDeleting(null);
    } catch (reason) {
      notify(businessErrorMessage(reason, "移入回收站失败，请重试"), "error");
    } finally {
      setDeletingId("");
    }
  }

  /** 打开编辑弹窗：草稿预填当前值（说明缺省回空串，保存时空串写回 null）。 */
  function openProjectEdit(project: Project): void {
    setEditing(project);
    setEditName(project.name);
    setEditDescription(project.description ?? "");
  }

  async function saveProjectEdit(): Promise<void> {
    if (!editing) return;
    const nextName = editName.trim();
    if (!nextName) return notify("请输入项目名称", "error");
    const nextDescription = editDescription.trim();
    if (demoMode) {
      /* K2O/GP-04：改名同步进 demo 会话登记，项目页/顶栏看到的名字与列表一致。 */
      registerDemoSessionProject({ ...editing, name: nextName, description: nextDescription });
      setData((current) => current ? { items: current.items.map((item) => (item.id === editing.id ? { ...item, name: nextName, description: nextDescription } : item)), count: current.count } : current);
      setEditing(null);
      notify("离线示例项目只保存在当前页面，未写入服务", "info");
      return;
    }
    setSavingEdit(true);
    try {
      /* api.ts 无具名 updateProject 客户端方法；经公共 request 直连后端既有 PATCH（api.ts 未改动，
         与 project-pages.tsx patchAsset 同约定）。wire 与 Project 同形（toProject snake 序列化）。 */
      const updated = await api.request<Project>(`/projects/${encodeURIComponent(editing.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: nextName, description: nextDescription || null }),
      });
      setData((current) => current ? { items: current.items.map((item) => (item.id === editing.id ? { ...item, ...updated } : item)), count: current.count } : current);
      setEditing(null);
      notify("项目信息已保存", "success");
    } catch (reason) {
      notify(businessErrorMessage(reason, "保存项目信息失败，请重试"), "error");
    } finally {
      setSavingEdit(false);
    }
  }

  // 板14 加载态：骨架屏 + 超过 8s 亮出「仍在加载 · 重试」，不做无限转圈。
  const slowLoading = useSlowLoading(loading);

  return (
    <section className="or-theme or-projects mx-auto flex w-full max-w-[1920px] flex-col gap-5">
      <h1 className="sr-only">项目管理</h1>
      {/* Dario #3：撤掉内联「问 Pi」摘要条——与右侧全局 AI 工作区重复；右侧全局 Pi 面板不动。 */}
      <div className="flex flex-wrap items-center gap-3">
        {/* 放行单④:负责人/题材/排序三 Select+搜索=看板头部工具行(原「状态 tab 旁」断言由 Fable 改写) */}
        <div className="flex items-center gap-1.5" role="group" aria-label="筛选排序">
          <Select className="w-32" aria-label="负责人筛选" value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value as "" | "mine")}>
            <option value="">全部负责人</option>
            <option value="mine">我负责的</option>
          </Select>
          <Select className="w-32" aria-label="题材筛选" value={genreFilter} onChange={(event) => setGenreFilter(event.target.value)}>
            <option value="">全部题材</option>
            {genreOptions.map((item) => <option key={item} value={item}>{item}</option>)}
          </Select>
          <Select className="w-32" aria-label="排序" value={sortBy} onChange={(event) => setSortBy(event.target.value as "updated" | "created" | "name")}>
            <option value="updated">按更新时间</option>
            <option value="created">按创建时间</option>
            <option value="name">按名称</option>
          </Select>
        </div>
        <div className="relative min-w-52 flex-1">
          <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-2" aria-hidden="true" />
          <Input className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目名称、负责人" aria-label="搜索项目" />
        </div>
        <Button variant="ghost" icon={<Archive />} onClick={() => navigate("/trash?kind=project")}>回收站</Button>
        {/* F12:账号/积分入口放右上惯例位(新人先扫这里);与 rail 底组同一个 UserMenu 弹层 */}
        {onLogout ? <UserMenu user={user} onLogout={onLogout} creditsRow={<AccountCreditsMenuRow demoMode={demoMode} />} /> : null}
      </div>
      {loading ? (
        <div className="flex flex-col items-center gap-4" aria-busy="true" aria-label="正在读取项目">
          <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4" aria-hidden="true">
            {["sk-a", "sk-b", "sk-c", "sk-d", "sk-e", "sk-f"].map((key) => <Skeleton className="h-[300px]" key={key} />)}
          </div>
          <p className="text-sm text-ink-2" role="status">正在读取项目…</p>
          {slowLoading ? <Button icon={<ArrowClockwise />} onClick={retry}>仍在加载 · 重试</Button> : null}
        </div>
      ) : error ? <ErrorState message={humanErrorMessage(error, "项目列表读取失败，请重试")} onRetry={retry} /> : (
        <>
          {/* K2G 步 1：回访第一眼=继续上次工作（有项目才推导）；新用户第一眼=三步起步指引 */}
          {resumeProject ? <ResumeWorkCard project={resumeProject} demoMode={demoMode} /> : null}
          <HomeActivityStrip demoMode={demoMode} projects={projects} />
          {projects.length === 0 ? (
        <HomeStartGuide
          name={name}
          onNameChange={setName}
          creating={creating}
          onSubmit={() => { if (name.trim()) void createProject(); else setShowCreate(true); }}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title="没有符合条件的项目"
          description="换个关键词,或清空负责人/题材筛选试试。"
          action={<Button icon={<MagnifyingGlass />} onClick={() => { setQuery(""); setOwnerFilter(""); setGenreFilter(""); }}>清空筛选</Button>}
          mascot="search"
        />
      ) : (
        <>
          {/* 四列看板(放行单③):备戏/在拍/送审/已交;送审列无数据源如实空态。
              「继续上次工作」由上方 ResumeWorkCard 单点呈现(K2G 单源),此处不再重复渲染。 */}
          {/* 四列看板(放行单③):备戏/在拍/送审/已交;送审列无数据源如实空态 */}
          <div className="grid items-start gap-4 lg:grid-cols-4 md:grid-cols-2">
            {PROJECT_BOARD_COLUMNS.map((column) => (
              <section key={column.value} aria-label={`${column.label}列`} className="flex flex-col gap-3">
                <header className="flex items-baseline gap-2 px-1">
                  <h2 className="text-sm font-medium text-ink-2">{column.label}</h2>
                  <span className="font-mono text-xs text-ink-3">{boardByColumn[column.value].length}</span>
                </header>
                <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto pr-1">
                  {column.value !== "prepare" ? null : allowCreate ? (
                    <button
                      type="button"
                      className="flex min-h-[120px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-2 text-ink-2 outline-none transition-colors duration-150 hover:border-accent hover:text-accent-text focus-visible:ring-2 focus-visible:ring-accent"
                      aria-label="新建项目"
                      onClick={() => setShowCreate(true)}
                    >
                      <Plus className="size-6" aria-hidden="true" />
                      <span className="text-sm">新建项目</span>
                    </button>
                  ) : <CapabilityActionSlot state={capabilities} label="新建项目" className="self-start" />}
                  {boardByColumn[column.value].map((project, index) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      index={index}
                      ownerName={ownerLabel(project)}
                      demoMode={demoMode}
                      onEdit={() => openProjectEdit(project)}
                      onDelete={() => setDeleting(project)}
                    />
                  ))}
                  {column.value === "review" && boardByColumn.review.length === 0 ? (
                    <p className="rounded-lg bg-surface-1 px-4 py-6 text-center text-xs text-ink-3">还没有在审的戏</p>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
        </>
      )}
      <Dialog open={showCreate} onOpenChange={(open) => { if (!open) setShowCreate(false); }}>
        {/* GP-09：八段字段在 900px 视口下超出默认 85dvh 上限，「指定审核人」被裁剩半行。
            本弹窗按实例放宽到 calc(100dvh-2rem)——基准视口 1440×900 全字段完整可见；
            更小视口回落既有模式（DialogBody 滚动、底栏常驻），布局不动。 */}
        <DialogContent size="small" className="max-h-[calc(100dvh-2rem)]" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>新建项目</DialogTitle>
            <DialogDescription>输入剧名开第一部；建好后即可管理资产、导入剧本并开始生成。</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-4">
              <Field label="项目名称">
                <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：《杀穿女频》" />
              </Field>
              {/* #151：画幅/清晰度（project.md §2.1）——选项由能力矩阵推导，灰档带原因；
                  这里定的是默认值，不是上限，单次生成还能改。 */}
              <ConfigOptionChips
                label="画幅"
                ariaLabel="项目画幅"
                options={ratioOptions}
                value={aspectRatio}
                onChange={setAspectRatio}
                hint="默认竖屏 9:16，短剧主场景。这是整个项目的默认值，单次生成时还能改。"
              />
              <ConfigOptionChips
                label="清晰度 · 图片"
                ariaLabel="图片清晰度默认值"
                options={imageResOptions}
                value={imageResolution}
                onChange={setImageResolution}
                hint="默认 1K。图片与视频的清晰度是两套刻度，分开定。"
              />
              <ConfigOptionChips
                label="清晰度 · 视频"
                ariaLabel="视频清晰度默认值"
                options={videoResOptions}
                value={videoResolution}
                onChange={setVideoResolution}
                hint="默认 720p。"
              />
              <p className="m-0 rounded-md border border-border-1 bg-surface-1 px-3 py-2 text-xs text-ink-2">
                风格设定现在可以不填。建好后在「项目设置 → 画面与风格」里定；没定的话，生成时不会带项目风格。
              </p>
              <Field label="项目说明">
                <Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="填写当前制作阶段和重点" />
              </Field>
              <Field label="负责人">
                <Input value={`${user.display_name}（你）`} disabled readOnly aria-readonly="true" />
              </Field>
              <Field label="题材">
                {/* S24-B：体裁建议来自 genre_suggestions 词表（服务端共享）；也可直接输入新题材 */}
                <Input list="genre-suggestions" value={genre} onChange={(event) => setGenre(event.target.value)} placeholder="选择常用项，或直接输入新题材" />
                <datalist id="genre-suggestions">
                  {genreSuggestList.map((item) => <option key={item} value={item} />)}
                </datalist>
                {genreSuggestFailed ? <p className="text-xs text-ink-3">体裁建议暂时加载不出来，可直接输入体裁。</p> : null}
              </Field>
              <Field label="谁可以看这部剧（按用户名/显示名，回车添加）">
                <div className="flex flex-col gap-2">
                  {viewerNames.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {viewerNames.map((item) => {
                        /* GP-10：chip 上屏=显示名（陈默）；item 是规范 username（唯一标识，提交解析用），不上屏。 */
                        const label = viewerChipLabel(directory, item);
                        return (
                          <span key={item} className="inline-flex items-center gap-1 rounded-full border border-border-1 bg-surface-2 px-2.5 py-0.5 text-xs text-ink-1">
                            {label}
                            <button type="button" aria-label={`移除 ${label}`} className="text-ink-4 hover:text-danger" onClick={() => setViewerNames((current) => current.filter((v) => v !== item))}>×</button>
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                  <UserSearchInput
                    value={viewerInput}
                    placeholder="搜索后回车，加入仅查看的人"
                    demoMode={demoMode}
                    onResolve={mergeDirectory}
                    onChange={(text) => setViewerInput(text)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      const next = viewerInput.trim();
                      if (!next) return;
                      /* GP-10：落账一律归一到规范 username（点选填的是 username，手打显示名也归一，
                         同人两种加法按 username 去重）；上屏由 viewerChipLabel 出显示名。 */
                      const target = resolveUser(next);
                      if (!target) { notify(`找不到用户「${next}」，从搜索结果里点选或核对用户名`, "error"); return; }
                      setViewerNames((current) => (current.includes(target.username) ? current : [...current, target.username]));
                      setViewerInput("");
                    }}
                  />
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="图片默认审核">
                  <Select value={imageStrategy} onChange={(event) => setImageStrategy(event.target.value)}>
                    <option value="pending_review">人工审核（默认待审）</option>
                    <option value="automatic">自动通过</option>
                  </Select>
                </Field>
                <Field label="视频默认审核">
                  <Select value={videoStrategy} onChange={(event) => setVideoStrategy(event.target.value)}>
                    <option value="pending_review">人工审核（默认待审）</option>
                    <option value="automatic">自动通过</option>
                  </Select>
                </Field>
              </div>
              <Field label="指定审核人（空=负责人均可审）">
                <UserSearchInput value={reviewerName} demoMode={demoMode} onResolve={mergeDirectory} onChange={(text) => setReviewerName(text)} />
              </Field>
              {demoMode ? <p className="rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-2">离线演示创建的项目不会写入服务。</p> : null}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setShowCreate(false)}>取消</Button>
            <Button variant="primary" icon={<Plus />} loading={creating} onClick={() => void createProject()}>创建项目</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open && !savingEdit) setEditing(null); }}>
        <DialogContent size="small" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>编辑项目信息</DialogTitle>
            <DialogDescription>修改剧名与项目说明，保存后立即生效；说明留空则按无说明处理。</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-4">
              <Field label="项目名称">
                <Input autoFocus value={editName} onChange={(event) => setEditName(event.target.value)} placeholder="剧名，例如：《杀穿女频》" />
              </Field>
              <Field label="项目说明">
                <Textarea value={editDescription} onChange={(event) => setEditDescription(event.target.value)} placeholder="填写当前制作阶段和重点" />
              </Field>
              {demoMode ? <p className="rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-2">离线演示的修改只更新当前页面，不会写入服务。</p> : null}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button disabled={savingEdit} onClick={() => setEditing(null)}>取消</Button>
            <Button variant="primary" loading={savingEdit} onClick={() => void saveProjectEdit()}>保存修改</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {deleting ? (
        <Dialog open onOpenChange={(open) => { if (!open && !deletingId) setDeleting(null); }}>
          <DialogContent size="small" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>移入回收站</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <div className="flex items-start gap-3">
                <Trash className="size-6 shrink-0 text-danger" aria-hidden="true" />
                <div>
                  <strong className="text-sm text-ink-1">将“{deleting.name}”移入回收站</strong>
                  <p className="mt-1 text-xs text-ink-2">项目将从正常列表隐藏。之后可在回收站恢复；永久删除后无法恢复，系统会先检查它是否仍被使用。</p>
                </div>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button disabled={Boolean(deletingId)} onClick={() => setDeleting(null)}>取消</Button>
              <Button variant="danger" icon={<Trash />} loading={deletingId === deleting.id} onClick={() => void moveProjectToTrash()}>确认移入回收站</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}

/** 项目卡海报：惰性取最新集交付清单里第一张图片产物做主图（P1-11 最新产物首帧；
 *  免费读接口、每卡至多 2N 次轻量请求；失败/无产物静默回落剧场占位）。
 *  H 线：原 metadata 封面探测路径已摘——后端 /projects 响应没有 metadata 字段
 *  （toProject 只出 id/owner_user_id/name/description/status/时间戳），该路径恒空。 */
function useProjectCover(project: Project, demoMode: boolean): string {
  const [cover, setCover] = useState("");
  useEffect(() => {
    if (demoMode) { setCover(""); return; }
    let cancelled = false;
    void (async () => {
      try {
        const episodes = [...(await api.episodes(project.id)).items].sort((a, b) => b.episode_no - a.episode_no);
        for (const episode of episodes.slice(0, 3)) {
          const manifest = await api.episodeDeliverables(episode.id);
          const image = manifest.items.find((item) => item.media_kind === "image" && /^https?:\/\//.test(item.storage_url));
          if (image) { if (!cancelled) setCover(image.storage_url); return; }
        }
        if (!cancelled) setCover("");
      } catch {
        /* 静默回落剧场占位 */
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, demoMode]);
  return cover;
}

function ProjectCard({ project, index, ownerName, demoMode, onEdit, onDelete }: { project: Project; index: number; ownerName: string; demoMode: boolean; onEdit: () => void; onDelete: () => void }): React.JSX.Element {
  const coverUrl = useProjectCover(project, demoMode);
  /* P1-11：进度徽章 = N 集 · M 素材 · 最近活动（相对时间）；updated_at 缺失时时间段整段隐藏 */
  const activity = relativeTimeLabel(project.updated_at);
  /* H 线：episode_count/asset_count 在后端 /projects 响应里不存在（Sol 后端缺口，报 Sol 补计数字段），
     无数据时对应段隐藏而不是渲染 0；demo fixture 带真实计数，照常显示。 */
  const statsParts: string[] = [];
  if (typeof project.episode_count === "number") statsParts.push(`${project.episode_count} 集`);
  if (typeof project.asset_count === "number") statsParts.push(`${project.asset_count} 素材`);
  if (activity) statsParts.push(activity);
  return (
    <article className="card-sheen group relative flex shrink-0 flex-col overflow-hidden rounded-lg border border-border-1 bg-surface-1 transition-all duration-150 ease-out-quart focus-within:border-accent hover:-translate-y-0.5 hover:border-border-2 hover:shadow-[0_8px_24px_-12px_oklch(0_0_0/0.5)]">
      <button className="absolute inset-0 z-10 cursor-pointer rounded-[inherit]" type="button" aria-label={`打开项目“${project.name}”`} onClick={() => navigate(projectStoryboardPath(project.id))} />
      <div className={`relative flex aspect-[16/7] items-center justify-center overflow-hidden text-ink-4/70 cover-tone-${index % 5}`}>
        {coverUrl ? <img className="absolute inset-0 h-full w-full object-cover" src={coverUrl} alt={`${project.name} 封面`} loading="lazy" /> : <FilmSlate className="size-5 opacity-60" aria-hidden="true" />}
        {/* 封面下缘渐没入卡体，封面与正文不再生硬拼接 */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-surface-1/90" aria-hidden="true" />
        <div className="absolute left-3 top-3 flex gap-1">
          <StatusBadge status={project.status || "进行中"} />
          {/* S46 C-7：演示数据用 tag 标「演示」，名字里不再写「可删」自注释（名字含「演示」即打标） */}
          {project.name.includes("演示") ? <Badge tone="neutral">演示</Badge> : null}
        </div>
        <div className="absolute bottom-3 right-3 z-20 flex gap-1 opacity-0 transition-opacity duration-150 ease-out-quart group-focus-within:opacity-100 group-hover:opacity-100">
          <IconButton label="编辑项目信息" onClick={onEdit}><PencilSimple /></IconButton>
          <IconButton label="移入回收站" onClick={onDelete}><Trash /></IconButton>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <h2 className="text-ink-1 text-section-title">{project.name}</h2>
        {/* 计数/活动时间任一段有值才渲染该行；全缺时整行隐藏，不摆「0 集 · 0 素材」假进度 */}
        {statsParts.length > 0 ? <p className="font-mono text-xs text-ink-4">{statsParts.join(" · ")}</p> : null}
        {/* 说明为空就整段不渲染，不摆占位句（P1-11） */}
        {project.description?.trim() ? <p className="truncate text-sm text-ink-2">{project.description}</p> : null}
        <footer className="mt-auto flex items-center justify-between gap-2 pt-2">
          <span className="inline-flex items-center gap-1 text-xs text-ink-2"><User className="size-3.5" aria-hidden="true" />{ownerName}</span>
          {/* 整卡可点（见上覆盖按钮），不再印「打开项目 →」链接噪音（W10 审计共识） */}
          {/* K2G(A1-03)：0 集新项目卡的「下一步」=去生产页导入剧本（z-20 压过整卡覆盖按钮）。
              真栈 /projects 响应无 episode_count 字段→不显示（不编计数）；demo 新建卡=0 集正常出现。 */}
          {project.episode_count === 0 ? (
            <button
              type="button"
              className="relative z-20 inline-flex items-center gap-1 text-xs font-medium text-accent-text outline-none transition-colors duration-150 hover:underline focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={`去导入剧本：${project.name}`}
              onClick={() => navigate(projectStoryboardPath(project.id))}
            >去导入剧本<ArrowRight className="size-3.5" aria-hidden="true" /></button>
          ) : null}
        </footer>
      </div>
    </article>
  );
}

/* ---------- 资产中心四页签（W7 IA：素材智能体 + 参考测试并入资产中心） ---------- */

export type AssetCenterTab = "library" | "ingest" | "reference-tests";

const ASSET_CENTER_TABS: ReadonlyArray<{ value: AssetCenterTab; label: string }> = [
  { value: "library", label: "检索" },
  { value: "ingest", label: "入库" },
  { value: "reference-tests", label: "实验室" },
];

/** ?tab= 解析：缺省/未知一律回「检索」；tests 是「实验室」的兼容别名，search 是已撤「语义检索」页签的旧深链（查询能力已并入检索页查询栏）。 */
export function assetCenterTabFromSearch(search: string): AssetCenterTab {
  const value = new URLSearchParams(search).get("tab");
  if (value === "tests") return "reference-tests";
  if (value === "search") return "library";
  return ASSET_CENTER_TABS.some((tab) => tab.value === value) ? (value as AssetCenterTab) : "library";
}

/** 页签深链：保留 scope 与 project（参考测试预选项目，来自旧路由 301）；默认页签省略 tab 参数。 */
export function assetCenterPath(tab: AssetCenterTab, scope: "personal" | "common", projectId?: string | null): string {
  const params = new URLSearchParams({ scope });
  if (tab !== "library") params.set("tab", tab);
  if (projectId) params.set("project", projectId);
  return `/assets?${params.toString()}`;
}

/**
 * 资产中心：素材域首页。检索（个人/通用资产，查询栏即资产查询）+ 入库 + 实验室三页签，
 * ?tab= 可深链；页签懒挂载（首次进入才渲染，不白跑接口），挂载后 forceMount 常驻内存、
 * 非激活视觉隐藏（样式层 tabpanel inactive 规则兜底），切页签不重组已加载数据。
 * 「语义检索」独立页签已撤：与资产库查询栏重复（2026-07-22 Dario 指正）。
 */
export function AssetCenterPage({ scope, demoMode, notify, user, capabilities }: PageRuntimeProps & { scope: "personal" | "common" }): React.JSX.Element {
  const tab = assetCenterTabFromSearch(window.location.search);
  const [visited, setVisited] = useState<ReadonlySet<AssetCenterTab>>(() => new Set([tab]));
  useEffect(() => {
    setVisited((current) => (current.has(tab) ? current : new Set(current).add(tab)));
  }, [tab]);

  return (
    <section className="mx-auto flex w-full max-w-[1920px] flex-col gap-5">
      <h1 className="sr-only">资产中心</h1>
      <Tabs value={tab} onValueChange={(value) => navigate(assetCenterPath(value as AssetCenterTab, scope, new URLSearchParams(window.location.search).get("project")))}>
        <TabsList aria-label="资产中心页签">
          {ASSET_CENTER_TABS.map((item) => <TabsTrigger value={item.value} key={item.value}>{item.label}</TabsTrigger>)}
        </TabsList>
        {visited.has("library") ? (
          <TabsContent value="library" forceMount className="mt-5">
            <AssetLibraryPanel scope={scope} demoMode={demoMode} notify={notify} user={user} capabilities={capabilities} />
          </TabsContent>
        ) : null}
        {visited.has("ingest") ? (
          <TabsContent value="ingest" forceMount className="mt-5">
            <MaterialIngestPanel demoMode={demoMode} notify={notify} />
          </TabsContent>
        ) : null}
        {visited.has("reference-tests") ? (
          <TabsContent value="reference-tests" forceMount className="mt-5">
            <ReferenceTestsPage demoMode={demoMode} notify={notify} user={user} capabilities={capabilities} />
          </TabsContent>
        ) : null}
      </Tabs>
    </section>
  );
}

/* ---------- browse v1(R130,批次一卡 7):通用资产浏览排序/筛选模型 ----------
   只作用于 scope=common 浏览态(语义搜索走 assetSearch 另一链路,口径见 S13-1)。
   条件全部写 URL(kind/media/category/tags/source/gender/age_band/sort/page),链接可分享;
   条件变化回第 1 页;「清空筛选」清筛选不清搜索词;排序方向固定、无升降切换。 */

interface AssetBrowseState {
  kind: string;
  media: "" | "image" | "model3d";
  category: string;
  /** CSV 多值标签(同维度 OR)。 */
  tags: string;
  source: string;
  gender: string;
  ageBand: string;
  sort: "composite" | "newest";
  page: number;
}

function assetBrowseFromSearch(search: string): AssetBrowseState {
  const params = new URLSearchParams(search);
  const page = Number(params.get("page"));
  const sort = params.get("sort");
  const media = params.get("media");
  return {
    kind: params.get("kind") ?? "",
    media: media === "image" || media === "model3d" ? media : "",
    category: params.get("category") ?? "",
    tags: params.get("tags") ?? "",
    source: params.get("source") ?? "",
    gender: params.get("gender") ?? "",
    ageBand: params.get("age_band") ?? "",
    sort: sort === "newest" ? "newest" : "composite",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** 在现有 search 上打 browse 补丁,返回新 query string;默认值不占参数位。 */
function assetBrowseQueryWith(currentSearch: string, patch: Partial<AssetBrowseState>): string {
  const next = { ...assetBrowseFromSearch(currentSearch), ...patch };
  const params = new URLSearchParams(currentSearch);
  const write = (key: string, value: string) => { if (value) params.set(key, value); else params.delete(key); };
  write("kind", next.kind);
  write("media", next.media);
  write("category", next.category);
  write("tags", next.tags);
  write("source", next.source);
  write("gender", next.gender);
  write("age_band", next.ageBand);
  if (next.sort !== "composite") params.set("sort", next.sort); else params.delete("sort");
  if (next.page > 1) params.set("page", String(next.page)); else params.delete("page");
  return params.toString();
}

/** 生效中的 browse 筛选条数(排序/页码不算筛选,徽标只数筛选维度)。 */
function assetBrowseActiveCount(browse: AssetBrowseState): number {
  return [browse.kind, browse.media, browse.category, browse.tags, browse.source, browse.gender, browse.ageBand]
    .filter((value) => value !== "").length;
}

/** 资产中心浏览走后端真分页：一次只取当前 24 张卡，不再按类型扇出十余个全量请求。
    common 浏览态带 browse v1 全套排序筛选参数(R130);personal 维持旧三参。 */
async function fetchScopeAssets(
  scope: "personal" | "common",
  page: number,
  assetKind: string,
  status: string | undefined,
  tag: string,
  browse?: AssetBrowseState,
) {
  return api.assets({
    scope,
    page,
    pageSize: ASSET_LIBRARY_PAGE_SIZE,
    ...(assetKind && assetKind !== UNCATEGORIZED_KIND ? { assetKind } : {}),
    ...(status ? { status } : {}),
    ...(tag ? { tag } : {}),
    ...(browse?.tags ? { tags: browse.tags } : {}),
    ...(browse?.category ? { category: browse.category } : {}),
    ...(browse?.media ? { media: browse.media } : {}),
    ...(browse?.source ? { source: browse.source } : {}),
    ...(browse?.gender ? { gender: browse.gender } : {}),
    ...(browse?.ageBand ? { ageBand: browse.ageBand } : {}),
    ...(browse ? { sort: browse.sort } : {}),
  });
}

function assetStatusForReviewBucket(bucket: AssetReviewBucket | ""): string | undefined {
  if (bucket === "auto") return "automatic_review";
  if (bucket === "pending") return "pending_review";
  if (bucket === "approved") return "approved";
  if (bucket === "rejected") return "rejected";
  return undefined;
}

function AssetLibraryPanel({ scope, demoMode, notify, capabilities }: PageRuntimeProps & { scope: "personal" | "common" }): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [assetKind, setAssetKind] = useState("");
  const [reviewFilter, setReviewFilter] = useState<AssetReviewBucket | "">("");
  const [tagQuery, setTagQuery] = useState("");
  const [appliedTagQuery, setAppliedTagQuery] = useState("");
  const [page, setPage] = useState(1);
  /* R4:卡拉入项目(带项目选择;?project= 上下文的项目排首位并标「当前项目」)——找与用不再断。 */
  const projectsState = useResource(() => api.projects(), { items: demoProjects, count: demoProjects.length }, demoMode, []);
  const projects = projectsState.data?.items ?? [];
  const currentProjectId = new URLSearchParams(window.location.search).get("project");
  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => (a.id === currentProjectId ? -1 : b.id === currentProjectId ? 1 : 0)),
    [projects, currentProjectId],
  );
  async function attachAssetToProject(asset: Asset, projectId: string): Promise<void> {
    if (demoMode) { notify("离线演示不会写入项目", "info"); return; }
    const label = projects.find((item) => item.id === projectId)?.name ?? "该项目";
    try {
      /* 后端 addReference 不判重(201×2 会出双 ref,后端 bug 注记)——前端先查 refs 判重 */
      const refs = await api.projectAssets(projectId);
      const already = (refs.items ?? []).some((ref) => (ref.asset_entity_id ?? ref.asset_id ?? ref.asset?.id ?? "") === asset.id);
      if (already) {
        notify(`「${assetName(asset)}」已经在《${label}》里`, "info");
        return;
      }
      await api.addProjectAsset(projectId, asset.id);
      notify(`已把「${assetName(asset)}」拉入《${label}》`, "success");
    } catch (reason) {
      notify(businessErrorMessage(reason, "拉入项目失败，请重试"), "error");
    }
  }
  /* browse v1(批次一卡 7):通用库浏览态条件以 URL 为唯一真源(kind/media/category/tags/
     source/gender/age_band/sort/page),链接可分享、刷新不丢;个人库维持本地 state 旧三参。
     条件变化统一回第 1 页并滚回顶部(结果集变了,保留位置没有意义)。 */
  const isCommon = scope === "common";
  const browse = assetBrowseFromSearch(window.location.search);
  const setBrowse = (patch: Partial<AssetBrowseState>) => {
    navigate(`/assets?${assetBrowseQueryWith(window.location.search, { page: 1, ...patch })}`, { replace: true });
    window.scrollTo({ top: 0 });
  };
  const effKind = isCommon ? browse.kind : assetKind;
  const effPage = isCommon ? browse.page : page;
  const setEffKind = (next: string) => { if (isCommon) setBrowse({ kind: next }); else setAssetKind(next); };
  /* 审核状态筛选=admin 专属(R130 §4:V-38 权属+V-19 未过审进生成是钱的洞+V-53 导演不该
     面对内部状态);判据沿用 capabilities 单源(S12-1,Fable 2026-08-02 批准)。普通用户
     服务端强制 approved,界面不出现状态筛选。 */
  const canReviewAssets = capabilityGate(capabilities, canSeeAdminConsole) === "allowed";
  /* K2（N1）：「展开其余 N 类」收纳按簇生效——每簇独立展开/收起（取代旧的整行展开态）。 */
  const [expandedKindClusters, setExpandedKindClusters] = useState<ReadonlySet<AssetKindCategory>>(new Set());
  function toggleKindCluster(category: AssetKindCategory): void {
    setExpandedKindClusters((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category); else next.add(category);
      return next;
    });
  }
  /* S10-D4（丽芬批）：文件夹式浏览——列表/树状两种视图并存；
     树状按类型分组，标签/搜索筛选对两种视图同样生效；审核筛选只属于通用库。 */
  const [viewMode, setViewMode] = useState<"list" | "tree">("list");
  const [detailAsset, setDetailAsset] = useState<Asset | null>(null);
  const [importedIds, setImportedIds] = useState<ReadonlySet<string>>(new Set());
  const [showUpload, setShowUpload] = useState(false);
  /* 条 11③：「新建」空资产档案（不传图，后续补图）——与「上传」两个逻辑分开。 */
  const [showCreateAsset, setShowCreateAsset] = useState(false);
  const [newAssetName, setNewAssetName] = useState("");
  const [newAssetKind, setNewAssetKind] = useState("character");
  const [newAssetIntro, setNewAssetIntro] = useState("");
  const [creatingAsset, setCreatingAsset] = useState(false);
  /** 条 11③：空资产建档走 /asset-ingest/json/assets（与项目内「创建角色/场景」同一真链）；
      S17-B 韧性：索引失败的假 500 回查兜底（资产其实已建）。 */
  async function createBlankAsset(): Promise<void> {
    if (!newAssetName.trim()) { notify("请输入名称", "error"); return; }
    if (demoMode) {
      /* A1-05：demo 新建资产本地回显（学建项目本地加卡）——只保存在当前页面，未写入服务 */
      const asset: Asset = {
        id: `demo-asset-${Date.now()}`,
        asset_kind: newAssetKind,
        role: roleForAssetKind(newAssetKind) ?? null,
        name: newAssetName.trim(),
        display_name: newAssetName.trim(),
        intro: newAssetIntro.trim() || null,
        scope: "personal",
        status: "ready",
      };
      setData((current) => ({ items: [asset, ...(current?.items ?? [])], count: (current?.count ?? 0) + 1 }));
      setShowCreateAsset(false);
      setNewAssetName("");
      setNewAssetIntro("");
      notify("离线示例资产只保存在当前页面，未写入服务", "info");
      return;
    }
    setCreatingAsset(true);
    try {
      const { indexed } = await ingestAssetVerified(
        { asset_kind: newAssetKind, name: newAssetName.trim(), display_name: newAssetName.trim(), intro: newAssetIntro.trim() || null, role: roleForAssetKind(newAssetKind) ?? null },
        {
          ingest: (assets) => api.ingestJsonAssets(assets as JsonAssetIngestItem[]),
          lookup: async () => (await api.assets({ scope: "personal", assetKind: newAssetKind })).items,
        },
      );
      setShowCreateAsset(false);
      setNewAssetName("");
      setNewAssetIntro("");
      notify(`已创建档案；点开补图后即可用${indexed ? "" : "（搜索索引稍后自动补上）"}`, "success");
    } catch (reason) {
      notify(businessErrorMessage(reason, "新建资产失败，请重试"), "error");
    } finally {
      setCreatingAsset(false);
    }
    /* 列表刷新独立于创建成败提示：刷新失败（如检索降级）不冒充创建失败 */
    retry();
  }
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploadKindHint, setUploadKindHint] = useState("");
  const [mediaAssetName, setMediaAssetName] = useState("");
  const [mediaSourceProjectName, setMediaSourceProjectName] = useState("");
  const [audioCategory, setAudioCategory] = useState<AudioIngestCategory | "">("");
  const [audioDescription, setAudioDescription] = useState("");
  const [audioVoiceTraits, setAudioVoiceTraits] = useState("");
  const [audioSpeakingStyle, setAudioSpeakingStyle] = useState("");
  const [audioMusicTraits, setAudioMusicTraits] = useState("");
  const [audioTempo, setAudioTempo] = useState("");
  const [audioUsageScene, setAudioUsageScene] = useState("");
  const [deleting, setDeleting] = useState<Asset | null>(null);
  const [deletingId, setDeletingId] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  function selectUploadFile(next: File | null): void {
    setFile(next);
    setMediaSourceProjectName("");
    setAudioCategory("");
    setAudioDescription("");
    setAudioVoiceTraits("");
    setAudioSpeakingStyle("");
    setAudioMusicTraits("");
    setAudioTempo("");
    setAudioUsageScene("");
    const usesMediaIngest = next
      ? isVideoUploadFile(next.name) || next.type.startsWith("video/") || uploadFileLooksAudio(next)
      : false;
    setMediaAssetName(next && usesMediaIngest ? projectNameFromFileName(next.name) || next.name : "");
  }
  function resetUploadFile(): void {
    setFile(null);
    setMediaAssetName("");
    setMediaSourceProjectName("");
    setAudioCategory("");
    setAudioDescription("");
    setAudioVoiceTraits("");
    setAudioSpeakingStyle("");
    setAudioMusicTraits("");
    setAudioTempo("");
    setAudioUsageScene("");
    if (fileInput.current) fileInput.current.value = "";
  }
  // 离线演示：审核四态只覆盖通用库；个人资产免审，不展示审核概念。
  const demoAssets = useMemo(
    () => scope === "personal" ? demoPersonalAssets : demoCommonAssets.map(withDemoReviewStatus),
    [scope],
  );
  /* S13-1：混合检索单框——词法+语义已在服务端融合（POST /asset-search），
     前端没有也不需要「模式」概念；分页接真（page/page_size+has_more，前端切片退役）。
     「语义与结构化混合」这类实现描述不上界面（用户不关心引擎）。 */
  const [searchPage, setSearchPage] = useState(1);
  useEffect(() => { setSearchPage(1); }, [appliedQuery]);
  const { data, loading, error, retry, setData } = useResource<AssetSearchResult & { hasMore?: boolean }>(
    () => appliedQuery
      ? api.assetSearch(appliedQuery, { scope, page: searchPage, pageSize: ASSET_LIBRARY_PAGE_SIZE })
      : fetchScopeAssets(
        scope,
        effPage,
        effKind,
        isCommon && canReviewAssets ? assetStatusForReviewBucket(reviewFilter) : undefined,
        appliedTagQuery,
        isCommon ? browse : undefined,
      ),
    { items: demoAssets, count: demoAssets.length },
    demoMode,
    // deps 全标量:browse 对象每渲染重建,放对象会每次触发重拉;effPage/effKind 已含 page/kind
    [scope, appliedQuery, searchPage, effPage, effKind, reviewFilter, appliedTagQuery, demoAssets, isCommon, canReviewAssets,
      browse.tags, browse.category, browse.media, browse.source, browse.gender, browse.ageBand, browse.sort],
  );
  /* S7-14：资产列表骨架屏的 8s 慢加载升级（与项目页同策略，禁止无限转圈） */
  const slowLoading = useSlowLoading(loading);
  const filtered = (data?.items ?? []).filter((asset) => {
    if (!demoMode && !appliedQuery) return effKind !== UNCATEGORIZED_KIND
      || assetKindGroupValue(asset.asset_kind) === null;
    const statusMatches = scope === "common" ? reviewFilterMatches(asset.status, reviewFilter) : true;
    // 语义检索结果跨资产类型，不再按类型过滤，避免默认筛选吞掉结果。
    // 类型匹配走统一枚举（assetKindMatches：clothing 命中服装、other 命中参考）。
    const kindMatches = appliedQuery ? true : assetKindMatches(asset.asset_kind, effKind);
    return kindMatches && statusMatches && assetTagMatches(asset, tagQuery);
  });
  /* bug6：Tag 建议源 = data?.items 全量（未过 filtered，建议不随筛选收窄） */
  const tagSuggestions = useMemo(() => tagSuggestionsFor(collectAssetTags(data?.items ?? []), tagQuery), [data, tagQuery]);
  // 筛选/检索/范围任一变化回第一页；列表缩水（删除等）时页码夹取到当时上限。
  useEffect(() => { setPage(1); }, [scope, appliedQuery, assetKind, reviewFilter, appliedTagQuery]);
  const commonLocalFilterKey = `${reviewFilter}\u0000${appliedTagQuery}`;
  const previousCommonLocalFilterKey = useRef(commonLocalFilterKey);
  useEffect(() => {
    const changed = previousCommonLocalFilterKey.current !== commonLocalFilterKey;
    previousCommonLocalFilterKey.current = commonLocalFilterKey;
    if (isCommon && changed && browse.page !== 1) setBrowse({ page: 1 });
  }, [commonLocalFilterKey, isCommon]);
  useEffect(() => {
    if (scope === "personal" && reviewFilter) setReviewFilter("");
  }, [scope, reviewFilter]);
  const browsedTotal = !demoMode && !appliedQuery ? (data?.count ?? 0) : filtered.length;
  const paginationTotal = !demoMode && !appliedQuery
    ? (data?.filteredCount ?? browsedTotal)
    : browsedTotal;
  const totalPages = pageCount(paginationTotal);
  const safePage = Math.min(effPage, totalPages);
  const browsePageRedirect = !demoMode && !appliedQuery && isCommon && !loading && !error
    ? outOfRangePageTarget(effPage, paginationTotal)
    : null;
  useEffect(() => {
    if (browsePageRedirect !== null) setBrowse({ page: browsePageRedirect });
  }, [browsePageRedirect, isCommon]);
  const correctingBrowsePage = isCommon && !demoMode && !appliedQuery && (
    browsePageRedirect !== null
    || (!loading && typeof data?.page === "number" && data.page !== effPage)
  );
  /* 搜索态与浏览态都接后端真分页；只有离线演示仍在本地切片。 */
  const pageItems = demoMode ? paginateItems(filtered, safePage) : filtered;
  const readyCount = (data?.items ?? []).filter((asset) => ["approved", "ready"].includes(asset.status || "")).length;
  const pendingCount = (data?.items ?? []).length - readyCount;
  /* 类型页签计数：数据恒为全量（分拉合并 + 无 kind 全量路），选中类型也不再退化为局部计数。
     口径聚合在 asset-shared.countAssetsByKind——S88b：词表外/空白 kind（assetKindGroupValue=null，
     如 dev 库实测的 scene_reference）计入「未分类」pill，不再被类型筛选吞掉。 */
  const kindCounts = useMemo(
    () => !demoMode && !appliedQuery && data?.kindCounts
      ? countRawAssetKinds(data.kindCounts)
      : countAssetsByKind(data?.items ?? []),
    [appliedQuery, data, demoMode],
  );

  /* ---------- browse v1 高级面板:选项值取自数据(不另造枚举;R130 §4) ---------- */
  const [showFilters, setShowFilters] = useState(false);
  const browseActive = assetBrowseActiveCount(browse);
  /* Figma P-03a 对账(2026-08-02)+Fable 裁①(2026-08-03):页内唯一 mint primary=「新建资产」(恒,
     不区分空/非空态);空态「选择文件」与查询均 outline(R5 动态 primary 口径退役)。 */
  const categoryOptions = useMemo(
    () => [...new Set((data?.items ?? []).map((asset) => asset.category).filter((value): value is string => Boolean(value)))].sort(),
    [data],
  );
  const sourceOptions = useMemo(
    () => [...new Set((data?.items ?? []).map((asset) => asset.source_id).filter((value): value is string => Boolean(value)))].sort(),
    [data],
  );
  const genderOptions = useMemo(
    () => [...new Set((data?.items ?? []).map((asset) => asset.gender).filter((value): value is string => Boolean(value)))].sort(),
    [data],
  );
  const ageBandOptions = useMemo(() => {
    const values = (data?.items ?? []).map((asset) => asset.metadata?.age_band).filter((value): value is string => typeof value === "string" && value !== "");
    return [...new Set(values)].sort();
  }, [data]);
  /* 来源资产库显示名:source_id → 项目名(找不到映射时如实显示短 id,不编名)。 */
  const [projectNames, setProjectNames] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => {
    if (!isCommon) return;
    if (demoMode) {
      setProjectNames(Object.fromEntries(demoProjects.map((project) => [project.id, project.name])));
      return;
    }
    let active = true;
    void api.projects().then(({ items }) => {
      if (active) setProjectNames(Object.fromEntries(items.map((project) => [project.id, project.name])));
    }).catch(() => { /* 名称映射失败:下拉退回短 id,不挡筛选 */ });
    return () => { active = false; };
  }, [demoMode, isCommon]);
  /* 标签输入本地暂存:blur/Enter 才写 URL,避免逐击键发请求。 */
  const [tagsDraft, setTagsDraft] = useState(browse.tags);
  useEffect(() => { setTagsDraft(browse.tags); }, [browse.tags]);
  const commitTagsDraft = () => { if (tagsDraft.trim() !== browse.tags) setBrowse({ tags: tagsDraft.trim() }); };
  /** 清空筛选(R130 §6):清全部筛选维度与排序回默认,不动搜索词。 */
  const clearBrowseFilters = () => {
    setBrowse({ kind: "", media: "", category: "", tags: "", source: "", gender: "", ageBand: "", sort: "composite" });
    setTagsDraft("");
    setAssetKind("");
    setTagQuery("");
    setAppliedTagQuery("");
    setReviewFilter("");
  };

  async function upload(): Promise<void> {
    if (!file) return notify("请选择要上传的 Excel、图片、视频或音频", "error");
    if (demoMode) return notify("离线演示不会上传文件或写入资产库", "info");
    const fileIsAudio = isAudioUploadFile(file.name, file.type);
    if (uploadFileLooksAudio(file) && !fileIsAudio) {
      notify("当前只支持 mp3、wav、ogg、opus 音频", "error");
      return;
    }
    if (fileIsAudio && !audioCategory) {
      notify("请选择音频分类", "error");
      return;
    }
    const checkedAudioCategory = audioCategory || null;
    setUploading(true);
    try {
      if (isExcelUploadFile(file.name)) {
        // Excel 资产表:一文件多资产,保持同步批量解析,返回后列表立即可见。
        const result = await api.uploadAsset(file, { assetKindHint: uploadKindHint });
        setData((current) => ({ items: [...result.items, ...(current?.items ?? [])], count: result.count + (current?.count ?? 0) }));
        setShowUpload(false);
        resetUploadFile();
        notify(`已入库 ${result.count} 个资产`, "success");
      } else if (isVideoUploadFile(file.name) || file.type.startsWith("video/")) {
        await api.uploadVideoAsset(file, {
          name: mediaAssetName.trim() || projectNameFromFileName(file.name) || file.name,
          sourceProjectName: mediaSourceProjectName.trim() || undefined,
        });
        setShowUpload(false);
        resetUploadFile();
        notify("视频已上传并提交解析；完成后可在资产中心检索", "success");
        retry();
      } else if (fileIsAudio) {
        if (!checkedAudioCategory) return;
        await api.uploadAudioAsset(file, {
          name: mediaAssetName.trim() || projectNameFromFileName(file.name) || file.name,
          category: checkedAudioCategory,
          description: audioDescription.trim() || undefined,
          sourceProjectName: mediaSourceProjectName.trim() || undefined,
          voiceTraits: audioTraitListFromInput(audioVoiceTraits),
          speakingStyle: audioSpeakingStyle,
          musicTraits: audioTraitListFromInput(audioMusicTraits),
          tempo: audioTempo,
          usageScene: audioUsageScene,
        });
        setShowUpload(false);
        resetUploadFile();
        notify("音频素材已创建，可在资产中心检索", "success");
        retry();
      } else {
        // 图片:S42 提交队列——提交即返回,关窗不丢任务;进度与结果显示在右下角提醒。
        await api.submitAssetUploadTask(file, { assetKindHint: uploadKindHint });
        setShowUpload(false);
        resetUploadFile();
        notify("已提交，正在排队入库；进度与结果显示在右下角", "success");
      }
    } catch (reason) {
      notify(businessErrorMessage(reason, "上传失败，请重试"), "error");
    } finally {
      setUploading(false);
    }
  }

  /* S42: 上传任务落库(终态提醒出现)时 Dock 广播事件,列表自己刷新拿真数据。 */
  useEffect(() => {
    if (demoMode) return;
    const onSettled = () => retry();
    window.addEventListener(ASSET_UPLOAD_SETTLED_EVENT, onSettled);
    return () => window.removeEventListener(ASSET_UPLOAD_SETTLED_EVENT, onSettled);
  }, [demoMode, retry]);

  /* S46 C-2: 在途上传数由 Dock 轮询广播,头部「待入库」并入在途,与入库 toast 同步。 */
  const [activeUploadCount, setActiveUploadCount] = useState(0);
  useEffect(() => {
    if (demoMode) return;
    const onActivity = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: number }>).detail;
      setActiveUploadCount(typeof detail?.active === "number" ? detail.active : 0);
    };
    window.addEventListener(ASSET_UPLOAD_ACTIVITY_EVENT, onActivity);
    return () => window.removeEventListener(ASSET_UPLOAD_ACTIVITY_EVENT, onActivity);
  }, [demoMode]);
  const headerPendingCount = assetLibraryPendingCount(pendingCount, activeUploadCount);
  const selectedFileIsVideo = file ? isVideoUploadFile(file.name) || file.type.startsWith("video/") : false;
  const selectedFileLooksAudio = file ? uploadFileLooksAudio(file) : false;
  const selectedFileIsAudio = file ? isAudioUploadFile(file.name, file.type) : false;
  const selectedFileIsUnsupportedAudio = selectedFileLooksAudio && !selectedFileIsAudio;
  const selectedFileUsesMediaIngest = selectedFileIsVideo || selectedFileLooksAudio;
  const uploadSubmitDisabled = selectedFileIsUnsupportedAudio || (selectedFileIsAudio && !audioCategory);
  const uploadSubmitLabel = selectedFileIsVideo
    ? "上传并解析"
    : selectedFileIsAudio
      ? "上传并创建"
    : file && !isExcelUploadFile(file.name)
      ? "提交入库"
      : "上传并入库";

  async function moveAssetToTrash(): Promise<void> {
    if (!deleting) return;
    if (demoMode) {
      notify("离线演示不会把个人资产写入回收站。", "info");
      setDeleting(null);
      return;
    }
    setDeletingId(deleting.id);
    try {
      await api.deleteAsset(deleting.id);
      setData((current) => current ? { items: current.items.filter((asset) => asset.id !== deleting.id), count: Math.max(0, current.count - 1) } : current);
      notify("个人资产已移入回收站", "success");
      setDeleting(null);
    } catch (reason) {
      notify(businessErrorMessage(reason, "移入回收站失败，请重试"), "error");
    } finally {
      setDeletingId("");
    }
  }

  return (
    <div className="flex flex-col gap-5" aria-label="检索">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={scope} onValueChange={(value) => navigate(value === "common" ? "/assets?scope=common" : "/assets?scope=personal")}>
          <TabsList aria-label="资产范围">
            <TabsTrigger value="personal">个人</TabsTrigger>
            <TabsTrigger value="common">通用</TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="text-sm text-ink-2">
          <strong className="font-mono text-ink-1">{Number.isFinite(data?.count) ? data!.count : (data?.items ?? []).length}</strong>
          {scope === "personal" ? ` 个资产 · ${readyCount} 已入库 / ${headerPendingCount} 待入库` : " 个资产 · 仅提供下载"}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {scope === "common" ? (
            <span
              className="flex items-center gap-1 text-xs text-ink-4"
              title="平台管理员在本剧资产页进行通用资产审核；这里只按状态查看与筛选"
            >
              <Info className="size-3.5 shrink-0" aria-hidden="true" />
              通用资产由平台管理员审核
            </span>
          ) : null}
          {/* S10-D3（丽芬批）：「哪些项目在用这个资产」留位——后端未回传资产的项目使用明细
              （toAssetData 无项目绑定字段，use_count 死字段已按 S10 裁决摘除），不摆空假表，一句说明占位。 */}
          <span
            className="flex items-center gap-1 text-xs text-ink-4"
            title="哪些项目在用这个资产：使用情况功能上线后展示"
          >
            <Info className="size-3.5 shrink-0" aria-hidden="true" />
            项目使用情况，功能上线后展示
          </span>
          {scope === "common" ? <ReviewLegendHelp /> : null}
          <Button variant="outline" icon={<Archive />} onClick={() => navigate("/trash?kind=asset")}>回收站</Button>
          {scope === "personal" ? (
            <span className="flex items-center gap-1.5">
              {/* 条 11③：「上传」（传图入库）与「新建」（空资产档案先建后补图）是两个逻辑，拆开 */}
              <Button variant="outline" icon={<UploadSimple />} onClick={() => setShowUpload(true)}>上传</Button>
              {/* Fable 裁①(2026-08-03):非空态唯一 primary=新建(A4 红项闭合) */}
              <Button variant="primary" icon={<Plus />} onClick={() => setShowCreateAsset(true)}>新建</Button>
            </span>
          ) : null}
        </div>
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setAppliedQuery(query.trim());
          setAppliedTagQuery(tagQuery.trim());
        }}
      >
        <div className="relative min-w-56 flex-1">
          <MagicWand className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-2" aria-hidden="true" />
          <Input className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜角色、场景、道具…支持自然语言" aria-label="搜索资产" />
        </div>
        {/* browse v1:通用库的标签筛选收进高级面板(URL 多值 CSV);个人库保留常驻 Tag 框。 */}
        {!isCommon ? (
          <TagFilterInput
            icon={<MagnifyingGlass />}
            value={tagQuery}
            onChange={setTagQuery}
            suggestions={tagSuggestions}
            placeholder="输入/选择 Tag"
            ariaLabel="Tag 筛选"
            className="w-44 min-w-36"
          />
        ) : null}
        {isCommon ? (
          <>
            {/* 排序两档(R130 §3):方向固定、不提供升降切换;媒体三档(EXISTS,不拆资产)。 */}
            <Select className="w-32" aria-label="排序" value={browse.sort} onChange={(event) => setBrowse({ sort: event.target.value as AssetBrowseState["sort"] })}>
              <option value="composite">综合</option>
              <option value="newest">最新入库</option>
            </Select>
            <Select className="w-32" aria-label="媒体" value={browse.media} onChange={(event) => setBrowse({ media: event.target.value as AssetBrowseState["media"] })}>
              <option value="">全部媒体</option>
              <option value="image">有图片</option>
              <option value="model3d">有 3D 模型</option>
            </Select>
            <Button type="button" variant="outline" icon={<Funnel />} aria-expanded={showFilters} onClick={() => setShowFilters((current) => !current)}>
              筛选{browseActive > 0 ? ` ${browseActive}` : ""}
            </Button>
          </>
        ) : null}
        {/* 审核状态=admin 专属(R130 §4);普通用户服务端强制 approved,界面不出现。 */}
        {isCommon && canReviewAssets ? (
          <Select className="w-36" aria-label="全部审核状态" value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value as AssetReviewBucket | "")}>
            <option value="">全部审核状态</option>
            {REVIEW_FILTER_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </Select>
        ) : null}
        {/* Figma P-03a:页内唯一 mint primary=「新建资产」,查询恒次级(2026-08-02 Figma v2 对账) */}
        <Button variant="outline" icon={<MagnifyingGlass />} type="submit">查询</Button>
        {appliedQuery || appliedTagQuery ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setAppliedQuery("");
              setQuery("");
              setAppliedTagQuery("");
              setTagQuery("");
            }}
          >
            清空
          </Button>
        ) : null}
      </form>
      {/* browse v1 高级筛选面板(R130 §4):细类/风格标签/来源资产库/角色因子(仅角色大类)。
          选项值全部取自数据,不另造枚举;左栏形态组(定妆两件套/三视图)本轮整组不渲染
          (Fable 2026-08-02 裁定,后端无对应筛选参数,挂 v1.1 随 curated_at 批次)。 */}
      {isCommon && showFilters ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-1 p-3" aria-label="高级筛选">
          <Select className="w-36" aria-label="细类" value={browse.category} onChange={(event) => setBrowse({ category: event.target.value })}>
            <option value="">全部细类</option>
            {categoryOptions.map((value) => <option value={value} key={value}>{value}</option>)}
          </Select>
          <Input
            className="w-52"
            aria-label="风格标签"
            placeholder="风格标签,多个用逗号分隔"
            value={tagsDraft}
            onChange={(event) => setTagsDraft(event.target.value)}
            onBlur={commitTagsDraft}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitTagsDraft(); } }}
          />
          <Select className="w-40" aria-label="来源资产库" value={browse.source} onChange={(event) => setBrowse({ source: event.target.value })}>
            <option value="">全部来源</option>
            {sourceOptions.map((id) => <option value={id} key={id}>{projectNames[id] ?? "未知项目"}</option>)}
          </Select>
          {browse.kind === "character" ? (
            <>
              <Select className="w-32" aria-label="性别" value={browse.gender} onChange={(event) => setBrowse({ gender: event.target.value })}>
                <option value="">全部性别</option>
                {genderOptions.map((value) => <option value={value} key={value}>{value}</option>)}
              </Select>
              <Select className="w-32" aria-label="年龄段" value={browse.ageBand} onChange={(event) => setBrowse({ ageBand: event.target.value })}>
                <option value="">全部年龄段</option>
                {ageBandOptions.map((value) => <option value={value} key={value}>{value}</option>)}
              </Select>
              {/* 已知限制如实标注(R130 §4):因子筛选仅覆盖已标注资产,存量大量未标注 */}
              <span className="text-xs text-ink-4">仅覆盖已标注资产</span>
            </>
          ) : null}
          {browseActive > 0 || reviewFilter ? (
            <Button type="button" variant="ghost" onClick={clearBrowseFilters}>清空筛选</Button>
          ) : null}
        </div>
      ) : null}
      {/* K2（N1）：类型横条从 13 枚平铺改为单行三簇——与 select 消费同一份 ASSET_KIND_GROUPS
          （经 asset-shared.assetKindClusterViews，禁各页面自排）；每簇 = 大类小标签（弱一级字重，
          不可点）+ 类内 pill，「未分类」pill 永远收尾。零计数折叠与「展开其余 N 类」收纳沿用
          现有机制但按簇生效；计数口径不变（kindCounts 全量计数，三簇只是分组展示）。 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1" role="tablist" aria-label="资产类型">
        {assetKindClusterViews(kindCounts, effKind, expandedKindClusters).map((cluster) => {
          // 零计数类型默认折叠（W10 审计：「0」挂着是纯噪音）；选中中的类型始终可见。按簇生效。
          const expanded = expandedKindClusters.has(cluster.category);
          const hiddenCount = cluster.hiddenCount;
          return (
            <span className="inline-flex flex-wrap items-center gap-1" key={cluster.category}>
              <span className="mr-0.5 select-none text-xs text-ink-4">{cluster.label}</span>
              {cluster.visibleOptions.map((option) => {
                const active = effKind === option.value;
                return (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-all duration-150 active:scale-[0.98]",
                      active ? "border-accent bg-accent-subtle text-accent-text" : "border-border-1 text-ink-2 hover:border-border-2 hover:text-ink-1",
                    )}
                    key={option.value}
                    onClick={() => setEffKind(effKind === option.value ? "" : option.value)}
                  >
                    {option.label}
                    <span className={cn("font-mono", active ? "text-accent-text" : "text-ink-4")}>{kindCounts.get(option.value) ?? 0}</span>
                  </button>
                );
              })}
              {/* S73 死枝修复(C-5)同规矩、按簇生效：渲染门必须带 expanded——
                  展开后 hiddenCount 归零，若门只看 hiddenCount 按钮消失，展开单向不可逆。 */}
              {hiddenCount > 0 || expanded ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-border-1 px-2.5 py-1 text-xs text-ink-4 transition-colors duration-150 hover:border-border-2 hover:text-ink-1"
                  aria-expanded={expanded}
                  onClick={() => toggleKindCluster(cluster.category)}
                >
                  {expanded ? "收起其余类型" : `展开其余 ${hiddenCount} 类（暂无资产）`}
                </button>
              ) : null}
            </span>
          );
        })}
        {/* S88b：「未分类」pill——词表外/空白 kind 的资产有地方看、有地方筛，
            有计数或选中中时始终可见（不随零计数折叠吞掉）；K2（N1）起永远在三簇之后收尾。 */}
        {((kindCounts.get(UNCATEGORIZED_KIND) ?? 0) > 0 || effKind === UNCATEGORIZED_KIND) ? (
          <button
            type="button"
            role="tab"
            aria-selected={effKind === UNCATEGORIZED_KIND}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-all duration-150 active:scale-[0.98]",
              effKind === UNCATEGORIZED_KIND ? "border-accent bg-accent-subtle text-accent-text" : "border-border-1 text-ink-2 hover:border-border-2 hover:text-ink-1",
            )}
            title="类型不在词表内或为空白的资产"
            onClick={() => setEffKind(effKind === UNCATEGORIZED_KIND ? "" : UNCATEGORIZED_KIND)}
          >
            {UNCATEGORIZED_KIND_LABEL}
            <span className={cn("font-mono", effKind === UNCATEGORIZED_KIND ? "text-accent-text" : "text-ink-4")}>{kindCounts.get(UNCATEGORIZED_KIND) ?? 0}</span>
          </button>
        ) : null}
        {/* S10-D4：列表/树状视图切换（树状 = 按类型分组的文件夹式浏览） */}
        <span className="ml-auto inline-flex items-center gap-0.5 rounded-md border border-border-1 bg-surface-0 p-0.5" role="group" aria-label="浏览视图">
          <button
            type="button"
            aria-pressed={viewMode === "list"}
            aria-label="列表视图"
            title="列表视图"
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-sm transition-colors [&_svg]:size-4",
              viewMode === "list" ? "bg-surface-2 text-ink-1 shadow-sm" : "text-ink-4 hover:text-ink-1",
            )}
            onClick={() => setViewMode("list")}
          ><SquaresFour aria-hidden="true" /></button>
          <button
            type="button"
            aria-pressed={viewMode === "tree"}
            aria-label="按类型树状浏览"
            title="按类型树状浏览"
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-sm transition-colors [&_svg]:size-4",
              viewMode === "tree" ? "bg-surface-2 text-ink-1 shadow-sm" : "text-ink-4 hover:text-ink-1",
            )}
            onClick={() => setViewMode("tree")}
          ><TreeStructure aria-hidden="true" /></button>
        </span>
      </div>
      {loading || correctingBrowsePage ? (
        /* S7-14：资产列表骨架屏（与项目资产页同策略），慢加载 8s 亮重试 */
        <div className="flex flex-col items-center gap-4" aria-busy="true" aria-label="正在读取资产">
          <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4" aria-hidden="true">
            {["sk-a1", "sk-a2", "sk-a3", "sk-a4", "sk-a5", "sk-a6", "sk-a7", "sk-a8"].map((key) => <Skeleton className="h-[280px]" key={key} />)}
          </div>
          {slowLoading ? <Button icon={<ArrowClockwise />} onClick={retry}>仍在加载 · 重试</Button> : null}
        </div>
      ) : error ? <ErrorState message={humanErrorMessage(error, "资产列表读取失败，请重试")} onRetry={retry} /> : filtered.length === 0 ? (
        // 板14：第一天空态即入口（拖图入库）；筛选无结果是另一种空态，不混用
        !effKind && !appliedQuery && (scope !== "common" || (!reviewFilter && browseActive === 0)) && !tagQuery ? (
          <EmptyState
            title="把设定图拖进来"
            description="传完即可用；Excel 资产表走素材智能体批量入库。"
            icon={<CloudArrowUp />}
            action={<Button variant="outline" icon={<UploadSimple />} onClick={() => setShowUpload(true)}>选择文件</Button>}
          />
        ) : appliedQuery ? (
          <EmptyState
            title={`没搜到「${appliedQuery}」`}
            description="换个说法试试，或去全部资产里翻翻。"
            icon={<MagnifyingGlass />}
            action={<Button variant="outline" icon={<MagnifyingGlass />} onClick={() => { setAppliedQuery(""); setQuery(""); }}>看全部资产</Button>}
          />
        ) : (
          /* R130 §6:筛选无结果的业务语言+「清空筛选」动作(清筛选不清搜索词) */
          <EmptyState
            title="没有匹配的资产"
            description="清掉筛选试试，或换个说法搜索。"
            icon={<MagnifyingGlass />}
            action={<Button variant="outline" onClick={clearBrowseFilters}>清空筛选</Button>}
          />
        )
      ) : viewMode === "tree" ? (
        /* S10-D4：树状视图消费同一份 filtered；个人域不带审核筛选或审核徽标。 */
        <AssetKindTreeView assets={filtered} onOpen={(asset) => setDetailAsset(asset)} />
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            {pageItems.map((asset) => <AssetCard key={asset.id} asset={asset} readonly={scope === "common"} imported={importedIds.has(asset.id)} notify={notify} onOpen={() => setDetailAsset(asset)} onDelete={() => setDeleting(asset)} projects={sortedProjects} currentProjectId={currentProjectId} onAttach={(projectId) => attachAssetToProject(asset, projectId)} />)}
          </div>
          {appliedQuery && !demoMode ? (
            <div className="flex items-center justify-between gap-2 text-xs text-ink-2" aria-label="搜索结果分页">
              <span>第 {searchPage} 页{data?.hasMore ? " · 还有下一页" : ""}</span>
              <span className="flex items-center gap-1">
                <Button size="sm" variant="outline" disabled={searchPage <= 1} onClick={() => setSearchPage(searchPage - 1)}>上一页</Button>
                <Button size="sm" variant="outline" disabled={!data?.hasMore} onClick={() => setSearchPage(searchPage + 1)}>下一页</Button>
              </span>
            </div>
          ) : (
            <ListPager page={safePage} total={browsedTotal} paginationTotal={paginationTotal} onPageChange={(next) => { if (isCommon) setBrowse({ page: next }); else setPage(next); }} itemNoun="个资产" ariaLabel="资产分页" />
          )}
        </>
      )}
      {detailAsset ? (
        <AssetDetailModal
          key={detailAsset.id}
          asset={detailAsset}
          demoMode={demoMode}
          notify={notify}
          onClose={() => setDetailAsset(null)}
          onImported={() => setImportedIds((current) => new Set(current).add(detailAsset.id))}
        />
      ) : null}
      <Dialog open={showUpload} onOpenChange={(open) => { if (!open) setShowUpload(false); }}>
        <DialogContent size="medium" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>上传入库</DialogTitle>
            <DialogDescription>选择 Excel 资产表、图片、视频或音频入库；视频会先上传到 TOS 再解析，音频会按填写信息直接创建素材。</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-4">
              <button
                className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-2 px-4 py-8 text-center text-ink-2 transition-colors duration-150 hover:border-accent hover:text-accent-text"
                type="button"
                onClick={() => fileInput.current?.click()}
              >
                <CloudArrowUp className="size-7" aria-hidden="true" />
                <strong className="text-sm text-ink-1">{file ? file.name : "选择 Excel、图片、视频或音频"}</strong>
                <span className="text-xs">{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "支持 .xlsx、.xlsm、jpg、png、webp、bmp、mp4、mov、webm、mp3、wav、ogg、opus"}</span>
              </button>
              <input ref={fileInput} className="sr-only" type="file" accept={ASSET_UPLOAD_FILE_ACCEPT} onChange={(event) => selectUploadFile(event.target.files?.[0] ?? null)} />
              {selectedFileUsesMediaIngest ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="资产名称">
                    <Input value={mediaAssetName} onChange={(event) => setMediaAssetName(event.target.value)} placeholder={file ? projectNameFromFileName(file.name) || file.name : "默认使用文件名"} />
                  </Field>
                  <Field label="来源名称（可选）">
                    <Input value={mediaSourceProjectName} onChange={(event) => setMediaSourceProjectName(event.target.value)} placeholder="不填则留空" />
                  </Field>
                </div>
              ) : null}
              {selectedFileIsAudio ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="音频分类">
                    <Select value={audioCategory} onChange={(event) => setAudioCategory(event.target.value as AudioIngestCategory | "")}>
                      <option value="">请选择</option>
                      {AUDIO_INGEST_CATEGORIES.map((category) => <option value={category} key={category}>{category}</option>)}
                    </Select>
                  </Field>
                  <Field label="描述（可选）">
                    <Input value={audioDescription} onChange={(event) => setAudioDescription(event.target.value)} placeholder="一句话说明用途或听感" />
                  </Field>
                  {audioCategory === "音色" ? (
                    <>
                      <Field label="音色标签（可选）">
                        <Input value={audioVoiceTraits} onChange={(event) => setAudioVoiceTraits(event.target.value)} placeholder="低沉、克制、沙哑" />
                      </Field>
                      <Field label="说话方式（可选）">
                        <Input value={audioSpeakingStyle} onChange={(event) => setAudioSpeakingStyle(event.target.value)} placeholder="旁白、对白、独白" />
                      </Field>
                    </>
                  ) : null}
                  {audioCategory === "背景音乐" ? (
                    <>
                      <Field label="音乐标签（可选）">
                        <Input value={audioMusicTraits} onChange={(event) => setAudioMusicTraits(event.target.value)} placeholder="悬疑、压抑、都市感" />
                      </Field>
                      <Field label="节奏（可选）">
                        <Input value={audioTempo} onChange={(event) => setAudioTempo(event.target.value)} placeholder="慢、中、快" />
                      </Field>
                      <Field label="使用场景（可选）" className="sm:col-span-2">
                        <Input value={audioUsageScene} onChange={(event) => setAudioUsageScene(event.target.value)} placeholder="开场、转场、反转、高潮" />
                      </Field>
                    </>
                  ) : null}
                </div>
              ) : null}
              {selectedFileIsUnsupportedAudio ? (
                <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">当前只支持 mp3、wav、ogg、opus 音频。</p>
              ) : null}
              {!selectedFileUsesMediaIngest ? (
                <Field label="资产类型">
                  <Select value={uploadKindHint} onChange={(event) => setUploadKindHint(event.target.value)}>
                    <option value="">自动识别</option>
                    <AssetKindSelectOptions />
                  </Select>
                </Field>
              ) : null}
              <p className="rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-2">图片提交后立刻可以关窗口，排队与结果显示在右下角提醒；Excel 会等待批量解析完成；视频会上传到 TOS 并提交后台解析；音频会上传后立即创建素材。</p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setShowUpload(false)}>取消</Button>
            <Button variant="primary" icon={<UploadSimple />} loading={uploading} disabled={uploadSubmitDisabled} onClick={() => void upload()}>{uploadSubmitLabel}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* 条 11③：「新建」空资产档案——不传图先建档（类型+名称+简介），后续补图；与「上传」两个逻辑 */}
      <Dialog open={showCreateAsset} onOpenChange={(open) => { if (!open) setShowCreateAsset(false); }}>
        <DialogContent size="small" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>新建资产档案</DialogTitle>
            <DialogDescription>先建类型与名称，图片之后补；要直接传图请走「上传」。</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-4">
              <Field label="类型">
                <Select value={newAssetKind} onChange={(event) => setNewAssetKind(event.target.value)}>
                  <AssetKindSelectOptions />
                </Select>
              </Field>
              <Field label="名称">
                <Input autoFocus value={newAssetName} onChange={(event) => setNewAssetName(event.target.value)} placeholder="例如：任天野" />
              </Field>
              <Field label="简介（可选）">
                <Textarea value={newAssetIntro} onChange={(event) => setNewAssetIntro(event.target.value)} placeholder="一句话说明这个角色/场景/道具" />
              </Field>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setShowCreateAsset(false)}>取消</Button>
            <Button variant="primary" icon={<Plus />} loading={creatingAsset} onClick={() => void createBlankAsset()}>新建档案</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {deleting ? (
        <Dialog open onOpenChange={(open) => { if (!open && !deletingId) setDeleting(null); }}>
          <DialogContent size="small" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>移入回收站</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <div className="flex items-start gap-3">
                <Trash className="size-6 shrink-0 text-danger" aria-hidden="true" />
                <div>
                  <strong className="text-sm text-ink-1">将“{assetName(deleting)}”移入回收站</strong>
                  <p className="mt-1 text-xs text-ink-2">资产会从个人资产列表隐藏。项目引用不会被静默删除；永久删除前系统会再检查它是否仍被使用。</p>
                </div>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button disabled={Boolean(deletingId)} onClick={() => setDeleting(null)}>取消</Button>
              <Button variant="danger" icon={<Trash />} loading={deletingId === deleting.id} onClick={() => void moveAssetToTrash()}>确认移入回收站</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * S10-D4（丽芬批）：按类型树状浏览——文件夹式分组与列表视图并存。
 * 分组用 S88 唯一归属口径（assetKindGroupValue：别名归主类型、animal 归「角色·动物」自己），
 * 一件资产只进一个文件夹，不随筛选上卷重复占位；只陈列传入的 assets（调用方给的是
 * 筛选后的 filtered），标签/搜索筛选不被文件夹取代；审核筛选仅适用于通用资产。
 * S88b：词表外/空白 kind（assetKindGroupValue=null）归入尾部「未分类」组，
 * 树状陈列数与页头计数、未分类 pill 口径一致（不丢资产）；
 * 本组件导出供 s10-lifen.test.ts 做行为级断言（唯一归属不再靠源码字符串断言）。
 * 「按项目分组」需要「哪些项目在用这个资产」的使用明细（接口未回传，见页头留位说明），不摆假分组。
 */
export function AssetKindTreeView({ assets, onOpen }: { assets: Asset[]; onOpen: (asset: Asset) => void }): React.JSX.Element {
  const groups = ASSET_KIND_OPTIONS
    .map((option) => ({ key: option.value, label: option.label, items: assets.filter((asset) => assetKindGroupValue(asset.asset_kind) === option.value) }))
    .filter((entry) => entry.items.length > 0);
  const uncategorized = assets.filter((asset) => assetKindGroupValue(asset.asset_kind) === null);
  if (uncategorized.length > 0) groups.push({ key: UNCATEGORIZED_KIND, label: UNCATEGORIZED_KIND_LABEL, items: uncategorized });
  return (
    <div className="flex flex-col gap-3" aria-label="按类型树状浏览">
      {groups.map(({ key, label, items }) => (
        <section className="flex flex-col overflow-hidden rounded-lg border border-border-1 bg-surface-1" key={key} aria-label={`${label}分组`}>
          <header className="flex items-center gap-2 border-b border-border-1 px-4 py-2.5">
            <FolderSimple className="size-4 text-ink-4" aria-hidden="true" />
            <h2 className="text-sm font-medium text-ink-1">{label}</h2>
            <span className="font-mono text-xs text-ink-4">{items.length} 个资产</span>
          </header>
          <ul className="flex flex-col divide-y divide-border-1">
            {items.map((asset) => (
              <li key={asset.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors duration-150 hover:bg-surface-2"
                  aria-label={`查看 ${assetName(asset)} 详情`}
                  onClick={() => onOpen(asset)}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-well" aria-hidden="true">
                    <AssetKindThumb asset={asset} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink-1">{assetName(asset)}</span>
                    {asset.intro || asset.description ? <span className="block truncate text-xs text-ink-4">{asset.intro || asset.description}</span> : null}
                  </span>
                  <StatusBadge status={asset.status === "pending" ? "draft" : "ready"} />
                  {asset.scope === "common" ? <ReviewPill status={asset.status} /> : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * 通用列表分页器（S9-19 起资产库/项目列表/回收站共用）：单页（≤ 页大小）整体隐藏；
 * 页码窗口首尾锚定 + 当前页邻格（见 paginationWindow）。
 * 页码用原生 button + aria-current，与类型 pill 同一套 token 与 150ms 过渡，键盘 Tab/Enter 可操作。
 */
export function ListPager({ page, total, paginationTotal = total, onPageChange, itemNoun, ariaLabel, pageSize = ASSET_LIBRARY_PAGE_SIZE }: {
  page: number;
  total: number;
  /** Optional narrowed count used only for page bounds; total stays the honest library total. */
  paginationTotal?: number;
  onPageChange: (page: number) => void;
  /** 总数行量词短语，如「个资产」「个项目」「项」 */
  itemNoun: string;
  /** nav 可访问名，如「资产分页」 */
  ariaLabel: string;
  pageSize?: number;
}): React.JSX.Element | null {
  const totalPages = pageCount(paginationTotal, pageSize);
  if (totalPages <= 1) return null;
  return (
    <nav className="flex flex-wrap items-center justify-between gap-3" aria-label={ariaLabel}>
      <span className="text-xs text-ink-2">
        共 {total} {itemNoun}
        {paginationTotal !== total ? ` · 当前筛选 ${paginationTotal} ${itemNoun}` : ""}
        {" · "}第 {page}/{totalPages} 页
      </span>
      <div className="flex items-center gap-1">
        <Button variant="outline" icon={<CaretLeft />} disabled={page <= 1} onClick={() => onPageChange(page - 1)}>上一页</Button>
        {paginationWindow(page, totalPages).map((item, index) => (item === "…" ? (
          <span className="px-1 text-xs text-ink-4" aria-hidden="true" key={`gap-${index}`}>…</span>
        ) : (
          <button
            type="button"
            aria-current={item === page ? "page" : undefined}
            aria-label={`第 ${item} 页`}
            className={cn(
              "min-w-8 rounded-md border px-2 py-1.5 font-mono text-xs transition-colors duration-150",
              item === page
                ? "border-accent bg-accent-subtle text-accent-text"
                : "border-border-1 text-ink-2 hover:border-border-2 hover:text-ink-1",
            )}
            key={item}
            onClick={() => onPageChange(item)}
          >
            {item}
          </button>
        )))}
        <Button variant="outline" icon={<CaretRight />} disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>下一页</Button>
      </div>
    </nav>
  );
}

/**
 * Dario #4：资产卡可点开详情（含无图资产——占位图是设计过的「类型图标 + 色调」，不是灰块）。
 * 缩略区与名称都是入口；动作图标不冒泡。
 */
function AssetCard({ asset, readonly, imported, notify, onOpen, onDelete, projects, currentProjectId, onAttach }: { asset: Asset; readonly?: boolean; imported?: boolean; notify: PageRuntimeProps["notify"]; onOpen: () => void; onDelete: () => void; projects: Project[]; currentProjectId?: string | null; onAttach: (projectId: string) => Promise<void> }): React.JSX.Element {
  return (
    <article className="flex flex-col overflow-hidden rounded-lg border border-border-1 bg-surface-1 transition-all duration-150 ease-out-quart hover:-translate-y-0.5 hover:border-border-2 hover:shadow-[0_8px_24px_-12px_oklch(0_0_0/0.5)]">
      <button className="block h-[150px] w-full cursor-pointer overflow-hidden bg-surface-well" type="button" aria-label={`查看 ${assetName(asset)} 详情`} onClick={onOpen}>
        <AssetKindThumb asset={asset} />
      </button>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-ink-1 text-section-title">
            <button className="text-left transition-colors duration-150 hover:text-accent-text" type="button" onClick={onOpen}>{assetName(asset)}</button>
          </h2>
          <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            {imported ? <Badge tone="success" title="已通过「导入为个人资产」复制到你的个人库">已导入</Badge> : null}
            <StatusBadge status={asset.status === "pending" ? "draft" : "ready"} />
            {asset.scope === "common" ? <ReviewPill status={asset.status} /> : null}
          </span>
        </div>
        <p className="line-clamp-2 text-xs text-ink-2">{asset.intro || asset.description || "暂无资产说明"}</p>
        <div className="flex flex-wrap gap-1">
          <RoleBadge role={asset.role} />
          {(asset.style_tags?.length ? asset.style_tags : [assetKindLabel(asset.asset_kind)]).slice(0, 3).map((tag) => <Badge tone="neutral" key={tag} title={asset.style_tags?.length ? undefined : assetKindRawTitle(asset.asset_kind)}>#{tag}</Badge>)}
        </div>
        <div className="mt-auto flex items-center gap-1 pt-1">
          {/* R4:检索命中卡拉入项目(带项目选择;?project= 上下文给默认首位)——找与用不再断 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" icon={<FolderPlus />} aria-label={`把 ${assetName(asset)} 拉入项目`} title="拉入项目" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {projects.length === 0 ? <DropdownMenuItem disabled>还没有项目，先去建一个</DropdownMenuItem> : null}
              {projects.map((project) => (
                <DropdownMenuItem key={project.id} onClick={() => void onAttach(project.id)}>
                  <FolderPlus aria-hidden="true" />{project.name}{project.id === currentProjectId ? " · 当前项目" : ""}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {!readonly ? <IconButton label="移入回收站" onClick={onDelete}><Trash /></IconButton> : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" icon={<DotsThree />} aria-label="更多操作" title="更多操作" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {!readonly ? <DropdownMenuItem disabled><PencilSimple aria-hidden="true" />资产编辑（即将上线）</DropdownMenuItem> : null}
              {!readonly ? <DropdownMenuItem disabled><CloudArrowUp aria-hidden="true" />{asset.status === "pending" ? "入库（即将上线）" : "转为通用资产（即将上线）"}</DropdownMenuItem> : null}
              <DropdownMenuItem disabled><DownloadSimple aria-hidden="true" />下载资产（受保护下载接入后开放）</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </article>
  );
}
