// 奖惩动作库自测：验证 RewardCatalog 的预设动作字段完整、翻译正确。
import { RewardCatalog, RewardAction } from "../src/game";
import { checkItem, checkLock, checkLockable } from "../src/skills";

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}

const all = RewardCatalog.list();
console.log(`预设动作共 ${all.length} 个：`);
for (const { name, desc } of all) console.log(`  · ${name} —— ${desc}`);
console.log("");

// 1) 每个预设都能被 get() 取到，且字段非空
for (const { name } of all) {
  const a = RewardCatalog.get(name);
  assert(a !== null, `get("${name}") 返回非空`);
  if (!a) continue;
  assert(a.kind !== "none", `${name} 的 kind 已设定`);
  assert(!!a.desc, `${name} 带 desc 说明`);
}

// 2) 道具名必须都在白名单（checkItem）
const putItems = all
  .map((x) => RewardCatalog.get(x.name)!)
  .filter((a) => a.kind === "item_put");
for (const a of putItems) {
  const c = checkItem(a.item!);
  assert(c.ok, `item_put 道具 "${a.item}" 在白名单`);
  if (a.variant) {
    // variant 存在时也做一次基本存在性（不深究变体表，仅确认非空）
    assert(a.variant.length > 0, `变体 "${a.variant}" 非空`);
  }
}

// 3) 锁名必须在白名单，且上锁对象必须是可锁道具
const lockActions = all
  .map((x) => RewardCatalog.get(x.name)!)
  .filter((a) => a.kind === "item_lock");
for (const a of lockActions) {
  const lk = checkLock(a.lock!);
  assert(lk.ok, `锁 "${a.lock}" 在白名单`);
  const it = checkItem(a.item!);
  if (it.ok && it.group && it.name) {
    assert(checkLockable(it.group, it.name), `道具 "${a.item}" 可上锁`);
  }
  if (a.combination) {
    assert(/^\d{4}$/.test(a.combination), `数字密码 "${a.combination}" 是 4 位`);
  }
  if (a.timerMin !== undefined) {
    assert(a.timerMin > 0, `定时时长 ${a.timerMin} 分钟为正`);
  }
}

// 4) 目标默认：应落到服务对象（字段为空，由 executeReward 兜底填 config.serveMember）
const noExplicitTarget = all
  .map((x) => RewardCatalog.get(x.name)!)
  .filter((a) => !a.target);
assert(noExplicitTarget.length === all.length, "所有预设默认不显式指定 target（交给 executeReward 兜底）");

// 5) 中文名翻译示例验证
const example: RewardAction = RewardCatalog.get("中罚·密码锁口球")!;
assert(example.kind === "item_lock", "中罚·密码锁口球 → kind=item_lock");
assert(example.item === "BallGag", "  item=BallGag");
assert(example.lock === "CombinationPadlock", "  lock=CombinationPadlock");
assert(example.combination === "6806", "  combination=6806");

const rewardExample = RewardCatalog.get("奖励·摘下口塞")!;
assert(rewardExample.kind === "item_remove", "奖励·摘下口塞 → kind=item_remove");
assert(rewardExample.slot === "ItemMouth", "  slot=ItemMouth");

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
