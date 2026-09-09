/* ============================================================
   project-settings.tsx — 项目设置抽屉（S12 件 2 成员面板 + 件 3 运营字段）

   三个页签：
   - 成员（owner 可见可管；editor/viewer 不显示该页签——成员与审核策略只有负责人能管理）
     列成员/加成员（按用户名，经用户目录解析；无目录权限时如实给缺口说明）/改角色/移除；
     S46 B-4(R44①):成员区抽为 ProjectMembersSection——角色下拉带可见 label(列头「角色」)、
     添加成员成一行(新成员/角色/按钮对齐)、只有负责人时给空态引导;
   - 基本：名称/说明/题材（genre，后端字段）；
   - 审核：图片/视频分开的默认审核策略 + 指定审核人（owner 可改）。
   demo 走本地 fixture 编辑（toast 明示不写服务）；真栈走 members/PATCH 接口。

   显式 React import:仓根门禁(node:test + tsx,classic JSX 运行时)对
   ProjectMembersSection 做组件渲染断言;与 Vite 的 react-jsx 双兼容。
   ============================================================ */

import * as React from "react";
import { GearSix, ImageSquare, UserMinus, UserPlus, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiClientError, api } from "../api";
import { businessErrorMessage } from "../error-copy";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { Badge, Field, Input, Select, Textarea } from "./ui/primitives";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { ConfigOptionChips } from "./config-option-chips";
import { ReferenceImagePicker } from "./reference-image-picker";
import { listCapabilityTiers, type CapabilityTier } from "../capability-tiers";
import {
  DEFAULT_ASPECT_RATIO,
  DEFAULT_IMAGE_RESOLUTION,
  DEFAULT_VIDEO_RESOLUTION,
  EMPTY_PROJECT_CONFIG,
  PROMPT_TEMPLATE_PLACEHOLDERS,
  insertPlaceholder,
  listAspectRatioOptions,
  listConfigOptions,
  pickDefault,
  projectGenerationConfigFromUnknown,
  type ProjectGenerationConfig,
} from "../project-config";
import {
  DEMO_DIRECTORY,
  DEMO_MEMBERS,
  PROJECT_ROLE_LABEL,
  canManageProject,
  forbiddenMessage,
  type ProjectMember,
  type ProjectRole,
  type UserDirectoryRecord,
} from "../operations";
import { capabilityGate, type CapabilitiesState } from "../capabilities-state";
import { CapabilityUnavailableBar } from "./capability-notice";
import { UserSearchInput, resolveDirectoryUser } from "./user-search-input";
import type { PageRuntimeProps } from "../pages/global-pages";

const STRATEGY_OPTIONS = [
  { value: "pending_review", label: "人工审核（默认待审）" },
  { value: "automatic", label: "自动通过" },
] as const;

type Tab = "members" | "basic" | "style" | "prompts" | "review";

