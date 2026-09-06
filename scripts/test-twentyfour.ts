// 二十四点规则自测：验证发牌/判24点/算式验证/渐进束缚/动态限时/结束条件。
import { twentyFourRule } from "../src/games/twentyfour";
import { GameRuleContext } from "../src/game";

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

// 直接用内部导出的纯函数测试（发牌/判24点/算式验证）
// 由于这些函数未导出，这里通过 rule 的行为间接验证。

function ctx(message: string, state: any, now: number): GameRuleContext {
  return { message, serveName: "服务对象", now, testMode: false, state };
}

// 1) 开局
const startMsg = "来玩二十四点";
const startState = twentyFourRule.tryStart(ctx(startMsg, {}, Date.now()))!;
assert(startState !== null, "说「来玩二十四点」能开局");
assert(Array.isArray((startState as any).cards) && (startState as any).cards.length === 4, "开局发 4 张牌");
assert((startState as any).round === 1, "开局是第 1 回合");
assert((startState as any).timeLimitSec === 300, "限时从 5 分钟(300秒)起步");

// 2) 公告非空
const ann = twentyFourRule.startAnnouncement(startState);
assert(ann.length > 0 && ann.includes("24"), "开局公告包含 24 点提示");

// 3) 答错一回合 → BOT 赢 + 渐进束缚到「脚」
const s1 = structuredClone(startState) as any;
const r1 = twentyFourRule.onMessage(ctx("1+1+1+1", s1, Date.now() + 1000));
assert(r1.consumed === true, "答错时 consumed");
assert(r1.ended === false, "未到收尾，不结算");
assert(s1.botWins === 1, "答错 = BOT 赢 1 回合");
assert(s1.bindLevel === 1, "BOT 赢 → 上第一级束缚（脚）");
assert(r1.rewardIntent !== undefined, "渐进束缚动作已返回");
const ra1: any[] = Array.isArray(r1.rewardIntent) ? r1.rewardIntent : [r1.rewardIntent];
assert(ra1.some((a) => a.kind === "item_put" && a.item === "LeatherAnkleCuffs"), "第一级束缚是脚铐 item_put");

// 4) 答对一回合 → 服务对象赢，不上束缚
const s2 = structuredClone(startState) as any;
s2.cards = [1, 2, 3, 4]; // 1*2*3*4 = 24
const r2 = twentyFourRule.onMessage(ctx("1*2*3*4", s2, Date.now() + 1000));
assert(r2.consumed === true, "答对时 consumed");
assert(s2.serveWins === 1, "答对 = 服务对象赢 1 回合");
assert(s2.bindLevel === 0, "服务对象赢不上束缚");
assert(r2.rewardIntent === undefined, "服务对象赢无惩罚动作");

// 5) 算式验证：用了没发的牌 → 算错
const s3 = structuredClone(startState) as any;
s3.cards = [1, 2, 3, 4];
const r3 = twentyFourRule.onMessage(ctx("5*5-1", s3, Date.now() + 1000));
assert(s3.botWins === 1, "用了没发的牌 = 答错 = BOT 赢");

// 6) 嘴束缚触发 → 游戏结束 + 全体锁
const s6 = structuredClone(startState) as any;
s6.round = 6;
s6.bindLevel = 5; // 已经上到「手」，下一步就是「嘴」
s6.cards = [1, 2, 3, 4];
const r6 = twentyFourRule.onMessage(ctx("999", s6, Date.now() + 1000)); // 答错 → 上嘴
assert(r6.ended === true, "上到嘴 → 游戏结束");
assert(r6.outcome === "lose", "嘴束缚 → 服务对象输");
const ra6: any[] = Array.isArray(r6.rewardIntent) ? r6.rewardIntent : [r6.rewardIntent];
assert(ra6.length >= 6, "结算时包含全体锁（6 个道具：脚/腿/眼罩/牵绳/手/嘴）");
assert(ra6.some((a) => a.kind === "item_put" && a.item === "BallGag"), "含口球 item_put");
assert(ra6.every((a) => a.kind === "item_lock" || a.kind === "item_put"), "动作都是 item_put/item_lock");
const locks = ra6.filter((a) => a.kind === "item_lock");
assert(locks.every((a) => a.lock === "TimerPasswordPadlock" && a.timerMin === 15), "全体锁是 15 分钟定时锁");

// 7) 最后一回合 BOT 赢（没到嘴）→ 结束 + 全体锁
const s7 = structuredClone(startState) as any;
s7.round = 10;
s7.bindLevel = 3; // 上到「眼罩」，没到嘴
s7.cards = [1, 2, 3, 4];
const r7 = twentyFourRule.onMessage(ctx("1+1", s7, Date.now() + 1000)); // 答错
assert(r7.ended === true, "第10回合 BOT 赢 → 结束");
assert(r7.outcome === "lose", "服务对象输");
const ra7: any[] = Array.isArray(r7.rewardIntent) ? r7.rewardIntent : [r7.rewardIntent];
const lock7 = ra7.filter((a) => a.kind === "item_lock");
assert(lock7.length === s7.bindLevel, `全体锁 ${s7.bindLevel} 个已上束缚（脚/腿/眼罩）`);

// 8) 第10回合服务对象赢 → 不结束，延长一回合（保证最后一回合 BOT 赢）
const s8 = structuredClone(startState) as any;
s8.round = 10;
s8.bindLevel = 2;
s8.cards = [1, 2, 3, 4];
const r8 = twentyFourRule.onMessage(ctx("1*2*3*4", s8, Date.now() + 1000)); // 答对
assert(r8.ended === false, "第10回合她赢 → 不结束，延长");
assert(s8.round === 11, "延长到第 11 回合");

// 9) 超时 → BOT 赢 + 束缚
const s9 = structuredClone(startState) as any;
s9.turnStartAt = Date.now() - 400000; // 已超时
s9.cards = [1, 2, 3, 4];
const r9 = twentyFourRule.onTimeout(ctx("", s9, Date.now()));
assert(r9 !== null, "超时轮询返回结果");
assert(s9.botWins === 1, "超时 = BOT 赢");

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
