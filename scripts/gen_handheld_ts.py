# -*- coding: utf-8 -*-
"""生成 skills.ts 手持道具表 + 手持动作表的 TS 代码"""
import json

with open(r'C:/Users/Administrator/WorkBuddy/BC bot v1.0/data/handheld-final.json', encoding='utf-8') as f:
    handheld = json.load(f)

ACT_CN = {
    'SpankItem': '拍打',
    'RubItem': '摩擦/抚摸',
    'TickleItem': '挠痒',
    'BrushItem': '梳头',
    'SqueezeItem': '挤压',
    'RollItem': '滚动',
    'EatItem': '喂食',
    'SipItem': '喂饮',
    'PourItem': '倾倒/滴落',
    'Inject': '注射',
    'ShockItem': '电击',
    'MasturbateItem': '刺激敏感部位',
    'ThrowItem': '投掷',
    'Scratch': '轻挠',
}
ZONES = {
    'SpankItem': ['ItemArms', 'ItemBoots', 'ItemBreast', 'ItemButt', 'ItemFeet', 'ItemLegs', 'ItemNipples', 'ItemPelvis', 'ItemTorso', 'ItemVulva', 'ItemVulvaPiercings'],
    'RubItem': ['ItemArms', 'ItemBoots', 'ItemBreast', 'ItemButt', 'ItemEars', 'ItemFeet', 'ItemHood', 'ItemLegs', 'ItemMouth', 'ItemNeck', 'ItemNipples', 'ItemNose', 'ItemPelvis', 'ItemTorso', 'ItemVulva', 'ItemVulvaPiercings'],
    'TickleItem': ['ItemArms', 'ItemBoots', 'ItemBreast', 'ItemButt', 'ItemEars', 'ItemFeet', 'ItemHood', 'ItemLegs', 'ItemMouth', 'ItemNeck', 'ItemNipples', 'ItemNose', 'ItemPelvis', 'ItemTorso', 'ItemVulva', 'ItemVulvaPiercings'],
    'BrushItem': ['ItemHead'],
    'SqueezeItem': ['ItemHands'],
    'RollItem': ['ItemArms', 'ItemBoots', 'ItemBreast', 'ItemButt', 'ItemEars', 'ItemFeet', 'ItemLegs', 'ItemMouth', 'ItemNeck', 'ItemNipples', 'ItemPelvis', 'ItemTorso'],
    'EatItem': ['ItemMouth'],
    'SipItem': ['ItemMouth'],
    'PourItem': ['ItemArms', 'ItemBoots', 'ItemBreast', 'ItemButt', 'ItemFeet', 'ItemLegs', 'ItemNipples', 'ItemPelvis', 'ItemTorso'],
    'Inject': ['ItemArms', 'ItemBreast', 'ItemButt', 'ItemFeet', 'ItemLegs', 'ItemNeck'],
    'ShockItem': ['ItemArms', 'ItemBoots', 'ItemBreast', 'ItemButt', 'ItemFeet', 'ItemLegs', 'ItemNeck', 'ItemNipples', 'ItemPelvis', 'ItemTorso', 'ItemVulva', 'ItemVulvaPiercings'],
    'MasturbateItem': ['ItemBreast', 'ItemButt', 'ItemFeet', 'ItemLegs', 'ItemNipples', 'ItemPelvis', 'ItemVulva', 'ItemVulvaPiercings'],
    'ThrowItem': ['ItemHead', 'ItemMouth', 'ItemBreast', 'ItemTorso', 'ItemFeet'],
    'Scratch': ['ItemArms', 'ItemBoots', 'ItemBreast', 'ItemButt', 'ItemEars', 'ItemFeet', 'ItemHands', 'ItemHead', 'ItemLegs', 'ItemMouth', 'ItemNeck', 'ItemNipples', 'ItemNose', 'ItemPelvis', 'ItemTorso'],
}
# PenetrateItem：catalog 无官方定义，强 NSFW——#53 一起做，暂不开放

lines = []
lines.append('export interface HandheldDef {')
lines.append('  cn: string;')
lines.append('  /** 支持的手持动作（空数组=纯视觉道具，只能拿不能用于动作） */')
lines.append('  allow: string[];')
lines.append('}')
lines.append('')
lines.append('export const HANDHELD_ITEMS: Record<string, HandheldDef> = {')
for name, v in handheld.items():
    allow = [a for a in v['allow'] if a != 'PenetrateItem']
    allow_str = ', '.join(f'"{a}"' for a in allow)
    lines.append(f'  {name}: {{ cn: "{v["cn"]}", allow: [{allow_str}] }},')
lines.append('};')
lines.append('')
lines.append('export interface HandheldActivityDef {')
lines.append('  cn: string;')
lines.append('  zones: string[];')
lines.append('}')
lines.append('')
lines.append('export const HANDHELD_ACTIVITIES: Record<string, HandheldActivityDef> = {')
for act, cn in ACT_CN.items():
    zones_str = ', '.join(f'"{z}"' for z in ZONES[act])
    lines.append(f'  {act}: {{ cn: "{cn}", zones: [{zones_str}] }},')
lines.append('};')

out = '\n'.join(lines)
with open(r'C:/Users/Administrator/WorkBuddy/BC bot v1.0/data/handheld-table.generated.ts', 'w', encoding='utf-8') as f:
    f.write(out)
print(f'生成 {len(handheld)} 件道具 + {len(ACT_CN)} 个动作 -> data/handheld-table.generated.ts')
print(f'共 {len(out)} 字符')