export function ProjectSettingsDrawer({ projectId, demoMode, notify, capabilities, onClose }: {
  projectId: string;
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
  capabilities: CapabilitiesState;
  onClose: () => void;
}): React.JSX.Element {
  const ownerGate = capabilityGate(capabilities, (caps) => canManageProject(caps, projectId));
  const owner = ownerGate === "allowed";
  /* 页签默认值跟着权限走,但用户一旦自己点过就钉住:权限落地前先按非负责人定死默认页,
     等于把负责人送错地方,而页签不会因为权限到位再自动跳回来。 */
  const [pickedTab, setPickedTab] = useState<Tab | null>(null);
  const tab = pickedTab ?? (owner ? "members" : "basic");
  const setTab = setPickedTab;
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [membersError, setMembersError] = useState("");
  const [busy, setBusy] = useState(false);
  /** 用户目录缓存（S17-A1：搜索选人，结果经 onResolve 并进来；提交按用户名/显示名精确解析）。 */
  const [directory, setDirectory] = useState<UserDirectoryRecord[]>([]);

  /* 基本/审核表单 */
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [genre, setGenre] = useState<string>("");
  const [imageStrategy, setImageStrategy] = useState<string>("pending_review");
  const [videoStrategy, setVideoStrategy] = useState<string>("pending_review");
  const [imageReviewer, setImageReviewer] = useState("");
  const [videoReviewer, setVideoReviewer] = useState("");

  /* #151 项目级生成配置：画面与风格 / 提示词模板两个页签的编辑态。 */
  const [config, setConfig] = useState<ProjectGenerationConfig>(EMPTY_PROJECT_CONFIG);
  const [pickerOpen, setPickerOpen] = useState<"image" | "video" | null>(null);
  /** 已选参考图的展示信息（mediaId → 名字/缩略图），picker 确认时回传、项目资产列表补。 */
  const [referenceInfo, setReferenceInfo] = useState<Record<string, { name: string; thumbUrl: string | null }>>({});
  /** 平台默认模板读取态：null=没读过；"error"=读取失败如实显示。 */
  const [defaultTemplates, setDefaultTemplates] = useState<{ image: string; video: string } | "error" | null>(null);

  /* S24-B：体裁建议接 genre_suggestions 词表接口（登录可读）；接口失败人话降级——
     显示提示、可直接输入，不回退写死的旧数组。 */
  const [genreSuggestList, setGenreSuggestList] = useState<string[]>([]);
  const [genreSuggestFailed, setGenreSuggestFailed] = useState(false);
  useEffect(() => {
    if (demoMode) return;
    let active = true;
    api.vocabularyGenres()
      .then((items) => { if (active) setGenreSuggestList(items); })
      .catch(() => { if (active) setGenreSuggestFailed(true); });
    return () => { active = false; };
  }, [demoMode]);

  const reload = useCallback(async () => {
    if (!owner) return;
    if (demoMode) { setMembers(DEMO_MEMBERS.filter((m) => m.projectId === projectId)); return; }
    try {
      setMembers(await api.projectMembers(projectId));
      setMembersError("");
    } catch (reason) {
      setMembersError(reason instanceof ApiClientError && reason.status === 403 ? forbiddenMessage("member") : "成员列表读取失败，请稍后重试");
    }
  }, [demoMode, owner, projectId]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (demoMode) setDirectory(DEMO_DIRECTORY);
  }, [demoMode]);

  /** 搜索结果并进缓存（去重）；点选/提交都按缓存精确解析。 */
  const mergeDirectory = useCallback((users: UserDirectoryRecord[]) => {
    setDirectory((current) => {
      const seen = new Set(current.map((user) => user.id));
      const extras = users.filter((user) => !seen.has(user.id));
      return extras.length > 0 ? [...current, ...extras] : current;
    });
  }, []);

  useEffect(() => {
    if (demoMode) {
      setName("《杀穿女频》");
      setGenre("复仇");
      setConfig({
        ...EMPTY_PROJECT_CONFIG,
        aspectRatio: "9:16",
        imageResolution: "1K",
        videoResolution: "720p",
        styleImage: { description: "港风黑帮、霓虹夜景、胶片颗粒、低饱和", referenceMediaIds: [] },
        styleVideo: { description: "手持轻晃、运动幅度中等、节奏偏慢、雨声垫底", referenceMediaIds: [] },
      });
      return;
    }
    void api.project(projectId).then((project) => {
      setName(project.name ?? "");
      setDescription(project.description ?? "");
      setGenre((project as { genre?: string | null }).genre ?? "");
      setConfig(projectGenerationConfigFromUnknown(project));
    }).catch(() => undefined);
  }, [demoMode, projectId]);

  /* #151：画幅/清晰度选项从能力矩阵推导（active 可点、冻结置灰带原因）；
     风格参考图的缩略图信息从项目资产补（已选 id → 名字/图）。 */
  const [configTiers, setConfigTiers] = useState<CapabilityTier[]>([]);
  useEffect(() => {
    let active = true;
    Promise.all([
      listCapabilityTiers("image", demoMode, { includeFrozen: true }).catch(() => null),
      listCapabilityTiers("video", demoMode, { includeFrozen: true }).catch(() => null),
    ]).then(([image, video]) => {
      if (!active) return;
      setConfigTiers([...(image?.tiers ?? []), ...(video?.tiers ?? [])]);
    });
    return () => { active = false; };
  }, [demoMode]);
  const ratioOptions = useMemo(() => listAspectRatioOptions(configTiers), [configTiers]);
  const imageResOptions = useMemo(() => listConfigOptions(configTiers, "image", "resolution"), [configTiers]);
  const videoResOptions = useMemo(() => listConfigOptions(configTiers, "video", "resolution"), [configTiers]);

  const resolveUser = useCallback((username: string): UserDirectoryRecord | null => resolveDirectoryUser(directory, username), [directory]);

  /* ---------- 成员动作 ---------- */
  const [newMemberName, setNewMemberName] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<ProjectRole>("viewer");

  async function addMember(): Promise<void> {
    const target = resolveUser(newMemberName);
    if (!target) { notify(`找不到用户「${newMemberName.trim()}」，从搜索结果里点选或核对用户名`, "error"); return; }
    setBusy(true);
    try {
      if (demoMode) {
        setMembers((current) => [...current.filter((m) => m.userId !== target.id), { projectId, userId: target.id, username: target.username, displayName: target.displayName, platformRole: target.platformRole, projectRole: newMemberRole, addedByUserId: null, createdAt: new Date().toISOString() }]);
        notify("离线演示：成员只在本地更新，未写入服务", "info");
      } else {
        const created = await api.addProjectMember(projectId, { userId: target.id, role: newMemberRole });
        setMembers((current) => [...current.filter((m) => m.userId !== created.userId), created]);
        notify(`已把 ${target.displayName} 加为${PROJECT_ROLE_LABEL[newMemberRole]}`, "success");
      }
      setNewMemberName("");
    } catch (reason) {
      notify(reason instanceof ApiClientError && reason.status === 403 ? forbiddenMessage("member") : businessErrorMessage(reason, "加成员失败"), "error");
    } finally { setBusy(false); }
  }

  async function changeRole(member: ProjectMember, role: ProjectRole): Promise<void> {
    setBusy(true);
    try {
      if (demoMode) {
        setMembers((current) => current.map((m) => (m.userId === member.userId ? { ...m, projectRole: role } : m)));
        notify("离线演示：角色只在本地更新，未写入服务", "info");
      } else {
        const updated = await api.updateProjectMember(projectId, member.userId, { role });
        setMembers((current) => current.map((m) => (m.userId === member.userId ? updated : m)));
        notify(`已把 ${member.displayName} 调整为${PROJECT_ROLE_LABEL[role]}`, "success");
      }
    } catch (reason) {
      notify(reason instanceof ApiClientError && reason.status === 403 ? forbiddenMessage("member") : businessErrorMessage(reason, "调整角色失败"), "error");
    } finally { setBusy(false); }
  }

  async function removeMember(member: ProjectMember): Promise<void> {
    setBusy(true);
    try {
      if (demoMode) {
        setMembers((current) => current.filter((m) => m.userId !== member.userId));
        notify("离线演示：成员只在本地移除，未写入服务", "info");
      } else {
        await api.removeProjectMember(projectId, member.userId);
        setMembers((current) => current.filter((m) => m.userId !== member.userId));
        notify(`已移除 ${member.displayName}`, "success");
      }
    } catch (reason) {
      notify(reason instanceof ApiClientError && reason.status === 403 ? forbiddenMessage("member") : businessErrorMessage(reason, "移除成员失败"), "error");
    } finally { setBusy(false); }
  }

  /* ---------- #151 项目级生成配置 ---------- */

  async function saveConfig(override?: ProjectGenerationConfig): Promise<void> {
    const next = override ?? config;
    setBusy(true);
    try {
      if (demoMode) { notify("离线演示：项目配置只在本地更新，未写入服务", "info"); return; }
      await api.updateProjectGenerationConfig(projectId, next);
      notify("项目配置已保存，之后的生成按这套默认走", "success");
    } catch (reason) {
      notify(reason instanceof ApiClientError && reason.status === 403 ? forbiddenMessage("member") : businessErrorMessage(reason, "项目配置保存失败"), "error");
    } finally { setBusy(false); }
  }

  function confirmReferencePick(kind: "image" | "video", mediaIds: string[], info: Array<{ mediaId: string; name: string; thumbUrl: string | null }>): void {
    setReferenceInfo((current) => {
      const next = { ...current };
      for (const item of info) next[item.mediaId] = { name: item.name, thumbUrl: item.thumbUrl };
      return next;
    });
    setConfig((current) => kind === "image"
      ? { ...current, styleImage: { ...current.styleImage, referenceMediaIds: mediaIds } }
      : { ...current, styleVideo: { ...current.styleVideo, referenceMediaIds: mediaIds } });
    setPickerOpen(null);
  }

  async function loadDefaultTemplates(): Promise<void> {
    if (demoMode) {
      setDefaultTemplates({
        image: "{风格描述}\n画面:{片段内容}\n出场:{角色}\n场景:{场景}\n镜头:定焦中景,人物居中偏左,留出右侧空间",
        video: "{风格描述}\n这一镜:{片段内容}\n出场:{角色}\n场景:{场景}\n运动:手持轻晃,幅度中等,不要快切",
      });
      return;
    }
    try {
      setDefaultTemplates(await api.defaultPromptTemplates());
    } catch {
      setDefaultTemplates("error");
    }
  }

  /* ---------- 基本/审核保存 ---------- */
  async function saveBasic(): Promise<void> {
    setBusy(true);
    try {
      if (demoMode) { notify("离线演示：项目信息只在本地更新，未写入服务", "info"); }
      else {
        /* S24-B：输入过的体裁写入共享建议词表（best-effort，失败不阻塞保存）。 */
        if (genre.trim()) {
          try {
            await api.addVocabularyGenre(genre.trim());
            const saved = genre.trim();
            setGenreSuggestList((current) => (current.includes(saved) ? current : [...current, saved]));
          } catch { /* 建议词写入失败不阻塞保存 */ }
        }
        await api.patchProjectOperations(projectId, { name: name.trim(), description: description.trim(), genre: genre || null });
        notify("项目信息已保存", "success");
      }
    } catch (reason) {
      notify(reason instanceof ApiClientError && reason.status === 403 ? forbiddenMessage("member") : businessErrorMessage(reason, "保存失败"), "error");
    } finally { setBusy(false); }
  }

  async function saveReview(): Promise<void> {
    setBusy(true);
    try {
      const imageReviewerId = imageReviewer.trim() ? resolveUser(imageReviewer)?.id ?? null : null;
      const videoReviewerId = videoReviewer.trim() ? resolveUser(videoReviewer)?.id ?? null : null;
      if ((imageReviewer.trim() && !imageReviewerId) || (videoReviewer.trim() && !videoReviewerId)) {
        notify("审核人没匹配到，从搜索结果里点选或核对后再保存", "error");
        return;
      }
      if (demoMode) { notify("离线演示：审核策略只在本地更新，未写入服务", "info"); }
      else {
        await api.patchProjectOperations(projectId, {
          reviewPolicies: {
            image: { defaultStrategy: imageStrategy, reviewerUserId: imageReviewerId },
            video: { defaultStrategy: videoStrategy, reviewerUserId: videoReviewerId },
          },
        });
        notify("审核策略已保存", "success");
      }
    } catch (reason) {
      notify(reason instanceof ApiClientError && reason.status === 403 ? forbiddenMessage("member") : businessErrorMessage(reason, "保存失败"), "error");
    } finally { setBusy(false); }
  }

  const memberOptions = useMemo(() => members, [members]);

  return (
    <>
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="large">
        <div className="flex items-start justify-between gap-3">
          <div>
            <DialogTitle className="flex items-center gap-2"><GearSix aria-hidden="true" />项目设置</DialogTitle>
            <DialogDescription>成员、画面与风格、提示词模板与审核策略。{ownerGate === "allowed" ? "你是本项目负责人，可以管理。" : ownerGate === "denied" ? "你在本项目不是负责人，只读查看。" : ""}</DialogDescription>
          </div>
          <Button size="icon" variant="ghost" aria-label="关闭" onClick={onClose}><X /></Button>
        </div>
        {capabilities.status === "unavailable" ? <CapabilityUnavailableBar onRetry={capabilities.reload} /> : null}
        <nav className="flex gap-1 border-b border-border-1 pb-2" aria-label="设置页签">
          {owner ? <button type="button" className={cn("rounded-sm px-3 py-1.5 text-sm", tab === "members" ? "bg-accent-subtle text-accent-text" : "text-ink-2 hover:text-ink-1")} onClick={() => setTab("members")}>成员</button> : null}
          <button type="button" className={cn("rounded-sm px-3 py-1.5 text-sm", tab === "basic" ? "bg-accent-subtle text-accent-text" : "text-ink-2 hover:text-ink-1")} onClick={() => setTab("basic")}>基本</button>
          <button type="button" className={cn("rounded-sm px-3 py-1.5 text-sm", tab === "style" ? "bg-accent-subtle text-accent-text" : "text-ink-2 hover:text-ink-1")} onClick={() => setTab("style")}>画面与风格</button>
          <button type="button" className={cn("rounded-sm px-3 py-1.5 text-sm", tab === "prompts" ? "bg-accent-subtle text-accent-text" : "text-ink-2 hover:text-ink-1")} onClick={() => setTab("prompts")}>提示词模板</button>
          {owner ? <button type="button" className={cn("rounded-sm px-3 py-1.5 text-sm", tab === "review" ? "bg-accent-subtle text-accent-text" : "text-ink-2 hover:text-ink-1")} onClick={() => setTab("review")}>审核策略</button> : null}
        </nav>

        {tab === "members" && owner ? (
          <ProjectMembersSection
            members={memberOptions}
            membersError={membersError}
            busy={busy}
            demoMode={demoMode}
            newMemberName={newMemberName}
            newMemberRole={newMemberRole}
            onResolveDirectory={mergeDirectory}
            onNewMemberNameChange={setNewMemberName}
            onNewMemberRoleChange={setNewMemberRole}
            onAddMember={() => void addMember()}
            onChangeRole={(member, role) => void changeRole(member, role)}
            onRemoveMember={(member) => void removeMember(member)}
          />
        ) : null}

        {tab === "basic" ? (
          <section className="flex flex-col gap-3" aria-label="基本信息">
            <label className="flex flex-col gap-1 text-xs text-ink-2"><span>项目名称</span>
              <Input value={name} disabled={!owner || busy} onChange={(event) => setName(event.target.value)} /></label>
            <label className="flex flex-col gap-1 text-xs text-ink-2"><span>项目说明</span>
              <Input value={description} disabled={!owner || busy} placeholder="空就空着，不摆占位句" onChange={(event) => setDescription(event.target.value)} /></label>
            <label className="flex flex-col gap-1 text-xs text-ink-2"><span>题材</span>
              {/* S24-B：体裁建议来自 genre_suggestions 词表（服务端共享）；也可直接输入新题材 */}
              <Input list="genre-suggestions" value={genre} disabled={!owner || busy} placeholder="选择常用项，或直接输入新题材" onChange={(event) => setGenre(event.target.value)} />
              <datalist id="genre-suggestions">
                {genreSuggestList.map((item) => <option key={item} value={item} />)}
              </datalist>
              {genreSuggestFailed ? <span className="text-ink-3">体裁建议暂时加载不出来，可直接输入题材。</span> : null}</label>
            {owner ? <Button className="self-start" loading={busy} onClick={() => void saveBasic()}>保存基本信息</Button> : <p className="text-xs text-ink-4">只有负责人能编辑项目信息。</p>}
          </section>
        ) : null}

        {tab === "review" && owner ? (
          <section className="flex flex-col gap-3" aria-label="审核策略">
            {(["image", "video"] as const).map((kind) => (
              <div key={kind} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-end gap-3 rounded-md border border-border-1 bg-surface-1 px-3 py-2">
                <label className="flex flex-col gap-1 text-xs text-ink-2"><span>{kind === "image" ? "图片默认审核" : "视频默认审核"}</span>
                  <Select value={kind === "image" ? imageStrategy : videoStrategy} disabled={busy} onChange={(event) => (kind === "image" ? setImageStrategy(event.target.value) : setVideoStrategy(event.target.value))}>
                    {STRATEGY_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </Select></label>
                <label className="flex flex-col gap-1 text-xs text-ink-2"><span>指定审核人（空=负责人均可审）</span>
                  <UserSearchInput value={kind === "image" ? imageReviewer : videoReviewer} disabled={busy} demoMode={demoMode} onResolve={mergeDirectory} onChange={(text) => (kind === "image" ? setImageReviewer(text) : setVideoReviewer(text))} /></label>
              </div>
            ))}
            <Button className="self-start" loading={busy} onClick={() => void saveReview()}>保存审核策略</Button>
          </section>
        ) : null}

        {tab === "style" ? (
          <ProjectStyleSection
            owner={owner}
            busy={busy}
            config={config}
            ratioOptions={ratioOptions}
            imageResOptions={imageResOptions}
            videoResOptions={videoResOptions}
            referenceInfo={referenceInfo}
            onConfigChange={setConfig}
            onOpenPicker={(kind) => setPickerOpen(kind)}
            onSave={(next) => void saveConfig(next)}
          />
        ) : null}

        {tab === "prompts" ? (
          <ProjectPromptsSection
            owner={owner}
            busy={busy}
            config={config}
            defaultTemplates={defaultTemplates}
            onConfigChange={setConfig}
            onLoadDefaultTemplates={() => void loadDefaultTemplates()}
            onSave={() => void saveConfig()}
          />
        ) : null}
      </DialogContent>
    </Dialog>
    {pickerOpen ? (
      <ReferenceImagePicker
        projectId={projectId}
        demoMode={demoMode}
        selected={pickerOpen === "image" ? config.styleImage.referenceMediaIds : config.styleVideo.referenceMediaIds}
        onConfirm={(ids, info) => confirmReferencePick(pickerOpen, ids, info)}
        onClose={() => setPickerOpen(null)}
      />
    ) : null}
    </>
  );
}

