// ===========================================================================
// 验证脚本：登录 BOT → 打印服务器返回的 FriendList（确认 addFriend 是否落地）
// 用法：先杀掉 BOT 主进程，然后 npx tsx scripts/check-friend-list.ts
// ===========================================================================

import { BCClient } from "../src/client";
import { config } from "../src/config";

const client = new BCClient();

client.onBeep = (event) => {
  console.log(
    `[check] ✓ 收到 Beep：来自 #${event.sourceNo} ${event.senderName} type=${event.beepType ?? "normal"} msg="${event.message ?? ""}"`
  );
};

async function main(): Promise<void> {
  const loginDone = new Promise<void>((resolve) => {
    client.onLogin = (player: any) => {
      console.log("[check] onLogin 触发，MemberNumber=", player.MemberNumber);
      resolve();
    };
  });
  await client.connect();
  client.login();
  await loginDone;

  // 等几秒让 AccountUpdate 之类的回声落定
  await new Promise((r) => setTimeout(r, 1500));

  const p: any = client.player;
  console.log("[check] LoginResponse.player.MemberNumber =", p.MemberNumber);
  console.log("[check] LoginResponse.player.FriendList =", JSON.stringify(p.FriendList));
  console.log("[check] client.friendList (getter) =", JSON.stringify(client.friendList));
  console.log("[check] player 上所有 key（前 30 个）:");
  for (const k of Object.keys(p).slice(0, 30)) {
    const v = p[k];
    const repr = Array.isArray(v) ? `[${v.length}]` : typeof v === "string" ? `"${v.slice(0, 40)}"` : String(v).slice(0, 60);
    console.log(`    ${k} = ${repr}`);
  }

  console.log("[check] 退出");
  client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("[check] 失败：", err);
  process.exit(1);
});