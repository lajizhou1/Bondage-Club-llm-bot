// ===========================================================================
// 一次性收场脚本：结束进行中的"限时回家"游戏 + 给服务对象解绑
// 场景：游戏进行到 waiting 期需要人为中止（用户指令），BOT 常规重启不会
//       触发结算（游戏状态在 data/gohome-state.json 持久化）。
// 用法：先杀掉 BOT 进程（避免顶号拉锯），然后 npx tsx scripts/finish-gohome.ts
// 流程：登录 → 进家 → 等同步 → 解锁全部束缚 → 移除全部束缚 → 清游戏状态
//       → 广播收场话 → 退出。之后正常启动 dist/index.js 即可。
// ===========================================================================

import { BCClient } from "../src/client";
import { stripLockProperty, ALL_LOCK_PROPERTIES } from "../src/skills";
import { clearGohomeState, loadGohomeState } from "../src/games/gohome";
import { config } from "../src/config";

const state = loadGohomeState();
console.log(
  `[finish] 当前游戏状态：phase=${state?.phase ?? "(无)"} homeRoom=${state?.homeRoom ?? "-"}`
);

const client = new BCClient();

/** Property 里出现任一锁字段 = 带锁（须先解再移除，否则接收端静默回滚移除） */
function isLocked(prop: Record<string, unknown> | null | undefined): boolean {
  if (!prop) return false;
  return ALL_LOCK_PROPERTIES.some((k) => prop[k] != null);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function finish(): Promise<void> {
  const serveNo = Number.parseInt(config.serveMember ?? "", 10);
  if (!Number.isFinite(serveNo)) {
    console.error("[finish] config.serveMember 不是数字注册号，无法定位服务对象");
    process.exit(1);
  }

  // 等 4 秒让房间成员外观同步完成（进房后服务器推 room update）
  await sleep(4000);

  const botNo = client.player.MemberNumber;
  if (botNo === undefined) {
    console.error("[finish] 拿不到自己的 MemberNumber");
    process.exit(1);
  }

  const appearance = client.getAppearance(serveNo);
  if (!appearance) {
    console.error(`[finish] 找不到 #${serveNo} 的外观数据（人不在房间里？）——只清状态不解绑`);
    clearGohomeState();
    console.log("[finish] 游戏状态已清除，退出");
    client.disconnect();
    process.exit(0);
  }

  // 只处理 Item* 束缚槽（衣服/发型等外观不动）
  const items = appearance.filter((e) => e?.Group?.startsWith("Item"));
  console.log(`[finish] ${serveNo} 身上束缚 ${items.length} 件，开始解绑`);

  for (const item of items) {
    const group = item.Group as string;
    const name = item.Name as string;
    const prop = (item.Property ?? null) as Record<string, unknown> | null;

    // 1) 带锁先解：stripLockProperty + wire 更新 + ActionUnlock 公告
    if (isLocked(prop)) {
      const unlocked = stripLockProperty(prop);
      client.sendItemUpdate(serveNo, group, name, { property: unlocked });
      client.sendChatAction("ActionUnlock", [
        { SourceCharacter: botNo },
        { Tag: "DestinationCharacter", MemberNumber: serveNo, Text: "" },
        { TargetCharacter: serveNo },
        { Tag: "PrevAsset", AssetName: name, GroupName: group },
        { Tag: "FocusAssetGroup", FocusGroupName: group },
      ]);
      client.updateCachedItem(serveNo, group, name, { property: unlocked });
      console.log(`[finish] 解锁 ${group}/${name}`);
      await sleep(450);
    }

    // 2) 移除道具：sendItemUpdate(name=null) + ActionRemove 公告
    client.sendItemUpdate(serveNo, group, null);
    client.sendChatAction("ActionRemove", [
      { SourceCharacter: botNo },
      { Tag: "DestinationCharacter", MemberNumber: serveNo, Text: "" },
      { TargetCharacter: serveNo },
      { Tag: "PrevAsset", AssetName: name, GroupName: group },
      { Tag: "FocusAssetGroup", FocusGroupName: group },
    ]);
    client.updateCachedItem(serveNo, group, null);
    console.log(`[finish] 移除 ${group}/${name}`);
    await sleep(450);
  }

  // 3) 清游戏状态（data/gohome-state.json）
  clearGohomeState();
  console.log("[finish] 游戏状态已清除");

  // 4) 收场话
  client.sendChat("[限时回家] 这局到此为止，全部解开——辛苦了，好好休息。", "Chat");

  // 等公告落地再退出
  await sleep(2500);
  console.log("[finish] 解绑完成，退出。现在可以正常启动 BOT（node dist/index.js）");
  client.disconnect();
  process.exit(0);
}

client.onLogin = (player) => {
  console.log(`[finish] 登录成功：ljzsbot #${player.MemberNumber ?? "?"}`);
  // 进家（服务对象此刻应在家里）
  client.joinRoom(config.roomName || "ljzbot");
};

client.onRoomJoined = (roomName) => {
  console.log(`[finish] 已进房：${roomName}（开始收场）`);
  void finish();
};

client.onJoinFailed = (msg) => {
  console.error(`[finish] 进房失败：${msg}，30 秒后重试`);
  setTimeout(() => client.joinRoom(config.roomName || "ljzbot"), 30000);
};

client
  .connect()
  .then(() => client.login())
  .catch((err) => {
    console.error("[finish] 连接失败:", (err as Error).message);
    process.exit(1);
  });
