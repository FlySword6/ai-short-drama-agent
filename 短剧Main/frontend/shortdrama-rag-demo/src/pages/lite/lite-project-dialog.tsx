/* ============================================================
   lite-project-dialog.tsx — Lite 项目弹窗（新建/编辑统一，PRD lite.md §三 2026-08-10 拍板）

   口径（精简版不设本地管理员/角色区分）：
   - 新建与编辑共用一个弹窗；所有字段（含剧名）均可编辑；
   - 成员管理只做三件事：搜索系统用户、添加、删除——无「可编辑/仅查看」角色下拉，
     后端统一落 editor（角色调整留到完整版）；
   - 不做前端权限分层——入口对所有人放开，后端权限不通的接口如实返回错误。
   ============================================================ */
import * as React from "react";
import { Plus, Trash } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { ApiClientError, api } from "../../api";
import { navigate } from "../../routing";
import type { Project } from "../../types";
import { Button } from "../../components/ui/button";
import { Field, Input, Textarea } from "../../components/ui/primitives";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { MultiUserPicker } from "../../components/multi-user-picker";
import {
  DEMO_MEMBERS,
  forbiddenMessage,
  type ProjectMember,
  type UserDirectoryRecord,
} from "../../operations";
import { humanErrorMessage } from "../batch-generate-drawer";
import type { PageRuntimeProps } from "../global-pages";
import { liteProjectPath } from "./lite-shell";

export interface LiteProjectDialogProps {
  mode: "new" | "edit";
  /** edit 模式必填：要编辑的项目。 */
  project?: Project;
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
  /** 当前登录用户 id（搜索加成员时排除自己——自己已是创建者/负责人）。 */
  currentUserId: string;
  onClose: () => void;
  onCreated: (project: Project) => void;
  onSaved: (projectId: string, patch: { name: string; description: string }) => void;
  onDeleted: (projectId: string) => void;
}

