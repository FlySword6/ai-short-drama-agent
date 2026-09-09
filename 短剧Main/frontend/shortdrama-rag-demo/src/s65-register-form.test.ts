/* ============================================================
   s65-register-form.test.ts — 注册表单 组件渲染 + 错误文案断言
   （2026-08-04 按 issue #26 合同改写：邀请码从可选改必填，只认固定码）

   硬规矩：文案类断言必须组件渲染（renderToStaticMarkup），不只读源码字符串。
   覆盖：
   ① 注册表单初始渲染：邮箱/验证码/密码/显示名(可选)/邀请码(必填)齐全，发送按钮在；
   ② 发送/倒计时/重发三态（SendCodeButton 纯组件直喂 props）；
   ③ 错误码人话映射（稳定错误码表）：503 邮件通道未接、验证码三态、邮箱已注册、
      邀请码缺/错（不给「清码继续」出路）、积分账户未就绪；
   ④ 发送成功提示按 expires_at 算分钟，不硬编码 TTL。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiClientError } from "./api";
import {
  RegisterForm,
  SendCodeButton,
  codeSentNote,
  registerErrorMessage,
  sendCodeErrorMessage,
} from "./pages/register-form";

const noopAsync = async () => {};

function renderForm(): string {
  return renderToStaticMarkup(React.createElement(RegisterForm, { sendCode: noopAsync, register: noopAsync }));
}

test("S65-A 渲染：注册表单字段齐全——邮箱/验证码/密码/显示名(可选)/邀请码(必填)", () => {
  const html = renderForm();
  assert.ok(html.includes('type="email"'), "缺邮箱输入框");
  assert.ok(html.includes("验证码"), "缺验证码标签");
  assert.ok(html.includes('maxLength="6"'), "验证码框限 6 位");
  assert.ok(html.includes("发送验证码"), "缺发送验证码按钮");
  assert.ok(html.includes("密码"), "缺密码标签");
  assert.ok(html.includes("显示名称（可选）"), "显示名应标注可选");
  assert.ok(html.includes("邀请码"), "缺邀请码字段");
  assert.ok(!html.includes("邀请码（可选）"), "issue #26 起邀请码必填，不得再标可选");
  assert.ok(html.includes("找管理员领取"), "邀请码必填要给「去哪领」的方向");
  assert.ok(html.includes("注册并登录"), "缺提交按钮");
  assert.ok(!html.includes("手机"), "手机号注册未实现（合同 §2），表单不得出现");
});

test("S65-A 渲染：发送按钮三态——初始可发/倒计时禁用/发过后可重发", () => {
  const idle = renderToStaticMarkup(React.createElement(SendCodeButton, { sending: false, countdown: 0, sentOnce: false, onSend: () => {} }));
  assert.ok(idle.includes("发送验证码"));
  assert.ok(!idle.includes("disabled"), "初始态不应禁用");

  const counting = renderToStaticMarkup(React.createElement(SendCodeButton, { sending: false, countdown: 42, sentOnce: true, onSend: () => {} }));
  assert.ok(counting.includes("42 秒后重发"), "倒计时要明示剩余秒数");
  assert.ok(counting.includes("disabled"), "倒计时中应禁用");

  const resent = renderToStaticMarkup(React.createElement(SendCodeButton, { sending: false, countdown: 0, sentOnce: true, onSend: () => {} }));
  assert.ok(resent.includes("重新发送"));
  assert.ok(!resent.includes("disabled"), "倒计时结束应可重发");
});

test("S65-A 文案：503 邮件通道未接时说人话「请联系管理员开通」，不抛技术错误", () => {
  const reason = new ApiClientError("email delivery unavailable", { status: 503, code: "email_delivery_unavailable" });
  const message = sendCodeErrorMessage(reason);
  assert.ok(message.includes("验证码暂时发不出"), "缺降级主文案");
  assert.ok(message.includes("联系管理员开通"), "缺出路（联系管理员）");
  assert.ok(!message.includes("503"), "不得裸露 HTTP 状态码");
  assert.ok(!message.includes("email_delivery_unavailable"), "不得裸露错误码");
});

test("S65-A 文案：注册错误码逐条映射（issue #26 稳定错误码表）", () => {
  const make = (code: string, status = 422) => new ApiClientError(code, { status, code });
  assert.ok(registerErrorMessage(make("email_verification_invalid")).includes("验证码不对"));
  assert.ok(registerErrorMessage(make("email_verification_expired")).includes("已过期"));
  assert.ok(registerErrorMessage(make("email_verification_attempts_exhausted")).includes("重新发送"));
  const exists = registerErrorMessage(make("email_exists", 409));
  assert.ok(exists.includes("已经注册过") && exists.includes("登录"), "email_exists 应引导去登录");
  const required = registerErrorMessage(make("invite_code_required"));
  assert.ok(required.includes("需要邀请码"), "缺邀请码要直说必填");
  assert.ok(required.includes("找管理员"), "缺邀请码要给「去哪领」的方向");
  const invite = registerErrorMessage(make("invite_code_invalid"));
  assert.ok(invite.includes("邀请码不正确"), "邀请码错误要直说");
  assert.ok(invite.includes("向管理员确认"), "邀请码错误要给确认方向");
  assert.ok(!invite.includes("清空邀请码"), "邀请码问题不得再给「清码继续注册」出路（#26 硬规则）");
  const unavailable = registerErrorMessage(make("account_credit_unavailable", 503));
  assert.ok(unavailable.includes("积分账户暂未就绪"), "积分账户未就绪要说人话");
});

test("S65-A 文案：参数错误透传服务端人话（如密码位数），网络错误给重试方向", () => {
  const badRequest = new ApiClientError("密码至少需要 8 位", { status: 400, code: "invalid_request" });
  assert.equal(registerErrorMessage(badRequest), "密码至少需要 8 位");
  const offline = new ApiClientError("无法连接服务，请确认后端已启动", { code: "network_error" });
  assert.ok(sendCodeErrorMessage(offline).includes("连不上服务"));
  assert.ok(registerErrorMessage(offline).includes("连不上服务"));
});

test("S65-A 文案：发送成功提示按 expires_at 算有效分钟，不硬编码 TTL", () => {
  const now = Date.parse("2026-07-28T10:00:00Z");
  assert.ok(codeSentNote("2026-07-28T10:10:00Z", now).includes("10 分钟内有效"));
  assert.equal(codeSentNote(undefined, now), "验证码已发出，请尽快填写");
});
