// ===========================================================================
// 综合验证脚本：登录 → addFriend → 多次读 friendList → 断 → 重登 → 再读
// 用法：先杀掉 BOT 主进程，然后 npx tsx scripts/test-add-friend-full.ts
// ===========================================================================

import { BCClient } from "../src/client";
import { config } from "../src/config";

const TARGET_MEMBER = parseInt(process.argv[2] ?? "121681", 10);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loginAndShow(label: string): Promise<BCClient> {
  const client = new BCClient();
  const loginDone = new Promise<void>((resolve) => {
    client.onLogin = (p: any) => {
      console.log(`[${label}] onLogin MemberNumber=${p.MemberNumber} FriendList=${JSON.stringify(p.FriendList)}`);
      resolve();
    };
  });
  await client.connect();
  client.login();
  await loginDone;
  await sleep(800);
  console.log(`[${label}] 登录后 friendList = ${JSON.stringify(client.friendList)}`);
  return client;
}

async function main(): Promise<void> {
  // 阶段 A：登录看初始状态
  let c = await loginAndShow("A-init");
  if (!c.friendList.includes(TARGET_MEMBER)) {
    console.log(`[A] 调用 addFriend(${TARGET_MEMBER})…`);
    const ok = c.addFriend(TARGET_MEMBER);
    console.log(`[A] addFriend 返回值：${ok}，操作后本地 friendList=${JSON.stringify(c.friendList)}`);
  } else {
    console.log(`[A] ${TARGET_MEMBER} 已在 FriendList`);
  }
  await sleep(2000);
  console.log(`[A] 2s 后本地 friendList=${JSON.stringify(c.friendList)}`);
  c.disconnect();

  // 阶段 B：等几秒让 DB 落盘 + 重新登录看服务器是否接受
  await sleep(3000);
  c = await loginAndShow("B-relogin");
  console.log(`[B] 重登后 friendList=${JSON.stringify(c.friendList)} — ${c.friendList.includes(TARGET_MEMBER) ? "✓ 服务器已接受" : "✗ 服务器未持久化"}`);
  c.disconnect();

  process.exit(0);
}

main().catch((err) => {
  console.error("失败：", err);
  process.exit(1);
});