export function LiteProjectDialog({
  mode,
  project,
  demoMode,
  notify,
  currentUserId,
  onClose,
  onCreated,
  onSaved,
  onDeleted,
}: LiteProjectDialogProps): React.JSX.Element {
  const isEdit = mode === "edit";
  const projectId = project?.id ?? null;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  /* 成员 */
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [membersError, setMembersError] = useState("");
  const [busy, setBusy] = useState(false);

  /* 删除确认 */
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /* edit 模式：水合剧名/说明 + 拉成员列表（精简版不做前端门禁，后端不通的接口如实报错）。 */
  useEffect(() => {
    if (!isEdit || !project) return;
    setName(project.name ?? "");
    setDescription(project.description ?? "");
    if (demoMode) {
      setMembers(DEMO_MEMBERS.filter((member) => member.projectId === project.id));
      return;
    }
    api.projectMembers(project.id)
      .then((items) => { setMembers(items); setMembersError(""); })
      .catch((reason: unknown) => {
        setMembersError(reason instanceof ApiClientError && reason.status === 403
          ? forbiddenMessage("member")
          : "成员列表读取失败，请稍后重试");
      });
  }, [isEdit, project, demoMode]);

  /** 精简版不在 UI 暴露角色——后端统一落 editor，角色调整留到完整版。 */
  function localMemberFrom(target: UserDirectoryRecord): ProjectMember {
    return {
      projectId: projectId ?? "",
      userId: target.id,
      username: target.username,
      displayName: target.displayName,
      platformRole: target.platformRole,
      projectRole: "editor",
      addedByUserId: null,
      createdAt: new Date().toISOString(),
    };
  }

  /* ---------- 成员动作：new 模式操作本地数组；edit 模式即时调 API ---------- */
  /** 点选/回车提交时解析出的目标用户 → 加入成员（new 模式写本地数组，edit 模式即时调 API）。 */
  function addMemberForUser(target: UserDirectoryRecord): void {
    if (target.id === currentUserId) {
      notify("你自己已经在项目里了", "error");
      return;
    }
    if (members.some((member) => member.userId === target.id)) {
      notify(`${target.displayName} 已经在成员里了`, "error");
      return;
    }
    if (isEdit && projectId) {
      void addMemberRemote(target);
    } else {
      setMembers((current) => [...current, localMemberFrom(target)]);
    }
  }

  async function addMemberRemote(target: UserDirectoryRecord): Promise<void> {
    setBusy(true);
    try {
      if (demoMode) {
        setMembers((current) => [...current.filter((member) => member.userId !== target.id), localMemberFrom(target)]);
        notify("离线演示：成员只在本地更新，未写入服务", "info");
      } else {
        const created = await api.addProjectMember(projectId!, { userId: target.id, role: "editor" });
        setMembers((current) => [...current.filter((member) => member.userId !== created.userId), created]);
        notify(`已添加 ${target.displayName}`, "success");
      }
    } catch (reason) {
      notify(reason instanceof ApiClientError && reason.status === 403 ? forbiddenMessage("member") : humanErrorMessage(reason, "加成员失败"), "error");
    } finally {
      setBusy(false);
    }
  }

  function removeMember(member: ProjectMember): void {
    if (isEdit && projectId) {
      void removeMemberRemote(member);
    } else {
      setMembers((current) => current.filter((item) => item.userId !== member.userId));
    }
  }

  async function removeMemberRemote(member: ProjectMember): Promise<void> {
    setBusy(true);
    try {
      if (demoMode) {
        setMembers((current) => current.filter((item) => item.userId !== member.userId));
        notify("离线演示：成员只在本地移除", "info");
      } else {
        await api.removeProjectMember(projectId!, member.userId);
        setMembers((current) => current.filter((item) => item.userId !== member.userId));
        notify(`已移除 ${member.displayName}`, "success");
      }
    } catch (reason) {
      notify(reason instanceof ApiClientError && reason.status === 403 ? forbiddenMessage("member") : humanErrorMessage(reason, "移除成员失败"), "error");
    } finally {
      setBusy(false);
    }
  }

  /* ---------- 新建提交：createProject → 批量加成员（best-effort）→ 进剧本页 ---------- */
  async function handleCreate(): Promise<void> {
    if (!name.trim()) {
      notify("请输入项目名称", "error");
      return;
    }
    setSaving(true);
    try {
      let created: Project;
      if (demoMode) {
        created = { id: `demo-project-${Date.now()}`, name: name.trim(), description: description.trim(), status: "进行中", episode_count: 0, asset_count: 0, shot_count: 0 };
      } else {
        created = await api.createProject({ name: name.trim(), description: description.trim() || null });
      }
      /* 预填成员逐个落（失败不阻断——项目已建，剩余可在编辑里重试）。 */
      for (const member of members) {
        if (demoMode) continue;
        try {
          await api.addProjectMember(created.id, { userId: member.userId, role: member.projectRole });
        } catch {
          notify(`加成员 ${member.displayName} 失败，可在项目编辑里重试`, "error");
        }
      }
      onCreated(created);
      notify(demoMode ? "离线示例项目只保存在当前页面，未写入服务" : "项目已创建", "success");
      onClose();
      navigate(liteProjectPath(created.id, "workspace"));
    } catch (reason) {
      notify(
        reason instanceof ApiClientError && reason.status === 403
          ? "当前账号未开通建项权限，请联系管理员开通。"
          : humanErrorMessage(reason, "创建项目失败，请重试"),
        "error",
      );
    } finally {
      setSaving(false);
    }
  }

  /* ---------- 编辑：保存剧名 + 说明 ---------- */
  async function handleSave(): Promise<void> {
    if (!projectId) return;
    if (!name.trim()) {
      notify("请输入项目名称", "error");
      return;
    }
    setSaving(true);
    try {
      if (demoMode) {
        notify("离线演示不写入项目信息", "info");
      } else {
        await api.patchProjectOperations(projectId, { name: name.trim(), description: description.trim() });
      }
      onSaved(projectId, { name: name.trim(), description: description.trim() });
      notify("项目信息已保存", "success");
      onClose();
    } catch (reason) {
      notify(humanErrorMessage(reason, "保存失败，请重试"), "error");
    } finally {
      setSaving(false);
    }
  }

  /* ---------- 删除（移入回收站）---------- */
  async function handleDelete(): Promise<void> {
    if (!projectId) return;
    setDeleting(true);
    try {
      if (demoMode) {
        notify("离线演示不会删除项目", "info");
      } else {
        await api.deleteProject(projectId);
      }
      onDeleted(projectId);
      notify("项目已移入回收站", "success");
      onClose();
      navigate("/lite");
    } catch (reason) {
      notify(humanErrorMessage(reason, "删除失败，请重试"), "error");
    } finally {
      setDeleting(false);
    }
  }

  const title = isEdit ? "编辑项目" : "新建项目";
  const descriptionText = isEdit
    ? "改名、改说明、加成员或删除项目。"
    : "输入剧名开始一部新剧；建好即进入剧本页。也可以现在就加几个成员。";

  /* 成员列表只列「其他人」——自己（owner）不出现，避免负责人条目干扰成员管理。 */
  const visibleMembers = members.filter((member) => member.projectRole !== "owner");

  /* 选人下拉只列「可加用户」（PRD 2026-08-10）：排除自己 + 已在成员表里的所有人
     （含 owner——负责人本就在项目里，再点一次只能报「已经在成员里了」死路）。 */
  const excludedPickerUserIds = [currentUserId, ...members.map((member) => member.userId)];

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="medium" className="max-h-[85dvh]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{descriptionText}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-5">
            {/* 基本信息 */}
            <div className="flex flex-col gap-3">
              <Field label="项目名称">
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如：《旧城往事》"
                  autoFocus={!isEdit}
                />
              </Field>
              <Field label="项目说明" hint="选填，一句话说这部剧讲什么">
                <Textarea
                  value={description}
                  rows={2}
                  placeholder="一句话介绍"
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
            </div>
            {/* 成员 */}
            <div className="flex flex-col gap-2.5 border-t border-border-1 pt-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-ink-2">项目成员</span>
                <span className="text-xs text-ink-4">{visibleMembers.length} 人</span>
              </div>
              {membersError ? <p className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{membersError}</p> : null}
              <MultiUserPicker
                members={visibleMembers}
                excludeUserIds={excludedPickerUserIds}
                onAdd={addMemberForUser}
                onRemove={removeMember}
                demoMode={demoMode}
                disabled={busy}
                placeholder="搜用户名或显示名添加成员"
                ariaLabel="搜索用户添加为成员"
              />
            </div>
          </div>
        </DialogBody>
        <DialogFooter className="justify-between gap-3">
          {isEdit ? (
            <Button size="sm" variant="danger-outline" icon={<Trash />} disabled={deleting} onClick={() => setConfirmDelete(true)}>删除项目</Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button onClick={onClose}>取消</Button>
            {isEdit ? (
              <Button variant="primary" loading={saving} onClick={() => void handleSave()}>保存修改</Button>
            ) : (
              <Button variant="primary" icon={<Plus />} loading={saving} onClick={() => void handleCreate()}>创建项目</Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>

      {/* ---------- 删除二次确认弹窗：点「删除项目」后弹出，二次确认才真正删除 ---------- */}
      <Dialog open={confirmDelete} onOpenChange={(open) => { if (!open && !deleting) setConfirmDelete(false); }}>
        <DialogContent size="small">
          <DialogHeader>
            <DialogTitle>删除项目</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-1">
              <p className="text-sm text-ink-1">确定删除「{name.trim() || "未命名项目"}」吗？</p>
              <p className="text-xs text-ink-2">删除后项目将移入回收站，可在回收站中恢复。</p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button disabled={deleting} onClick={() => setConfirmDelete(false)}>取消</Button>
            <Button variant="danger" icon={<Trash />} loading={deleting} onClick={() => void handleDelete()}>确认删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
