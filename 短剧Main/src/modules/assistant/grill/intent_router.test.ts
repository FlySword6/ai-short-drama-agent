/**
 * IntentRouter 边界用例测试
 *
 * 覆盖六层 Pipeline 的关键路径：
 * - 闲聊/问候识别（不含动作词的短文本）
 * - 任务指令识别（含动作词）
 * - 复合意图（动作词 + 闲聊词 → task 优先）
 * - 确认/取消指令
 * - 上下文修正（clarifying/pending_confirmation 状态）
 * - 主题切换检测
 * - 边界用例（空输入、超长截断、全角标点、纯标点）
 *
 * 纯代码，零 LLM，用 node:test 框架。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyIntent, classifyIntentSimple, type SessionState } from "./intent_router.js";

// ── 辅助：断言意图类别 ──

function assertIntent(input: string, expected: string, state: SessionState = "idle") {
  const result = classifyIntent(input, state);
  assert.equal(result.category, expected,
    `input="${input}" expected="${expected}" got="${result.category}" (${result.reason})`);
}

// ── 1. 闲聊/问候 ──

describe("IntentRouter: 闲聊/问候", () => {
  it("你好 → chat", () => {
    assertIntent("你好", "chat");
  });

  it("您好 → chat", () => {
    assertIntent("您好", "chat");
  });

  it("hi → chat", () => {
    assertIntent("hi", "chat");
  });

  it("早上好 → chat", () => {
    assertIntent("早上好", "chat");
  });

  it("谢谢 → chat", () => {
    assertIntent("谢谢", "chat");
  });

  it("在吗 → chat", () => {
    assertIntent("在吗", "chat");
  });

  it("你是谁 → chat", () => {
    assertIntent("你是谁", "chat");
  });

  it("嗯 → chat", () => {
    assertIntent("嗯", "chat");
  });

  it("再见 → chat", () => {
    assertIntent("再见", "chat");
  });
});

// ── 2. 任务指令 ──

describe("IntentRouter: 任务指令", () => {
  it("帮我生成一张图片 → task", () => {
    assertIntent("帮我生成一张图片", "task");
  });

  it("写一个短剧 → task", () => {
    assertIntent("写一个短剧", "task");
  });

  it("画一幅古风插画 → task", () => {
    assertIntent("画一幅古风插画", "task");
  });

  it("制作一段视频 → task", () => {
    assertIntent("制作一段视频", "task");
  });

  it("创建一个角色 → task", () => {
    assertIntent("创建一个角色", "task");
  });

  it("设计一个logo → task", () => {
    assertIntent("设计一个logo", "task");
  });
});

// ── 3. 复合意图（动作词优先） ──

describe("IntentRouter: 复合意图", () => {
  it("你好，帮我生成一张图 → task（动作词优先）", () => {
    assertIntent("你好，帮我生成一张图", "task");
  });

  it("在吗？我想写个剧本 → task", () => {
    assertIntent("在吗？我想写个剧本", "task");
  });

  it("谢谢，请帮我画个猫 → task", () => {
    assertIntent("谢谢，请帮我画个猫", "task");
  });
});

// ── 4. 确认/取消 ──

describe("IntentRouter: 确认与取消", () => {
  it("确认 → confirm", () => {
    assertIntent("确认", "confirm");
  });

  it("开始生成 → confirm", () => {
    assertIntent("开始生成", "confirm");
  });

  it("执行 → confirm", () => {
    assertIntent("执行", "confirm");
  });

  it("ok → confirm", () => {
    assertIntent("ok", "confirm");
  });

  it("好的 → confirm", () => {
    assertIntent("好的", "confirm");
  });

  it("取消 → cancel", () => {
    assertIntent("取消", "cancel");
  });

  it("算了 → cancel", () => {
    assertIntent("算了", "cancel");
  });

  it("不生成了 → cancel", () => {
    assertIntent("不生成了", "cancel");
  });
});

// ── 5. 上下文修正 ──

describe("IntentRouter: 上下文修正", () => {
  it("clarifying 状态下'你好' → chat_but_in_clarifying", () => {
    assertIntent("你好", "chat_but_in_clarifying", "clarifying");
  });

  it("clarifying 状态下'谢谢' → chat_but_in_clarifying", () => {
    assertIntent("谢谢", "chat_but_in_clarifying", "clarifying");
  });

  it("clarifying 状态下'取消' → cancel（不退化）", () => {
    assertIntent("取消", "cancel", "clarifying");
  });

  it("clarifying 状态下'确认' → confirm（不退化）", () => {
    assertIntent("确认", "confirm", "clarifying");
  });

  it("pending_confirmation 状态下'改成古风' → amend", () => {
    assertIntent("改成古风", "amend", "pending_confirmation");
  });

  it("pending_confirmation 状态下'换一种风格' → amend", () => {
    assertIntent("换一种风格", "amend", "pending_confirmation");
  });

  it("pending_confirmation 状态下'不要写实了' → amend", () => {
    assertIntent("不要写实了", "amend", "pending_confirmation");
  });
});

// ── 6. 主题切换检测 ──

describe("IntentRouter: 主题切换", () => {
  it("clarifying 状态下新动作词 → task_switch=true", () => {
    const result = classifyIntent("帮我画一幅水墨画", "clarifying");
    assert.ok(result.task_switch, `expected task_switch=true, got false (${result.reason})`);
  });

  it("pending_confirmation 状态下新动作词 → task_switch=true", () => {
    const result = classifyIntent("生成一个新视频", "pending_confirmation");
    assert.ok(result.task_switch, `expected task_switch=true, got false (${result.reason})`);
  });

  it("idle 状态下动作词 → task_switch=false", () => {
    const result = classifyIntent("帮我画一幅水墨画", "idle");
    assert.equal(result.task_switch, false);
  });
});

// ── 7. 边界用例 ──

describe("IntentRouter: 边界用例", () => {
  it("空字符串 → chat", () => {
    assertIntent("", "chat");
  });

  it("纯空格 → chat", () => {
    assertIntent("   ", "chat");
  });

  it("全角逗号被正确处理", () => {
    const result = classifyIntent("你好，帮我生成一张图");
    assert.equal(result.category, "task");
  });

  it("超长输入被截断但不报错", () => {
    const longInput = "生成" + "a".repeat(600);
    const result = classifyIntent(longInput);
    assert.ok(result.reason.includes("truncated") || result.category === "task");
  });

  it("纯问号 → chat", () => {
    assertIntent("？？？", "chat");
  });

  it("短文本无关键词 → chat", () => {
    assertIntent("嗯嗯", "chat");
  });

  it("长文本无动作词 → vague", () => {
    assertIntent("这是一个关于古风仙侠的故事背景设定", "vague");
  });

  it("置信度在 [0,1] 范围内", () => {
    const result = classifyIntent("帮我生成一张图");
    assert.ok(result.confidence >= 0 && result.confidence <= 1,
      `confidence=${result.confidence} out of range`);
  });
});

// ── 8. 简化接口 classifyIntentSimple ──

describe("IntentRouter: classifyIntentSimple", () => {
  it("chat → chat", () => {
    assert.equal(classifyIntentSimple("你好"), "chat");
  });

  it("task → task", () => {
    assert.equal(classifyIntentSimple("生成一张图"), "task");
  });

  it("confirm → confirm", () => {
    assert.equal(classifyIntentSimple("确认"), "confirm");
  });

  it("chat_but_in_clarifying → chat", () => {
    assert.equal(classifyIntentSimple("你好", "clarifying"), "chat");
  });

  it("cancel → task", () => {
    assert.equal(classifyIntentSimple("取消"), "task");
  });

  it("amend → task", () => {
    assert.equal(classifyIntentSimple("改成古风", "pending_confirmation"), "task");
  });
});

// ── 9. 预处理层 ──

describe("IntentRouter: 预处理", () => {
  it("控制字符被移除", () => {
    const result = classifyIntent("你好\x00\x01");
    assert.equal(result.category, "chat");
  });

  it("多段文本被正确分析", () => {
    const result = classifyIntent("你好，帮我生成一张图片，要古风风格的");
    assert.equal(result.category, "task");
  });
});

// ── 10. Bug 8-5: clarifying 状态下 vague 词汇测试 ──

describe("IntentRouter: Bug 8-5 vague 词汇误判修复", () => {
  it("clarifying 状态下'不知道' → vague（不是 task）", () => {
    assertIntent("不知道", "vague", "clarifying");
  });

  it("clarifying 状态下'不清楚' → vague（不是 task）", () => {
    assertIntent("不清楚", "vague", "clarifying");
  });

  it("clarifying 状态下'随便' → vague（不是 task）", () => {
    assertIntent("随便", "vague", "clarifying");
  });

  it("clarifying 状态下'都行' → vague（不是 task）", () => {
    assertIntent("都行", "vague", "clarifying");
  });

  it("clarifying 状态下'都可以' → vague（不是 task）", () => {
    assertIntent("都可以", "vague", "clarifying");
  });

  it("clarifying 状态下'没想法' → vague（不是 task）", () => {
    assertIntent("没想法", "vague", "clarifying");
  });

  it("clarifying 状态下'不确定' → vague（不是 task）", () => {
    assertIntent("不确定", "vague", "clarifying");
  });

  it("clarifying 状态下'无所谓' → vague（不是 task）", () => {
    assertIntent("无所谓", "vague", "clarifying");
  });

  it("clarifying 状态下正常短回答'热血' → task（保持不变）", () => {
    assertIntent("热血", "task", "clarifying");
  });

  it("clarifying 状态下正常短回答'古风' → task（保持不变）", () => {
    assertIntent("古风", "task", "clarifying");
  });
});
