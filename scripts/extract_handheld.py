# -*- coding: utf-8 -*-
"""从 BC 官方源码提取 ItemHandheld 全部资产的 AllowActivity 映射"""
import re, json

SRC = r'C:/Users/Administrator/WorkBuddy/BC bot v1.0/.reference/bc-official/Assets_Female3DCG.js'
OUT = r'C:/Users/Administrator/WorkBuddy/BC bot v1.0/data/handheld-allow.json'

with open(SRC, encoding='utf-8') as f:
    src = f.read()

start = src.find('Group: "ItemHandheld"')
seg = src[start:]
# 组结束边界：Asset: [ 数组的配对闭合（括号计数，防字符串内括号先数一遍引号段）
ai = seg.find('Asset: [')
depth = 0
end = None
i = seg.find('[', ai)
while i < len(seg):
    ch = seg[i]
    if ch == '"':  # 跳过字符串
        j = i + 1
        while j < len(seg):
            if seg[j] == '\\':
                j += 2
                continue
            if seg[j] == '"':
                break
            j += 1
        i = j + 1
        continue
    if ch == '[':
        depth += 1
    elif ch == ']':
        depth -= 1
        if depth == 0:
            end = i + 1
            break
    i += 1
if end:
    seg = seg[:end]

assets = []
# 顶层资产块：3 tab 的 { + 4 tab 的 Name（嵌套子对象缩进更深，排除）
for mm in re.finditer(r'\n\t\t\t\{\n\t\t\t\tName:\s*"([^"]+)"', seg):
    name = mm.group(1)
    chunk = seg[mm.start(): mm.start() + 1500]
    am = re.search(r'AllowActivity:\s*\[([^\]]*)\]', chunk)
    allow = [a.strip().strip('"') for a in am.group(1).split(',') if a.strip()] if am else []
    assets.append((name, allow))

print(f'解析到 {len(assets)} 件')
out = {n: a for n, a in assets}
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

from collections import Counter
c = Counter()
for n, a in assets:
    key = ','.join(a) if a else '(无)'
    c[key] += 1
for k, v in sorted(c.items(), key=lambda x: -x[1]):
    print(f'  {k}: {v} 件')
