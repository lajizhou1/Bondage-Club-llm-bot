# -*- coding: utf-8 -*-
"""对比 catalog 82 件 vs 源码提取 86 件，生成最终手持道具表（名字+中文+AllowActivity）"""
import json

with open(r'C:/Users/Administrator/WorkBuddy/BC bot v1.0/data/bc-catalog.json', encoding='utf-8') as f:
    catalog = json.load(f)
with open(r'C:/Users/Administrator/WorkBuddy/BC bot v1.0/data/handheld-allow.json', encoding='utf-8') as f:
    allow_map = json.load(f)

cat_items = {i['name']: i for i in catalog['items'] if i.get('group') == 'ItemHandheld'}
print(f'catalog: {len(cat_items)} 件，源码提取: {len(allow_map)} 件')

only_src = [n for n in allow_map if n not in cat_items]
only_cat = [n for n in cat_items if n not in allow_map]
print('只在源码（catalog 没收）:', only_src)
print('只在 catalog（源码没提取到）:', only_cat)

# 生成最终表：源码为基准（86 件），补 catalog 中文名
misc_cn = {}
for i in catalog['items']:
    if i.get('group') == 'ItemMisc' and i.get('cn'):
        misc_cn[i['name']] = i['cn']

merged = {}
for name, allow in allow_map.items():
    cn = cat_items.get(name, {}).get('cn') or cat_items.get(name, {}).get('en') or misc_cn.get(name, '') or ''
    merged[name] = {'cn': cn, 'allow': allow}
for name in only_cat:  # catalog 有但源码没提到的（应该没有）
    merged[name] = {'cn': cat_items[name].get('cn', ''), 'allow': []}

with open(r'C:/Users/Administrator/WorkBuddy/BC bot v1.0/data/handheld-final.json', 'w', encoding='utf-8') as f:
    json.dump(merged, f, ensure_ascii=False, indent=1)
print(f'最终表 {len(merged)} 件 -> data/handheld-final.json')
# 无中文名的列出来
noidx = [n for n, v in merged.items() if not v['cn']]
print('无中文名：', noidx)
