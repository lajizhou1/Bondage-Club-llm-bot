// ===========================================================================
// 一次性测试脚本：登录 BOT → 调用 client.addFriend(#目标, 目标名)
//                验证 AccountUpdate{FriendList:[…]} 能成功加好友，
//                以及 onBeep 通道是否在线（停留几秒等待 Beep 回声）。
// 用法：先杀掉 BOT 进程（避免顶号），然后 npx tsx scripts/test-add-friend.ts
// ===========================================================================

import { BCClient } from "../src/client";
import { config } from "../src/config";

const TARGET_MEMBER = 123456; // 目标注册号（换成你要测试的号）
const WAIT_FOR_BEEP_MS = 25_000;

const client = new BCClient();

client.onBeep = (event) => {
  console.log(
    `[test] ✓ 收到 Beep：来自 #${event.sourceNo} ${event.senderName} type=${event.beepType ?? "normal"} msg="${event.message ?? ""}"`
  );
};

async function main(): Promise<void> {
  await client.connect();
  await client.login(config.bcUsername, config.bcPassword);

  console.log(`[test] 当前 BOT FriendList=[${client.friendList.join(", ")}]`);
  console.log(`[test] 尝试把 #${TARGET_MEMBER}（药）加入 BOT 好友列表…`);

  const ok = client.addFriend(TARGET_MEMBER);
  console.log(`[test] addFriend 返回值：${ok}`);

  // 短暂等待服务器 AccountUpdate 应答（不专门监听，next join 自然会拿到最新列表）
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`[test] 提交后 BOT FriendList=[${client.friendList.join(", ")}]`);

  console.log(
    `[test] 现在停 ${WAIT_FOR_BEEP_MS / 1000}s 等待对方（药）发来的 Beep（验证 onBeep 通道）—`
  );
  console.log(`[test] 提示：让"药"在 BC 客户端右键菜单给 BOT 发一个普通 Beep（带任意留言）`);
  await new Promise((r) => setTimeout(r, WAIT_FOR_BEEP_MS));

  console.log(`[test] 等待结束，退出`);
  client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("[test] 失败：", err);
  process.exit(1);
});