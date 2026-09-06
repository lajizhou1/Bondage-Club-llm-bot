// ===========================================================================
// #20 游戏框架自测（不依赖 LLM / BC 服务器）
// 用一个模拟的"猜数字"规则验证框架抽象：状态机、拦截、奖惩、超时、中止。
// 运行：npx tsx scripts/test-game.ts
// ===========================================================================

import { GameManager, GameRule, GameRuleContext, GameState, GameTurnResult } from "../src/game";

// ---------------------------------------------------------------------------
// 模拟规则：猜数字（1-10，BOT 心里想一个数，服务对象猜）
// ---------------------------------------------------------------------------
const guessNumber: GameRule = {
  id: "guess",
  name: "猜数字",
  tryStart(ctx: GameRuleContext): GameState | null {
    if (!/^猜数字|玩猜数字|来猜数字/.test(ctx.message)) return null;
    // 代码层生成答案（确定性，不靠 LLM）
    return { answer: 7, attempts: 0, maxAttempts: 5 };
  },
  startAnnouncement(state: GameState): string {
    return `来玩猜数字，我心里想了个 1-10 的数，你有 ${state.maxAttempts} 次机会。`;
  },
  onMessage(ctx: GameRuleContext): GameTurnResult {
    const m = ctx.message.trim();
    // 中止口令
    if (/不玩了|放弃|退出游戏/.test(m)) {
      return { consumed: true, ended: true, outcome: "abort", reply: "好，不玩了。" };
    }
    const n = Number.parseInt(m, 10);
    if (Number.isNaN(n) || n < 1 || n > 10) {
      return { consumed: true, ended: false, reply: "说个 1 到 10 之间的数。" };
    }
    const attempts = ((ctx.state.attempts as number) + 1);
    ctx.state.attempts = attempts;
    const answer = ctx.state.answer as number;
    if (n === answer) {
      return { consumed: true, ended: true, outcome: "win", reply: `猜对了，就是 ${answer}！`, rewardText: "服务对象赢了，奖励" };
    }
    if (attempts >= (ctx.state.maxAttempts as number)) {
      return { consumed: true, ended: true, outcome: "lose", reply: `机会用完了，答案是 ${answer}。`, rewardText: "服务对象输了，惩罚" };
    }
    return { consumed: true, ended: false, reply: n < answer ? "小了，再猜。" : "大了，再猜。" };
  },
  describeState(ctx: GameRuleContext): string {
    return `猜数字：已猜 ${ctx.state.attempts}/${ctx.state.maxAttempts} 次。`;
  },
  settle(outcome): { kind: "none" } {
    // 奖励/惩罚：这里返回 none，真实游戏（二十四点）会返回 item_* 动作
    console.log(`    [settle] outcome=${outcome} → 奖惩由规则模块决定`);
    return { kind: "none" };
  },
};

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

async function main(): Promise<void> {
  console.log("=== #20 游戏框架自测 ===\n");

  const gm = new GameManager();

  // 1. 初始空闲
  assert(gm.active === false, "初始状态为 idle");
  assert(gm.describeState() === "", "空闲时 describeState 返回空串");

  // 2. 非开局消息 → 不拦截
  let r = await gm.handleServeMessage(guessNumber, "你好", "服务对象", false);
  assert(r === null, "非开局消息返回 null（不拦截）");

  // 3. 开局
  r = await gm.handleServeMessage(guessNumber, "来猜数字", "服务对象", false);
  assert(r !== null && r.consumed === true && r.ended === false, "开局消息 consumed=true 且未结束");
  assert(r!.reply!.includes("5 次机会"), "开局公告包含次数");
  assert(gm.active === true, "开局后 active=true");
  assert(gm.describeState().includes("0/5"), "describeState 注入当前回合");

  // 4. 猜错 → 继续
  r = await gm.handleServeMessage(guessNumber, "3", "服务对象", false);
  assert(r!.reply === "小了，再猜。", "猜小了给出提示");
  assert(r!.ended === false, "猜错未结束");
  assert(gm.describeState().includes("1/5"), "回合数推进到 1/5");

  // 5. 非法输入 → 提示但不推进
  r = await gm.handleServeMessage(guessNumber, "abc", "服务对象", false);
  assert(r!.reply === "说个 1 到 10 之间的数。", "非法输入提示");
  assert(gm.describeState().includes("1/5"), "非法输入不推进回合");

  // 6. 猜对 → 结算 win
  r = await gm.handleServeMessage(guessNumber, "7", "服务对象", false);
  assert(r!.ended === true && r!.outcome === "win", "猜对结算 win");
  assert(r!.reply!.includes("7"), "结算回复包含答案");
  assert(gm.active === false, "结算后回到 idle");

  // 7. 再开局，测试中止
  await gm.handleServeMessage(guessNumber, "来猜数字", "服务对象", false);
  r = await gm.handleServeMessage(guessNumber, "不玩了", "服务对象", false);
  assert(r!.ended === true && r!.outcome === "abort", "中止口令结算 abort");
  assert(gm.active === false, "中止后回到 idle");

  // 8. 再开局，测试连错到上限 → lose
  await gm.handleServeMessage(guessNumber, "来猜数字", "服务对象", false);
  for (const g of ["1", "2", "3", "4", "5"]) {
    r = await gm.handleServeMessage(guessNumber, g, "服务对象", false);
  }
  assert(r!.ended === true && r!.outcome === "lose", "连错到上限结算 lose");
  assert(gm.active === false, "lose 后回到 idle");

  // 9. 安全词中止（通过 abort 方法）
  await gm.handleServeMessage(guessNumber, "来猜数字", "服务对象", false);
  const abortedRule = gm.abort("safe-word");
  assert(abortedRule?.id === "guess", "abort 返回被中止的规则");
  assert(gm.active === false, "abort 后回到 idle");

  gm.dispose();
  console.log("\n=== 全部通过 ✅ ===");
}

main().catch((e) => {
  console.error("自测异常:", e);
  process.exit(1);
});