/* ---------- S46 B-4(R44①):成员区重排——角色下拉带 label、添加成员成行、空态引导 ---------- */

export interface ProjectMembersSectionProps {
  members: ProjectMember[];
  membersError: string;
  busy: boolean;
  demoMode: boolean;
  newMemberName: string;
  newMemberRole: ProjectRole;
  onResolveDirectory: (users: UserDirectoryRecord[]) => void;
  onNewMemberNameChange: (text: string) => void;
  onNewMemberRoleChange: (role: ProjectRole) => void;
  onAddMember: () => void;
  onChangeRole: (member: ProjectMember, role: ProjectRole) => void;
  onRemoveMember: (member: ProjectMember) => void;
}

/**
 * 成员页签主体(纯展示,交互回调全部由抽屉注入;抽出来以便组件渲染断言):
 * - 列表列头「成员/角色/操作」——角色下拉有可见 label,不再只有 aria;
 * - 「加成员」成一行:新成员(搜索,flex-1)/ 角色(定宽)/ 按钮底对齐,不再散排;
 * - 只有负责人时给空态引导(加谁、怎么加、能干什么),不再一面白墙。
 */
export function ProjectMembersSection({
  members,
  membersError,
  busy,
  demoMode,
  newMemberName,
  newMemberRole,
  onResolveDirectory,
  onNewMemberNameChange,
  onNewMemberRoleChange,
  onAddMember,
  onChangeRole,
  onRemoveMember,
}: ProjectMembersSectionProps): React.JSX.Element {
  const collaboratorCount = members.filter((member) => member.projectRole !== "owner").length;
  return (
    <section className="flex flex-col gap-3" aria-label="项目成员">
      {membersError ? <p className="rounded-sm bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{membersError}</p> : null}
      {members.length > 0 ? (
        <div className="flex items-center gap-3 px-3 text-[11px] text-ink-4" aria-hidden="true">
          <span className="min-w-0 flex-1">成员</span>
          <span className="w-28">角色</span>
          <span className="w-8 text-center">操作</span>
        </div>
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {members.map((member) => (
          <li key={member.userId} className="flex items-center gap-3 rounded-md border border-border-1 bg-surface-2 px-3 py-2">
            <span className="min-w-0 flex-1">
              <strong className="text-sm text-ink-1">{member.displayName}</strong>
              <span className="ml-2 font-mono text-xs text-ink-4">@{member.username}</span>
            </span>
            {member.projectRole === "owner" ? (
              <Badge tone="success">负责人</Badge>
            ) : (
              <>
                <Select className="w-28" aria-label={`调整 ${member.displayName} 的角色`} value={member.projectRole} disabled={busy} onChange={(event) => onChangeRole(member, event.target.value as ProjectRole)}>
                  <option value="editor">可编辑</option>
                  <option value="viewer">仅查看</option>
                </Select>
                <Button size="icon" variant="ghost" aria-label={`移除 ${member.displayName}`} disabled={busy} onClick={() => onRemoveMember(member)}><UserMinus /></Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {!membersError && collaboratorCount === 0 ? (
        <p className="flex items-start gap-1.5 rounded-md border border-dashed border-border-2 px-3 py-2 text-xs text-ink-2">
          <UserPlus className="mt-px size-3.5 shrink-0 text-ink-4" aria-hidden="true" />
          <span>还只有项目负责人。把导演、美术加进来一起干活——在下方搜用户名或显示名，选好角色，点「加成员」。</span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-2 rounded-md border border-border-1 bg-surface-1 px-3 py-2.5">
        <div className="flex min-w-[180px] flex-1 flex-col gap-1">
          <span className="text-xs text-ink-2">新成员</span>
          <UserSearchInput ariaLabel="按用户名或显示名加成员" placeholder="搜用户名或显示名" value={newMemberName} demoMode={demoMode} onResolve={onResolveDirectory} onChange={onNewMemberNameChange} />
        </div>
        <div className="flex w-28 flex-col gap-1">
          <span className="text-xs text-ink-2">角色</span>
          <Select aria-label="新成员角色" value={newMemberRole} onChange={(event) => onNewMemberRoleChange(event.target.value as ProjectRole)}>
            <option value="viewer">仅查看</option>
            <option value="editor">可编辑</option>
          </Select>
        </div>
        <Button icon={<UserPlus />} loading={busy} onClick={onAddMember}>加成员</Button>
      </div>
      <p className="text-xs text-ink-4">仅查看能读项目与产物；可编辑能生成与修改；负责人额外管理成员与审核策略。</p>
    </section>
  );
}

/* ---------- #151 画面与风格（project.md §4.1/§4.2） ---------- */

export interface ProjectStyleSectionProps {
  owner: boolean;
  busy: boolean;
  config: ProjectGenerationConfig;
  ratioOptions: ReturnType<typeof listAspectRatioOptions>;
  imageResOptions: ReturnType<typeof listConfigOptions>;
  videoResOptions: ReturnType<typeof listConfigOptions>;
  referenceInfo: Record<string, { name: string; thumbUrl: string | null }>;
  onConfigChange: (next: ProjectGenerationConfig) => void;
  onOpenPicker: (kind: "image" | "video") => void;
  onSave: (override?: ProjectGenerationConfig) => void;
}

function StyleCard({ kind, owner, busy, config, referenceInfo, onConfigChange, onOpenPicker }: {
  kind: "image" | "video";
  owner: boolean;
  busy: boolean;
  config: ProjectGenerationConfig;
  referenceInfo: ProjectStyleSectionProps["referenceInfo"];
  onConfigChange: (next: ProjectGenerationConfig) => void;
  onOpenPicker: (kind: "image" | "video") => void;
}): React.JSX.Element {
  const image = kind === "image";
  const set = image ? config.styleImage : config.styleVideo;
  const title = image ? "图片风格" : "视频风格";
  const subtitle = image ? "图像讲的是构图、光线、质感。" : "视频除了画面，还得讲运动和节奏。";

  function update(next: { description: string; referenceMediaIds: string[] }): void {
    onConfigChange(image ? { ...config, styleImage: next } : { ...config, styleVideo: next });
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border border-border-1 bg-surface-1 px-4 py-3" aria-label={title}>
      <header className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-ink-1">{title}</h3>
        <p className="text-xs text-ink-4">{subtitle}</p>
      </header>
      <Field label="风格描述" hint="一段话就行，写给模型看的。生成时会自动拼进提示词。">
        <Textarea
          value={set.description}
          disabled={!owner || busy}
          placeholder={image ? "例：港风黑帮、霓虹夜景、胶片颗粒、低饱和" : "例：手持轻晃、运动幅度中等、节奏偏慢、雨声垫底"}
          aria-label={`${title}描述`}
          onChange={(event) => update({ ...set, description: event.target.value })}
        />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-2">参考图 · 选填</span>
        <div className="flex flex-wrap gap-2">
          {set.referenceMediaIds.map((mediaId) => {
            const info = referenceInfo[mediaId];
            return (
              <span key={mediaId} className="relative inline-flex w-20 flex-col gap-1">
                <span className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-md border border-border-1 bg-surface-well text-ink-4">
                  {info?.thumbUrl ? <img src={info.thumbUrl} alt={info.name} className="size-full object-cover" loading="lazy" /> : <ImageSquare className="size-5" aria-hidden="true" />}
                </span>
                <span className="truncate text-[11px] text-ink-2">{info?.name ?? "一张参考图"}</span>
                {owner ? (
                  <button
                    type="button"
                    aria-label={`移除参考图 ${info?.name ?? mediaId}`}
                    className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-surface-0 text-xs text-ink-4 ring-1 ring-border-1 hover:text-danger"
                    onClick={() => update({ ...set, referenceMediaIds: set.referenceMediaIds.filter((id) => id !== mediaId) })}
                  >×</button>
                ) : null}
              </span>
            );
          })}
          {owner ? (
            <button
              type="button"
              className="flex w-20 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border-2 py-3 text-xs text-ink-2 outline-none transition-colors hover:border-accent hover:text-accent-text focus-visible:ring-2 focus-visible:ring-accent"
              disabled={busy}
              onClick={() => onOpenPicker(kind)}
            >
              <span aria-hidden="true" className="text-base leading-none">+</span>从资产里选
            </button>
          ) : null}
        </div>
        <p className="m-0 text-xs text-ink-4">参考图只能从项目资产或资产中心里挑，不在这儿另传一套——同一张图不该在系统里存两份。</p>
      </div>
    </section>
  );
}

export function ProjectStyleSection({ owner, busy, config, ratioOptions, imageResOptions, videoResOptions, referenceInfo, onConfigChange, onOpenPicker, onSave }: ProjectStyleSectionProps): React.JSX.Element {
  const [error, setError] = useState("");

  function save(): void {
    /* §4.2：风格描述是每一套的必填项——只挑参考图不写描述，风格就等于没定。 */
    for (const [label, set] of [["图片", config.styleImage], ["视频", config.styleVideo]] as const) {
      if (set.referenceMediaIds.length > 0 && !set.description.trim()) {
        setError(`${label}风格挑了参考图，但还没写风格描述——补一句，或把参考图去掉。`);
        return;
      }
    }
    setError("");
    /* 显示值=保存值：项目还没定过的项,chips 上选中的是产品默认（pickDefault 推导），
       保存时把显示选中的值一并写回——不许「显示选中了 A,发出去的却是空」。 */
    const effective: ProjectGenerationConfig = {
      ...config,
      aspectRatio: config.aspectRatio ?? pickDefault(ratioOptions, DEFAULT_ASPECT_RATIO),
      imageResolution: config.imageResolution ?? pickDefault(imageResOptions, DEFAULT_IMAGE_RESOLUTION),
      videoResolution: config.videoResolution ?? pickDefault(videoResOptions, DEFAULT_VIDEO_RESOLUTION),
    };
    onConfigChange(effective);
    onSave(effective);
  }

  return (
    <section className="flex flex-col gap-4" aria-label="画面与风格">
      <section className="flex flex-col gap-3 rounded-md border border-border-1 bg-surface-1 px-4 py-3" aria-label="这个项目默认怎么出片">
        <header className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold text-ink-1">这个项目默认怎么出片</h3>
          <p className="text-xs text-ink-4">这里定的是默认值，不是上限。单次生成时还能改，改了只算那一次，不回写这里。</p>
        </header>
        <fieldset disabled={!owner || busy} className="m-0 flex flex-col gap-3 border-0 p-0 disabled:opacity-70">
          <ConfigOptionChips label="画幅" options={ratioOptions} value={config.aspectRatio ?? pickDefault(ratioOptions, DEFAULT_ASPECT_RATIO)} onChange={(value) => onConfigChange({ ...config, aspectRatio: value })} />
          <ConfigOptionChips label="清晰度 · 图片" options={imageResOptions} value={config.imageResolution ?? pickDefault(imageResOptions, DEFAULT_IMAGE_RESOLUTION)} onChange={(value) => onConfigChange({ ...config, imageResolution: value })} />
          <ConfigOptionChips label="清晰度 · 视频" options={videoResOptions} value={config.videoResolution ?? pickDefault(videoResOptions, DEFAULT_VIDEO_RESOLUTION)} onChange={(value) => onConfigChange({ ...config, videoResolution: value })} />
        </fieldset>
      </section>

      <div className="grid gap-3 md:grid-cols-2">
        <StyleCard kind="image" owner={owner} busy={busy} config={config} referenceInfo={referenceInfo} onConfigChange={onConfigChange} onOpenPicker={onOpenPicker} />
        <StyleCard kind="video" owner={owner} busy={busy} config={config} referenceInfo={referenceInfo} onConfigChange={onConfigChange} onOpenPicker={onOpenPicker} />
      </div>

      <section className="flex flex-col gap-1.5 rounded-md border border-border-1 bg-surface-2 px-4 py-3" aria-label="这两套风格怎么用">
        <h3 className="text-xs font-semibold text-ink-1">这两套风格怎么用</h3>
        <p className="m-0 text-xs text-ink-2">每次生成会自动带上对应的那一套：图片生成带图片风格，视频生成带视频风格。生成面板上会写着「这次带了项目风格」，也可以一键取消掉这一次——只影响这一次，不改这里。</p>
        <p className="m-0 text-xs text-ink-4">图片和视频分开两套，是因为描述习惯不一样，混成一套会互相干扰。</p>
      </section>

      {error ? <p className="m-0 rounded-sm bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p> : null}
      {owner ? (
        <Button className="self-start" loading={busy} onClick={save}>保存画面与风格</Button>
      ) : (
        <p className="m-0 text-xs text-ink-4">只有项目负责人能改这些配置。你看到的是这个项目当前的设定。</p>
      )}
    </section>
  );
}

/* ---------- #151 提示词模板（project.md §4.3） ---------- */

export interface ProjectPromptsSectionProps {
  owner: boolean;
  busy: boolean;
  config: ProjectGenerationConfig;
  defaultTemplates: { image: string; video: string } | "error" | null;
  onConfigChange: (next: ProjectGenerationConfig) => void;
  onLoadDefaultTemplates: () => void;
  onSave: () => void;
}

function PromptTemplateCard({ kind, owner, busy, config, defaultTemplates, onConfigChange, onLoadDefaultTemplates }: {
  kind: "image" | "video";
  owner: boolean;
  busy: boolean;
  config: ProjectGenerationConfig;
  defaultTemplates: { image: string; video: string } | "error" | null;
  onConfigChange: (next: ProjectGenerationConfig) => void;
  onLoadDefaultTemplates: () => void;
}): React.JSX.Element {
  const image = kind === "image";
  const value = image ? config.promptTemplateImage : config.promptTemplateVideo;
  const title = image ? "图片提示词模板" : "视频提示词模板";
  const subtitle = image ? "出图这一套。" : "出片这一套，比图片多一段运动。";
  const [showDefault, setShowDefault] = useState(false);

  function update(next: string): void {
    onConfigChange(image ? { ...config, promptTemplateImage: next } : { ...config, promptTemplateVideo: next });
  }

  const defaultText = defaultTemplates && defaultTemplates !== "error" ? (image ? defaultTemplates.image : defaultTemplates.video) : "";

  return (
    <section className="flex flex-col gap-3 rounded-md border border-border-1 bg-surface-1 px-4 py-3" aria-label={title}>
      <header className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-ink-1">{title}</h3>
        <p className="text-xs text-ink-4">{subtitle}</p>
      </header>
      <Textarea
        value={value}
        disabled={!owner || busy}
        className="min-h-[140px] font-mono text-xs"
        placeholder={"留空就走平台默认模板。\n例：{风格描述}\n画面:{片段内容}\n出场:{角色}\n场景:{场景}"}
        aria-label={title}
        onChange={(event) => update(event.target.value)}
      />
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-2">能用的占位符 · 点一下插进去</span>
        <div className="flex flex-wrap gap-1.5">
          {PROMPT_TEMPLATE_PLACEHOLDERS.map((placeholder) => (
            <button
              key={placeholder}
              type="button"
              disabled={!owner || busy}
              className="rounded-full border border-border-1 bg-surface-2 px-2.5 py-0.5 font-mono text-xs text-ink-1 outline-none transition-colors hover:border-accent hover:text-accent-text focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
              onClick={() => update(insertPlaceholder(value, placeholder))}
            >{`{${placeholder}}`}</button>
          ))}
        </div>
        <p className="m-0 text-xs text-ink-4">花括号里的东西由系统在生成时填进去，你不用自己写。</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => { setShowDefault((open) => !open); if (!defaultTemplates) onLoadDefaultTemplates(); }}>
          {showDefault ? "收起平台默认模板" : "看看平台默认模板"}
        </Button>
        <Button size="sm" variant="ghost" disabled={!owner || busy || !defaultText} onClick={() => update(defaultText)}>把默认模板复制过来改</Button>
      </div>
      {showDefault ? (
        defaultTemplates === "error" ? (
          <p className="m-0 rounded-sm bg-surface-2 px-3 py-2 text-xs text-ink-2" role="status">平台默认模板暂时读不出来（后端读取口还没接好）。留空就走平台默认行为，不耽误用。</p>
        ) : defaultTemplates ? (
          <pre className="m-0 whitespace-pre-wrap rounded-sm bg-surface-2 px-3 py-2 font-mono text-xs text-ink-2">{defaultText || "（平台默认模板是空的）"}</pre>
        ) : (
          <p className="m-0 text-xs text-ink-4">正在读取平台默认模板…</p>
        )
      ) : null}
    </section>
  );
}

export function ProjectPromptsSection({ owner, busy, config, defaultTemplates, onConfigChange, onLoadDefaultTemplates, onSave }: ProjectPromptsSectionProps): React.JSX.Element {
  return (
    <section className="flex flex-col gap-4" aria-label="提示词模板">
      <p className="m-0 text-xs text-ink-2">提示词模板管的是「提示词怎么组织」，不管「长什么样」——那是「画面与风格」页签的事。</p>
      <div className="grid gap-3 md:grid-cols-2">
        <PromptTemplateCard kind="image" owner={owner} busy={busy} config={config} defaultTemplates={defaultTemplates} onConfigChange={onConfigChange} onLoadDefaultTemplates={onLoadDefaultTemplates} />
        <PromptTemplateCard kind="video" owner={owner} busy={busy} config={config} defaultTemplates={defaultTemplates} onConfigChange={onConfigChange} onLoadDefaultTemplates={onLoadDefaultTemplates} />
      </div>
      <section className="flex flex-col gap-1.5 rounded-md border border-border-1 bg-surface-2 px-4 py-3" aria-label="模板规则">
        <h3 className="text-xs font-semibold text-ink-1">不填也能用</h3>
        <p className="m-0 text-xs text-ink-2">不填就走平台默认模板。默认模板在上面看得见、能复制过来改，不是黑盒。</p>
        <h3 className="text-xs font-semibold text-ink-1">改了不追溯</h3>
        <p className="m-0 text-xs text-ink-2">改模板只影响之后的生成。已经生成过的任务，提示词不会被重写。</p>
        <h3 className="text-xs font-semibold text-ink-1">自己写的优先</h3>
        <p className="m-0 text-xs text-ink-2">如果你在生成面板里用了「我自己写、原样发送」，模板这一层就不生效——你写什么就发什么。</p>
      </section>
      {owner ? (
        <Button className="self-start" loading={busy} onClick={onSave}>保存提示词模板</Button>
      ) : (
        <p className="m-0 text-xs text-ink-4">只有项目负责人能改这些配置。</p>
      )}
    </section>
  );
}
