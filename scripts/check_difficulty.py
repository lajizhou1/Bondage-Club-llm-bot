# -*- coding: utf-8 -*-
"""从 skills.ts 提取白名单道具清单，再从官方 Female3DCG.js 核实基础难度"""
import re

src = open("src/skills.ts", encoding="utf-8").read()
m = re.search(r"ITEM_SKILLS[^=]*=\s*\{(.*?)\n\};", src, re.S)
body = m.group(1)
# 条目格式: Key: { group: "Group", cn: "..." }
entries = re.findall(r'"?([A-Za-z_]+)"?\s*:\s*\{\s*group:\s*"([^"]+)"', body)

# 发送名：ITEM_SEND_NAME 映射（无映射则 key 即发送名）
send_m = re.search(r"ITEM_SEND_NAME[^=]*=\s*\{(.*?)\};", src, re.S)
send_map = dict(re.findall(r'"([^"]+)"\s*:\s*"([^"]+)"', send_m.group(1))) if send_m else {}

asset_src = open(".reference/bc-fetch/Female3DCG.js", encoding="utf-8").read()

def find_difficulty(send):
    pat = re.compile(r'Name:\s*"' + re.escape(send) + r'",(.{0,400}?)(?=\n\t\t\t\tName:|\Z)', re.S)
    found = []
    for mm in pat.finditer(asset_src):
        dm = re.search(r"Difficulty:\s*(\d+)", mm.group(1))
        if dm:
            found.append(int(dm.group(1)))
    return found

for key, group in entries:
    send = send_map.get(key, key)
    print(f"{key}: {group}/{send} -> Difficulty: {find_difficulty(send)}")
print("count:", len(entries))
