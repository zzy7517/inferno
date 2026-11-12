#!/usr/bin/env python3
"""
Inferno — 剑盾不死人生成脚本（ADR-0003：脚本即事实源）

形体：球/锥/环低多边形（平面着色，和场景里的方块敌人同一套语言）。
  部件先在世界坐标里拼成人形，再按骨骼父矩阵挂回去——漏掉骨骼矩阵的话，
  剑、盾、四肢会在运行时被再变换一次，整个人散开。
  待机是垂臂持剑、盾在身前，不是水平 T 字。

产出:
  web/public/assets/character.glb          骨骼+九动画 clip
  web/public/assets/character_frames.json  帧数据（与动画关键帧同源，单一事实源）

用法: blender -b -P tools/blender/build_character.py
"""
import bpy
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "web" / "public" / "assets"
FPS = 30

# ============================================================
# 帧数据（单一事实源：动画关键帧时长必须与这里的秒数一致）
# ============================================================
FRAME_DATA = {
    "fps": FPS,
    "clips": {
        "idle":   {"loop": True, "duration": 120 / FPS},
        "attack": {  # R1 单手横斩
            "startup": 6 / FPS,       # f1-f6   前摇
            "active": 3 / FPS,        # f7-f9   判定帧
            "recovery": 18 / FPS,     # f10-f27 后摇
            "cancelFrom": 0.55,       # 后摇 55% 后可翻滚取消（ADR-0004 取消窗口）
            "total": 27 / FPS,
        },
        "roll":   {  # 快速翻滚
            "total": 21 / FPS,
            "iframes": [0.04, 0.30],  # 无敌帧窗口（combat-feel.md 起始参数）
        },
        "walk":        {"loop": True, "duration": 24 / FPS},
        "block_idle":  {"loop": True, "duration": 40 / FPS},
        "parry":       {"total": 14 / FPS, "window": [0.08, 0.20]},  # 弹反判定窗口
        "estus":       {"total": 33 / FPS, "healAt": 0.55},
        "hurt":        {"total": 12 / FPS},
        "death":       {"total": 24 / FPS},   # 关键帧到 f24（终态无取消逻辑）
        # ---- DS3 直剑完全表·新招（战斗数值/精力在 web/src/config.ts 的 P/PMOVES）----
        "runAttack": {  # 跑攻·跳步直刺（疾跑 R1）：位移 1.8m 由代码 lunge 驱动
            "startup": 0.18, "active": 0.12, "recovery": 0.42,
            "cancelFrom": 0.5, "total": 0.72,
        },
        "rollAttack": {  # 翻滚攻·起身横扫（翻滚 60% 处精确衔接）
            "startup": 0.14, "active": 0.12, "recovery": 0.34,
            "cancelFrom": 0.55, "total": 0.60,
        },
        "backstep": {  # 后撤步（静止空格）：后跃 1.6m 代码驱动，无敌帧 0.08-0.16
            "total": 0.45, "iframes": [0.08, 0.16], "chainFrom": 0.18,
        },
        "backstepAttack": {  # 后撤攻·后撤直刺（后撤 0.18s 后可接 R1）
            "startup": 0.16, "active": 0.12, "recovery": 0.36,
            "cancelFrom": 0.55, "total": 0.64,
        },
        "kick": {  # 踢击（W+R1 轻点）：破盾——对格挡敌人打崩姿态，对 Boss 仅微量伤害
            "startup": 0.22, "active": 0.10, "recovery": 0.40,
            "cancelFrom": 0.6, "total": 0.72,
        },
        "stance": {"total": 0.60},  # 战技·架势（长按 F ≥0.35s）：0.6s 内左键突刺/右键上挑
        "stancePoke": {  # 架势派生·左键 盾冲突刺（高削韧）
            "startup": 0.20, "active": 0.12, "recovery": 0.48,
            "cancelFrom": 0.5, "total": 0.80,
        },
        "stanceUp": {  # 架势派生·右键 上挑（击飞小怪）
            "startup": 0.24, "active": 0.14, "recovery": 0.52,
            "cancelFrom": 0.5, "total": 0.90,
        },
    },
}

# ============================================================
# 工具
# ============================================================
def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    # 假用户 action 会留在已打开的 Blender 里。导出模式是 ACTIONS，
    # 不删的话旧 clip 会跟新 clip 一起进 GLB，游戏仍播到旧的那条。
    for act in list(bpy.data.actions):
        act.use_fake_user = False
        bpy.data.actions.remove(act)

def make_mat(name, color, rough=0.85, metal=0.0, emission=None, emission_strength=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")

    def put(pred, value):
        sock = next((i for i in bsdf.inputs if pred(i)), None)
        if sock is not None:
            sock.default_value = value
            return True
        return False

    put(lambda i: i.name in ("Base Color", "Base Colour"), (*color, 1.0))
    put(lambda i: "Roughness" in i.name, rough)
    put(lambda i: i.name.startswith("Metallic"), metal)
    if emission is not None and emission_strength > 0:
        # 自发光走 Principled 的 Emission，glTF 才会写成 emissive，雾夜里才读得到
        put(lambda i: i.name in ("Emission Color", "Emission Colour", "Emission"), (*emission, 1.0))
        put(lambda i: "Strength" in i.name and "Emission" in i.name, emission_strength)
    return mat

def _shade(obj):
    """平面着色。平滑法线在雾夜里会把分件糊成一块泥。"""
    for p in obj.data.polygons:
        p.use_smooth = False
    return obj

def _add(obj, name, loc, mat, rot=(0, 0, 0), scale=(1, 1, 1)):
    obj.name = name
    obj.rotation_mode = "XYZ"
    obj.location = loc
    obj.rotation_euler = rot
    obj.scale = scale
    if not obj.users_collection:                    # primitive_* 已自动挂 collection
        bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj

def make_sphere(name, loc, mat, r, seg=16, ring=12, rot=(0, 0, 0), scale=(1, 1, 1)):
    """UV 球（平滑着色）：头盔/肩甲/拳/髋等圆润件。"""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=ring, radius=r,
                                         location=(0, 0, 0), rotation=rot)
    return _shade(_add(bpy.context.active_object, name, loc, mat, rot=rot, scale=scale))

def make_cone(name, loc, mat, r1, r2, depth, seg=12, rot=(0, 0, 0), scale=(1, 1, 1)):
    """圆台（平滑着色）：渐细四肢/躯干/剑刃（r2=0 即锥尖）。"""
    bpy.ops.mesh.primitive_cone_add(vertices=seg, radius1=r1, radius2=r2, depth=depth,
                                    location=(0, 0, 0), rotation=rot)
    return _shade(_add(bpy.context.active_object, name, loc, mat, rot=rot, scale=scale))

def make_cyl(name, loc, mat, r, depth, seg=12, rot=(0, 0, 0), scale=(1, 1, 1)):
    """圆柱（平滑着色）：剑柄/脖颈等。"""
    bpy.ops.mesh.primitive_cylinder_add(vertices=seg, radius=r, depth=depth,
                                        location=(0, 0, 0), rotation=rot)
    return _shade(_add(bpy.context.active_object, name, loc, mat, rot=rot, scale=scale))

def make_torus(name, loc, mat, r, tube, seg=20, rot=(0, 0, 0), scale=(1, 1, 1)):
    """环（平滑着色）：盾缘/盔沿。"""
    bpy.ops.mesh.primitive_torus_add(major_segments=seg, minor_segments=8,
                                     major_radius=r, minor_radius=tube,
                                     location=(0, 0, 0), rotation=rot)
    return _shade(_add(bpy.context.active_object, name, loc, mat, rot=rot, scale=scale))

def make_box(name, size, loc, mat):
    """轴对齐盒子（平直着色）：眼缝等小件。"""
    sx, sy, sz = (s / 2 for s in size)
    verts = [
        (-sx, -sy, -sz), (sx, -sy, -sz), (sx, sy, -sz), (-sx, sy, -sz),
        (-sx, -sy, sz), (sx, -sy, sz), (sx, sy, sz), (-sx, sy, sz),
    ]
    faces = [
        (0, 1, 2, 3), (7, 6, 5, 4), (4, 5, 1, 0),
        (6, 7, 3, 2), (5, 6, 2, 1), (7, 4, 0, 3),
    ]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = loc
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj

def attach_to_bone(obj, arm_obj, bone_name):
    """挂到骨骼并保持当前世界变换。

    Blender 的骨骼父级原点在骨尖，父矩阵是「骨架世界 × 骨骼姿态 × 骨长」，
    不是骨架世界。只写 armature.matrix_world.inverted() 时，网格局部坐标仍是
    创作时的世界坐标；glTF 里骨骼再乘一次，剑、盾、四肢就飞离躯干。
    parent_set(keep_transform=True) 会把这段父矩阵收进 parent inverse。
    """
    world = obj.matrix_world.copy()
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = arm_obj
    arm_obj.data.bones.active = arm_obj.data.bones[bone_name]
    bpy.ops.object.parent_set(type="BONE", keep_transform=True)
    bpy.context.view_layer.update()
    got = obj.matrix_world
    drift = max(abs(got[i][j] - world[i][j]) for i in range(4) for j in range(4))
    if drift > 1e-4:
        raise RuntimeError(f"{obj.name} -> {bone_name} 绑定后世界矩阵漂移 {drift:.6f}")

# ============================================================
# 1. 骨架（names 带 .L/.R，glTF 原样导出）—— 与 v1 完全一致
# ============================================================
BONES = [
    # (name, head, parent)
    ("Hips", (0, 0, 0.96), None),
    ("Spine", (0, 0, 1.06), "Hips"),
    ("Chest", (0, 0, 1.18), "Spine"),
    ("Neck", (0, 0, 1.46), "Chest"),
    ("Head", (0, 0, 1.56), "Neck"),
    ("UpperArm.L", (0.20, 0, 1.42), "Chest"),
    ("LowerArm.L", (0.42, 0, 1.42), "UpperArm.L"),
    ("Hand.L", (0.60, 0, 1.42), "LowerArm.L"),
    ("UpperArm.R", (-0.20, 0, 1.42), "Chest"),
    ("LowerArm.R", (-0.42, 0, 1.42), "UpperArm.R"),
    ("Hand.R", (-0.60, 0, 1.42), "LowerArm.R"),
    ("UpperLeg.L", (0.11, 0, 0.92), "Hips"),
    ("LowerLeg.L", (0.11, 0, 0.52), "UpperLeg.L"),
    ("Foot.L", (0.11, 0, 0.12), "LowerLeg.L"),
    ("UpperLeg.R", (-0.11, 0, 0.92), "Hips"),
    ("LowerLeg.R", (-0.11, 0, 0.52), "UpperLeg.R"),
    ("Foot.R", (-0.11, 0, 0.12), "LowerLeg.R"),
]

def build_armature():
    arm = bpy.data.armatures.new("Rig")
    arm_obj = bpy.data.objects.new("Undead", arm)
    bpy.context.collection.objects.link(arm_obj)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")
    heads = {n: h for n, h, _ in BONES}
    parent_of = {n: p for n, _, p in BONES}
    children = {}
    for n, _, p in BONES:
        children.setdefault(p, []).append(n)
    for name, head, parent in BONES:
        eb = arm.edit_bones.new(name)
        eb.head = head
        kids = children.get(name, [])
        if kids:
            eb.tail = heads[kids[0]]          # 指向子关节
        elif name.startswith("Foot"):
            eb.tail = (head[0], head[1] + 0.16, head[2] + 0.02)   # 朝前
        elif name.startswith("Hand"):
            eb.tail = (head[0] + (0.09 if ".L" in name else -0.09), head[1], head[2])
        else:
            eb.tail = (head[0], head[1], head[2] + 0.14)
        if parent:
            eb.parent = arm.edit_bones[parent]
            eb.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm_obj

# ============================================================
# 2. 部件（世界坐标创作，再挂到骨骼）
#    轮廓优先：巨盔、肩甲留在肩上、披风从肩垂到小腿、关节互相咬合。
#    面朝 +Y 时右手在 +X（骨名 .L）。
# ============================================================
M_CLOTH = make_mat("cloth", (0.09, 0.08, 0.075), 0.95)
M_LIMB  = make_mat("limb",  (0.14, 0.13, 0.12), 0.9)
M_BODY  = make_mat("body",  (0.20, 0.19, 0.17), 0.75, metal=0.25)
M_METAL = make_mat("metal", (0.34, 0.33, 0.30), 0.48, metal=0.62)
M_STEEL = make_mat("steel", (0.70, 0.72, 0.74), 0.28, metal=0.85)
M_RUST  = make_mat("rust",  (0.36, 0.16, 0.11), 0.62, metal=0.28)
M_DARK  = make_mat("dark",  (0.05, 0.05, 0.055), 0.7)
# 火是唯一强调色（ADR-0006）：刃口亮、眼缝只留一点余烬，盔甲本身仍是冷灰
M_EMBER = make_mat("ember", (0.45, 0.12, 0.04), 0.4, metal=0.2,
                   emission=(1.0, 0.38, 0.08), emission_strength=2.4)
M_COAL  = make_mat("coal",  (0.06, 0.02, 0.015), 0.55,
                   emission=(1.0, 0.28, 0.06), emission_strength=0.7)
M_CLOTH.use_backface_culling = False

RY90 = (0, math.radians(90), 0)

def make_cape():
    """从肩后垂到小腿的斗篷。上窄下宽，两侧微微向前包，下摆后掠。不是一块竖板。"""
    cols, rows = 7, 11
    verts = []
    for j in range(rows):
        t = j / (rows - 1)
        z = 1.64 - t * 0.72                 # 上沿埋进盔底，下摆停在大腿
        y = -0.14 - 0.07 * t - 0.04 * t * t
        half = 0.12 + 0.10 * t              # 肩甲之间收窄，下摆再打开
        for i in range(cols):
            u = (i / (cols - 1)) * 2.0 - 1.0          # -1..1
            x = u * half
            wrap = (abs(u) ** 1.6) * (0.05 + 0.04 * t)
            sag = (1.0 - u * u) * 0.045 * t
            verts.append((x, y + wrap, z - sag))
    faces = []
    for j in range(rows - 1):
        for i in range(cols - 1):
            a = j * cols + i
            faces.append((a, a + 1, a + cols + 1, a + cols))
    mesh = bpy.data.meshes.new("Cape")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("Cape", mesh)
    bpy.context.collection.objects.link(obj)
    _shade(obj)
    obj.data.materials.append(M_CLOTH)
    return obj

def build_parts(arm_obj):
    # —— 躯干：肩宽、胸甲是一块板，不是一颗球 ——
    make_sphere("Pelvis", (0, 0, 0.97), M_BODY, 0.13, seg=10, ring=8, scale=(1.35, 0.82, 0.72))
    make_cone("TorsoLower", (0, 0, 1.10), M_BODY, 0.145, 0.165, 0.22, seg=8)
    make_cone("Chest", (0, 0, 1.32), M_BODY, 0.155, 0.205, 0.28, seg=8)
    make_sphere("ChestPlate", (0, 0.07, 1.33), M_METAL, 0.15, seg=10, ring=8, scale=(1.15, 0.38, 0.82))
    make_torus("Belt", (0, 0, 1.015), M_DARK, 0.155, 0.018, seg=14)
    make_cone("TassetL", (0.13, 0.04, 0.90), M_METAL, 0.075, 0.04, 0.18, seg=6)
    make_cone("TassetR", (-0.13, 0.04, 0.90), M_METAL, 0.075, 0.04, 0.18, seg=6)
    make_cyl("Neck", (0, 0, 1.52), M_LIMB, 0.05, 0.12, seg=8)
    make_cone("Gorget", (0, 0.015, 1.56), M_METAL, 0.085, 0.11, 0.16, seg=8)

    # —— 巨盔坐进领甲，别飘在肩上。眼缝嵌在盔的前脸 ——
    make_sphere("Head", (0, 0.02, 1.66), M_DARK, 0.09, seg=8, ring=6)
    make_sphere("Helm", (0, 0.02, 1.67), M_METAL, 0.125, seg=10, ring=8, scale=(1.04, 0.92, 1.02))
    make_box("Brow", (0.16, 0.03, 0.022), (0, 0.10, 1.72), M_METAL)
    make_box("EyeSlit", (0.13, 0.02, 0.028), (0, 0.112, 1.685), M_COAL)

    # —— 肩甲扣在胸上，上沿抵住盔沿 ——
    make_sphere("PauldronL", (0.24, 0.015, 1.52), M_METAL, 0.11, seg=8, ring=6, scale=(1.15, 1.05, 0.58))
    make_sphere("PauldronR", (-0.24, 0.015, 1.52), M_METAL, 0.11, seg=8, ring=6, scale=(1.15, 1.05, 0.58))

    # —— 手臂：钻进肩甲和手腕，别在关节处断开 ——
    make_cone("UArmL", (0.32, 0, 1.44), M_LIMB, 0.062, 0.05, 0.28, seg=7, rot=RY90)
    make_cone("UArmR", (-0.32, 0, 1.44), M_LIMB, 0.062, 0.05, 0.28, seg=7, rot=RY90)
    make_cone("LArmL", (0.51, 0, 1.43), M_LIMB, 0.048, 0.04, 0.22, seg=7, rot=RY90)
    make_cone("LArmR", (-0.51, 0, 1.43), M_LIMB, 0.048, 0.04, 0.22, seg=7, rot=RY90)
    make_sphere("HandL", (0.64, 0.01, 1.43), M_LIMB, 0.05, seg=8, ring=6, scale=(0.9, 0.85, 1.2))
    make_sphere("HandR", (-0.64, 0.01, 1.43), M_LIMB, 0.05, seg=8, ring=6, scale=(0.9, 0.85, 1.2))

    # —— 腿：大腿咬进骨盆，靴子接住小腿 ——
    make_cone("ThighL", (0.11, 0, 0.72), M_LIMB, 0.088, 0.068, 0.44, seg=7)
    make_cone("ThighR", (-0.11, 0, 0.72), M_LIMB, 0.088, 0.068, 0.44, seg=7)
    make_cone("ShinL", (0.11, 0, 0.32), M_LIMB, 0.064, 0.048, 0.42, seg=7)
    make_cone("ShinR", (-0.11, 0, 0.32), M_LIMB, 0.064, 0.048, 0.42, seg=7)
    make_sphere("KneeL", (0.11, 0.035, 0.52), M_METAL, 0.055, seg=8, ring=6, scale=(0.85, 0.7, 0.85))
    make_sphere("KneeR", (-0.11, 0.035, 0.52), M_METAL, 0.055, seg=8, ring=6, scale=(0.85, 0.7, 0.85))
    make_sphere("FootL", (0.11, 0.09, 0.07), M_DARK, 0.078, seg=8, ring=6, scale=(0.75, 1.9, 0.58))
    make_sphere("FootR", (-0.11, 0.09, 0.07), M_DARK, 0.078, seg=8, ring=6, scale=(0.75, 1.9, 0.58))

    make_cape()

    # —— 剑在右手（+X / Hand.L）。握点不动，只把刃做长、护手做宽，远看认得出 ——
    make_cyl("Grip", (0.645, 0, 1.62), M_DARK, 0.016, 0.15, seg=8)
    make_box("Guard", (0.22, 0.028, 0.038), (0.645, 0, 1.535), M_METAL)
    make_sphere("Pommel", (0.645, 0, 1.705), M_METAL, 0.028, seg=8, ring=6)
    make_cone("Blade", (0.645, 0, 1.10), M_STEEL, 0.003, 0.036, 0.88, seg=6, scale=(1.0, 0.20, 1.0))
    # 刃口一条窄余烬，贴在钢刃朝前的一侧，远看能把剑从披风里认出来
    make_cone("BladeEdge", (0.645, 0.02, 1.12), M_EMBER, 0.001, 0.012, 0.78, seg=4, scale=(1.0, 0.18, 1.0))

    # —— 圆盾在左手 ——
    shield_rot = (math.radians(72), 0, 0)
    make_cyl("Shield", (-0.545, 0.08, 1.36), M_RUST, 0.20, 0.032, seg=16, rot=shield_rot)
    make_torus("ShieldRim", (-0.558, 0.10, 1.36), M_METAL, 0.198, 0.012, seg=16, rot=shield_rot)
    make_sphere("ShieldBoss", (-0.52, 0.11, 1.36), M_METAL, 0.048, seg=8, ring=6, scale=(0.5, 1, 1))

    BONE_OF = {
        "Pelvis": "Hips", "TorsoLower": "Spine", "Chest": "Chest", "ChestPlate": "Chest",
        "Belt": "Hips", "TassetL": "Hips", "TassetR": "Hips",
        "Neck": "Neck", "Gorget": "Neck",
        "Head": "Head", "Helm": "Head", "Brow": "Head", "EyeSlit": "Head",
        "PauldronL": "Chest", "PauldronR": "Chest",
        "UArmL": "UpperArm.L", "UArmR": "UpperArm.R",
        "LArmL": "LowerArm.L", "LArmR": "LowerArm.R",
        "HandL": "Hand.L", "HandR": "Hand.R",
        "ThighL": "UpperLeg.L", "ThighR": "UpperLeg.R",
        "ShinL": "LowerLeg.L", "ShinR": "LowerLeg.R",
        "KneeL": "LowerLeg.L", "KneeR": "LowerLeg.R",
        "FootL": "Foot.L", "FootR": "Foot.R",
        "Cape": "Chest",
        "Grip": "Hand.L", "Guard": "Hand.L", "Pommel": "Hand.L", "Blade": "Hand.L", "BladeEdge": "Hand.L",
        "Shield": "LowerArm.R", "ShieldRim": "LowerArm.R", "ShieldBoss": "LowerArm.R",
    }
    for name, bone in BONE_OF.items():
        attach_to_bone(bpy.data.objects[name], arm_obj, bone)

# ============================================================
# 3. 动画（pose 关键帧 → 独立 action → NLA 轨道）
#    待机 / 走 / 翻滚 / 格挡 / 弹反 / 原素瓶 / 受击 / 死亡 / 架势的时长不动。
#    攻击：前摇停在蓄力，命中窗里 3 帧扫过，再过冲，后摇回 STANCE。
# ============================================================
RAD = math.radians

def pose_bones(arm_obj):
    for pb in arm_obj.pose.bones:
        pb.rotation_mode = "XYZ"
    return arm_obj.pose.bones

def key(pb, frame, rot=None, loc=None):
    if rot is not None:
        pb.rotation_euler = rot
        pb.keyframe_insert("rotation_euler", frame=frame)
    if loc is not None:
        pb.location = loc
        pb.keyframe_insert("location", frame=frame)

def begin_action(arm_obj, name, start):
    if arm_obj.animation_data is None:
        arm_obj.animation_data_create()
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    track = arm_obj.animation_data.nla_tracks.new()
    track.name = name
    # strip 一律落在 frame 1（各占一条 NLA 轨道，同帧不冲突）：
    # 导出的关键帧时间即 0 基，three.js 从 t=0 播放才对得上帧数据表
    track.strips.new(name, 1, action)
    arm_obj.animation_data.action = action
    return action

# 书写约定：这里的 .R 仍当「持剑臂」来摆（历史关键帧都写在 .R 上）。
# 导出前 swap_arm_sides 会把左右臂通道对调、Z 欧拉取反，
# 挥砍才落到真正拿剑的那只手（骨名 .L，+X，面朝 +Y 时的右手）。
STANCE = {  # 待机：剑垂在身侧，盾收在身前。f1 / 收尾都回到这里
    "Chest":      {"rot": (RAD(8), 0, 0)},
    "Spine":      {"rot": (RAD(4), 0, 0)},
    "Head":       {"rot": (RAD(-6), 0, 0)},
    "UpperArm.R": {"rot": (RAD(-42), 0, RAD(-22))},  # 持剑臂下垂，剑尖朝下
    "LowerArm.R": {"rot": (RAD(-8), 0, 0)},
    "UpperArm.L": {"rot": (RAD(-34), 0, RAD(36))},   # 持盾臂前收
    "LowerArm.L": {"rot": (RAD(-68), 0, RAD(-12))},
}

def apply_stance(pbs, frame):
    for bone, p in STANCE.items():
        key(pbs[bone], frame, rot=p["rot"])

def stamp(pbs, frames, pose):
    """同一姿势打到多帧上，前摇才停得住，而不是顺着贝塞尔从第一帧滑到命中。"""
    if isinstance(frames, int):
        frames = (frames,)
    done = set()
    for frame in frames:
        if frame in done:
            continue
        done.add(frame)
        for bone, spec in pose.items():
            key(pbs[bone], frame, rot=spec.get("rot"), loc=spec.get("loc"))

def hit_window(clip):
    """startup/active 秒数 → 1 基帧。attack 的 6/30、3/30 得到前摇到 f6、命中 f7–f9。"""
    c = FRAME_DATA["clips"][clip]
    wind = round(c["startup"] * FPS)
    active_end = round((c["startup"] + c["active"]) * FPS)
    print(f"INFERNO_HIT {clip} hold_until=f{wind} active=f{wind + 1}-f{active_end}")
    return wind, active_end

def body_pose(hips, chest, sword, forearm, shield=(-34, 0, 36), shield_fore=(-68, 0, -12),
              head=(-6, 0, 0), spine=(4, 0, 0),
              thigh_l=(0, 0, 0), shin_l=(0, 0, 0), thigh_r=(0, 0, 0), shin_r=(0, 0, 0)):
    """度数。sword / forearm 写在 .R 上，导出前 swap_arm_sides 才落到持剑的 .L。"""
    def e(d):
        return (RAD(d[0]), RAD(d[1]), RAD(d[2]))
    return {
        "Hips": {"loc": hips},
        "Chest": {"rot": e(chest)},
        "Spine": {"rot": e(spine)},
        "Head": {"rot": e(head)},
        "UpperArm.R": {"rot": e(sword)},
        "LowerArm.R": {"rot": e(forearm)},
        "UpperArm.L": {"rot": e(shield)},
        "LowerArm.L": {"rot": e(shield_fore)},
        "UpperLeg.L": {"rot": e(thigh_l)},
        "LowerLeg.L": {"rot": e(shin_l)},
        "UpperLeg.R": {"rot": e(thigh_r)},
        "LowerLeg.R": {"rot": e(shin_r)},
    }

def hang_pose(hips=(0, 0, 0.96)):
    """待机垂剑。角度与 STANCE 一致。"""
    return body_pose(hips, (8, 0, 0), (-42, 0, -22), (-8, 0, 0))

def guard_pose():
    """架势基准，与 _stance_pose 同一套角度。盾的小臂不另弯。"""
    return body_pose(
        (0, 0.01, 0.92), (10, 0, 8), (-8, 0, -52), (-78, 0, 0),
        shield=(-15, 0, -45), shield_fore=(0, 0, 0),
        head=(-8, 0, 0), spine=(2, 0, 0),
        thigh_l=(18, 0, 0), shin_l=(20, 0, 0), thigh_r=(-12, 0, 0), shin_r=(18, 0, 0),
    )

def recover_stance(pbs, frame):
    apply_stance(pbs, frame)
    key(pbs["Hips"], frame, loc=(0, 0, 0.96))
    for b in ("UpperLeg.L", "LowerLeg.L", "UpperLeg.R", "LowerLeg.R"):
        key(pbs[b], frame, rot=(0, 0, 0))

def unwrap_sword_end(pbs, frame, z_deg):
    """收势和待机是同一个姿势。Z 多写一圈，刺击回收才顺着短路回来。"""
    key(pbs["UpperArm.R"], frame, rot=(RAD(-42), 0, RAD(z_deg)))
    key(pbs["LowerArm.R"], frame, rot=(RAD(-8), 0, 0))

def anim_idle(arm_obj, start=1):
    begin_action(arm_obj, "idle", start)
    pbs = pose_bones(arm_obj)
    for f, breathe in [(1, 0), (30, 1), (60, 0), (90, -1), (120, 0)]:
        frame = f
        apply_stance(pbs, frame)
        key(pbs["Chest"], frame, rot=(RAD(6 + 1.4 * breathe), 0, 0))
        key(pbs["Head"], frame, rot=(RAD(-6 - 0.8 * breathe), RAD(3 * breathe), 0))
        key(pbs["Hips"], frame, loc=(0, 0, 0.96 - 0.008 * breathe))

def anim_attack(arm_obj, start=200):
    """27f 横斩。f3–f6 剑停在肩后，f7–f9 水平扫过身体，f12 过冲，f27 回待机。"""
    begin_action(arm_obj, "attack", start)
    pbs = pose_bones(arm_obj)
    wind, active_end = hit_window("attack")
    assert (wind, active_end) == (6, 9), (wind, active_end)
    # 蓄力：剑在肩后（Z≈-50）。命中窗把剑送到身体另一侧（Z 过 0 到 +40），高度保住。
    charge = body_pose(
        (0, 0, 0.95), (8, 0, 16), (0, 0, -50), (-85, 0, 0),
        head=(-4, 0, 8), spine=(6, 0, 6),
    )
    leaving = body_pose(
        (0, 0, 0.95), (8, 0, 2), (-30, 0, -8), (-48, 0, 0),
        head=(-2, 0, 2), spine=(4, 0, 0),
    )
    across = body_pose(
        (0, 0, 0.95), (8, 0, -12), (-70, 0, 28), (-18, 0, 0),
        head=(-2, 0, -6), spine=(4, 0, -6),
    )
    passed = body_pose(
        (0, 0.01, 0.955), (6, 0, -20), (-68, 0, 42), (-8, 0, 0),
        head=(-2, 0, -10), spine=(2, 0, -8),
    )
    over = body_pose(
        (0, 0.02, 0.96), (4, 0, -28), (-58, 0, 55), (-4, 0, 0),
        head=(0, 0, -12), spine=(2, 0, -10),
    )
    stamp(pbs, 1, hang_pose())
    stamp(pbs, (3, wind), charge)
    stamp(pbs, wind + 1, leaving)     # f7
    stamp(pbs, wind + 2, across)      # f8 剑横在胸前
    stamp(pbs, active_end, passed)    # f9 已经扫到另一侧
    stamp(pbs, active_end + 3, over)  # f12
    recover_stance(pbs, 27)

def anim_roll(arm_obj, start=400):
    """21f=0.7s：前滚翻，原地滚（M0 无位移系统）"""
    begin_action(arm_obj, "roll", start)
    pbs = pose_bones(arm_obj)
    apply_stance(pbs, 1)
    # —— f3 蜷身蓄力
    key(pbs["Hips"], 3, loc=(0, 0.05, 0.62), rot=(RAD(30), 0, 0))
    key(pbs["Spine"], 3, rot=(RAD(40), 0, 0))
    key(pbs["UpperLeg.L"], 3, rot=(RAD(-70), 0, 0))
    key(pbs["UpperLeg.R"], 3, rot=(RAD(-70), 0, 0))
    key(pbs["LowerLeg.L"], 3, rot=(RAD(80), 0, 0))
    key(pbs["LowerLeg.R"], 3, rot=(RAD(80), 0, 0))
    # —— f4-f18 髋关节整圈前翻
    for f, ang in [(4, 30), (7, -60), (11, -180), (15, -300), (18, -355)]:
        key(pbs["Hips"], f, loc=(0, 0.05 + (0.25 if 4 <= f <= 17 else 0), 0.60 if 4 <= f <= 17 else 0.70), rot=(RAD(ang), 0, 0))
    # —— f20 伸展落地，f21 回待机
    key(pbs["Hips"], 20, loc=(0, 0.05, 0.90), rot=(RAD(-4), 0, 0))
    apply_stance(pbs, 21)
    key(pbs["Hips"], 21, loc=(0, 0, 0.96), rot=(0, 0, 0))

def anim_walk(arm_obj, start=600):
    """24f 循环步行：双腿摆动+髋部起伏，待机姿态叠加"""
    begin_action(arm_obj, "walk", start)
    pbs = pose_bones(arm_obj)
    for f, phase in [(1, 0), (7, 1), (13, 0), (19, -1), (24, 0)]:
        apply_stance(pbs, f)
        key(pbs["UpperLeg.L"], f, rot=(RAD(-32 * phase), 0, 0))
        key(pbs["UpperLeg.R"], f, rot=(RAD(32 * phase), 0, 0))
        key(pbs["LowerLeg.L"], f, rot=(RAD(20 + 25 * max(0, phase)), 0, 0))
        key(pbs["LowerLeg.R"], f, rot=(RAD(20 + 25 * max(0, -phase)), 0, 0))
        key(pbs["Hips"], f, loc=(0, 0, 0.95 - 0.015 * abs(phase)))

def anim_block(arm_obj, start=800):
    """40f 循环举盾：左臂横档胸前，重心微沉"""
    begin_action(arm_obj, "block_idle", start)
    pbs = pose_bones(arm_obj)
    for f, breathe in [(1, 0), (20, 1), (40, 0)]:
        apply_stance(pbs, f)
        key(pbs["UpperArm.L"], f, rot=(RAD(-35 - 2 * breathe), 0, RAD(-75)))
        key(pbs["LowerArm.L"], f, rot=(RAD(-55), 0, RAD(-15)))
        key(pbs["UpperArm.R"], f, rot=(RAD(-15), 0, RAD(30)))   # 剑回收警戒
        key(pbs["Hips"], f, loc=(0, 0, 0.94))

def anim_parry(arm_obj, start=1000):
    """14f 盾击弹反：f3-f7 盾向前推（window 0.08-0.20s ≈ f2.4-f6）"""
    begin_action(arm_obj, "parry", start)
    pbs = pose_bones(arm_obj)
    # 起手 = 举盾姿态
    apply_stance(pbs, 1)
    key(pbs["UpperArm.L"], 1, rot=(RAD(-35), 0, RAD(-75)))
    key(pbs["LowerArm.L"], 1, rot=(RAD(-55), 0, RAD(-15)))
    # 盾猛推向前（判定窗）
    key(pbs["UpperArm.L"], 4, rot=(RAD(-70), 0, RAD(-30)))
    key(pbs["LowerArm.L"], 4, rot=(RAD(-15), 0, RAD(0)))
    key(pbs["Chest"], 4, rot=(RAD(-6), 0, RAD(-10)))   # 上身前顶
    # 收回举盾
    key(pbs["UpperArm.L"], 8, rot=(RAD(-40), 0, RAD(-60)))
    key(pbs["LowerArm.L"], 8, rot=(RAD(-45), 0, RAD(-10)))
    apply_stance(pbs, 14)

def anim_estus(arm_obj, start=1200):
    """33f 原素瓶：左手举起饮用，f16(0.53s) 低头，f18 后回复"""
    begin_action(arm_obj, "estus", start)
    pbs = pose_bones(arm_obj)
    apply_stance(pbs, 1)
    key(pbs["UpperArm.L"], 8, rot=(RAD(-120), 0, RAD(-30)))   # 举瓶到面前
    key(pbs["LowerArm.L"], 8, rot=(RAD(-90), 0, 0))
    key(pbs["Head"], 10, rot=(RAD(-25), 0, 0))                 # 仰头
    key(pbs["Head"], 16, rot=(RAD(-30), 0, 0))
    key(pbs["Head"], 22, rot=(RAD(-8), 0, 0))
    apply_stance(pbs, 33)

def anim_hurt(arm_obj, start=1400):
    """12f 受击趔趄：上身后仰"""
    begin_action(arm_obj, "hurt", start)
    pbs = pose_bones(arm_obj)
    apply_stance(pbs, 1)
    key(pbs["Chest"], 3, rot=(RAD(-18), 0, 0))
    key(pbs["Head"], 3, rot=(RAD(-22), 0, 0))
    apply_stance(pbs, 12)

def anim_death(arm_obj, start=1600):
    """30f 死亡倒地：髋前倾 90°，全身瘫软"""
    begin_action(arm_obj, "death", start)
    pbs = pose_bones(arm_obj)
    apply_stance(pbs, 1)
    key(pbs["Hips"], 8, loc=(0, 0.1, 0.55), rot=(RAD(55), 0, 0))
    key(pbs["Spine"], 8, rot=(RAD(30), 0, 0))
    key(pbs["UpperLeg.L"], 8, rot=(RAD(-40), 0, 0))
    key(pbs["UpperLeg.R"], 8, rot=(RAD(-30), 0, 0))
    key(pbs["Hips"], 24, loc=(0, 0.12, 0.18), rot=(RAD(88), 0, 0))
    key(pbs["Spine"], 24, rot=(RAD(15), 0, 0))
    key(pbs["Head"], 24, rot=(RAD(10), 0, 0))
    key(pbs["UpperArm.L"], 24, rot=(0, 0, RAD(10)))
    key(pbs["UpperArm.R"], 24, rot=(0, 0, RAD(-10)))

# ============================================================
# 3b. DS3 直剑完全表·新招动画（时序与 FRAME_DATA 同源；位移由代码 lunge 驱动）
#     剑尖在静止髋上量过（写在 .R，导出前才换到 .L）：前臂约 -80° 时
#     Z≈-90 指后，Z≈0 扫到身体另一侧，Z≈90（或 -270）平刺向前，Z≈±180 张开在持剑侧。
#     上挑不改这条 Z，只把前臂 X 从 +15° 收到 -120°，剑从下翻到上。
#     UpperLeg x+ 腿前抬。关键帧终点都 ≥ total×30+1 帧。
# ============================================================

def _stance_pose(pbs, frame):
    """架势基准姿（DS3 Stance）：剑放平前指、沉胯、前后站位"""
    key(pbs["Hips"], frame, loc=(0, 0.01, 0.92))
    key(pbs["Chest"], frame, rot=(RAD(10), 0, RAD(8)))
    key(pbs["Spine"], frame, rot=(RAD(2), 0, 0))
    key(pbs["Head"], frame, rot=(RAD(-8), 0, 0))
    key(pbs["UpperArm.R"], frame, rot=(RAD(-8), 0, RAD(-52)))    # 持剑前指
    key(pbs["LowerArm.R"], frame, rot=(RAD(-78), 0, 0))          # 剑放平
    key(pbs["UpperArm.L"], frame, rot=(RAD(-15), 0, RAD(-45)))   # 盾收体侧
    key(pbs["UpperLeg.L"], frame, rot=(RAD(18), 0, 0))
    key(pbs["LowerLeg.L"], frame, rot=(RAD(20), 0, 0))
    key(pbs["UpperLeg.R"], frame, rot=(RAD(-12), 0, 0))
    key(pbs["LowerLeg.R"], frame, rot=(RAD(18), 0, 0))

def _reset_legs(pbs, frame):
    for b in ("UpperLeg.L", "LowerLeg.L", "UpperLeg.R", "LowerLeg.R"):
        key(pbs[b], frame, rot=(0, 0, 0))

def anim_run_attack(arm_obj, start=1800):
    """24f 跑攻前刺。f2–f5 低身把剑停在腰后，f6–f8 刺出，f9 停在刺直，f12 身体扑过，f24 回待机。"""
    begin_action(arm_obj, "runAttack", start)
    pbs = pose_bones(arm_obj)
    wind, active_end = hit_window("runAttack")
    assert (wind, active_end) == (5, 9), (wind, active_end)
    # 蓄力：剑张开在持剑侧（Z≈-170）。刺击沿右侧收到正前（Z 收到 -270，即 +90），不绕到另一侧。
    charge = body_pose(
        (0, -0.02, 0.90), (14, 0, 4), (6, 0, -170), (-88, 0, 0),
        shield=(-20, 0, -32), shield_fore=(-50, 0, -8),
        head=(-4, 0, 2), spine=(8, 0, 2),
        thigh_l=(30, 0, 0), shin_l=(35, 0, 0), thigh_r=(-12, 0, 0), shin_r=(8, 0, 0),
    )
    leaving = body_pose(
        (0, 0.01, 0.86), (16, 0, 2), (2, 0, -210), (-86, 0, 0),
        shield=(-22, 0, -44), shield_fore=(-36, 0, -4),
        head=(-2, 0, 0), spine=(6, 0, 0),
        thigh_l=(36, 0, 0), shin_l=(24, 0, 0), thigh_r=(-22, 0, 0), shin_r=(8, 0, 0),
    )
    thrust = body_pose(
        (0, 0.03, 0.84), (18, 0, 0), (-2, 0, -240), (-84, 0, 0),
        shield=(-25, 0, -55), shield_fore=(-22, 0, 0),
        head=(-2, 0, 0), spine=(4, 0, 0),
        thigh_l=(42, 0, 0), shin_l=(15, 0, 0), thigh_r=(-32, 0, 0), shin_r=(8, 0, 0),
    )
    through = body_pose(
        (0, 0.05, 0.81), (20, 0, 0), (-6, 0, -270), (-80, 0, 0),
        shield=(-28, 0, -64), shield_fore=(-14, 0, 0),
        head=(0, 0, 0), spine=(2, 0, 0),
        thigh_l=(50, 0, 0), shin_l=(8, 0, 0), thigh_r=(-38, 0, 0), shin_r=(4, 0, 0),
    )
    over = body_pose(
        (0, 0.06, 0.79), (26, 0, 0), (-12, 0, -290), (-76, 0, 0),
        shield=(-32, 0, -70), shield_fore=(-8, 0, 0),
        head=(6, 0, 0), spine=(0, 0, 0),
        thigh_l=(56, 0, 0), shin_l=(4, 0, 0), thigh_r=(-44, 0, 0), shin_r=(2, 0, 0),
    )
    stamp(pbs, 1, hang_pose())
    stamp(pbs, (2, wind), charge)
    stamp(pbs, wind + 1, leaving)                         # f6
    stamp(pbs, wind + 2, thrust)                          # f7
    stamp(pbs, (wind + 3, active_end), through)           # f8–f9 剑已刺直
    stamp(pbs, active_end + 3, over)                      # f12 肩和重心扑过刺直线
    recover_stance(pbs, 24)
    unwrap_sword_end(pbs, 24, -382)

def anim_roll_attack(arm_obj, start=2000):
    """20f 起身横扫。f1–f4 停在翻滚收尾的低伏，f5–f7 抡起来扫过，f8 停在扫过身，f11 过冲，f20 回待机。"""
    begin_action(arm_obj, "rollAttack", start)
    pbs = pose_bones(arm_obj)
    wind, active_end = hit_window("rollAttack")
    assert (wind, active_end) == (4, 8), (wind, active_end)
    # 起手剑尖朝下贴地。起身时再扫到身前，和站立横斩的肩后蓄力不是同一个轮廓。
    charge = body_pose(
        (0, 0.03, 0.74), (20, 0, 18), (18, 0, -75), (-35, 0, 0),
        head=(8, 0, 8), spine=(18, 0, 6),
        thigh_l=(-35, 0, 0), shin_l=(50, 0, 0), thigh_r=(20, 0, 0), shin_r=(30, 0, 0),
    )
    leaving = body_pose(
        (0, 0.02, 0.82), (16, 0, 4), (-8, 0, -28), (-30, 0, 0),
        head=(2, 0, 2), spine=(12, 0, 2),
        thigh_l=(-20, 0, 0), shin_l=(36, 0, 0), thigh_r=(12, 0, 0), shin_r=(18, 0, 0),
    )
    across = body_pose(
        (0, 0.015, 0.88), (12, 0, -6), (-40, 0, 4), (-20, 0, 0),
        head=(-2, 0, -2), spine=(8, 0, -2),
        thigh_l=(-8, 0, 0), shin_l=(18, 0, 0), thigh_r=(6, 0, 0), shin_r=(8, 0, 0),
    )
    passed = body_pose(
        (0, 0.01, 0.93), (8, 0, -16), (-70, 0, 28), (-18, 0, 0),
        head=(-4, 0, -8), spine=(4, 0, -6),
        thigh_l=(0, 0, 0), shin_l=(6, 0, 0), thigh_r=(0, 0, 0), shin_r=(2, 0, 0),
    )
    over = body_pose(
        (0, 0, 0.99), (4, 0, -24), (-62, 0, 46), (-8, 0, 0),
        head=(-6, 0, -12), spine=(2, 0, -8),
    )
    stamp(pbs, (1, wind), charge)
    stamp(pbs, wind + 1, leaving)                         # f5 离地
    stamp(pbs, wind + 2, across)                          # f6 剑扫到身前
    stamp(pbs, (wind + 3, active_end), passed)            # f7–f8 起身扫过
    stamp(pbs, active_end + 3, over)                      # f11
    recover_stance(pbs, 20)

def anim_backstep(arm_obj, start=2200):
    """16f 后撤步：后跃（1.6m 代码驱动），f3 蹬地 f6 腾空 f9 落定；面朝不变"""
    begin_action(arm_obj, "backstep", start)
    pbs = pose_bones(arm_obj)
    apply_stance(pbs, 1)
    key(pbs["Hips"], 1, loc=(0, 0, 0.96))
    # f3 蹬地后跃：上身前倾、前后劈腿蓄势
    key(pbs["Hips"], 3, loc=(0, 0.02, 0.98))
    key(pbs["Chest"], 3, rot=(RAD(16), 0, RAD(-6)))
    key(pbs["UpperArm.L"], 3, rot=(RAD(-30), 0, RAD(-60)))
    key(pbs["UpperLeg.L"], 3, rot=(RAD(35), 0, 0))
    key(pbs["LowerLeg.L"], 3, rot=(RAD(20), 0, 0))
    key(pbs["UpperLeg.R"], 3, rot=(RAD(-25), 0, 0))
    key(pbs["LowerLeg.R"], 3, rot=(RAD(45), 0, 0))
    # f6 空中收腿（最高点）
    key(pbs["Hips"], 6, loc=(0, 0, 0.99))
    key(pbs["UpperLeg.L"], 6, rot=(RAD(20), 0, 0))
    key(pbs["UpperLeg.R"], 6, rot=(RAD(-12), 0, 0))
    key(pbs["LowerLeg.R"], 6, rot=(RAD(30), 0, 0))
    # f9 落定沉胯 → f16 回待机
    key(pbs["Hips"], 9, loc=(0, 0, 0.90))
    key(pbs["Chest"], 9, rot=(RAD(10), 0, 0))
    _reset_legs(pbs, 9)
    key(pbs["Hips"], 16, loc=(0, 0, 0.96))
    apply_stance(pbs, 16)

def anim_backstep_attack(arm_obj, start=2400):
    """22f 后撤直刺。f2–f5 剑停在肋侧，f6–f8 平刺，f11 肩送过，f22 回待机。站得比跑攻高，盾不甩开。"""
    begin_action(arm_obj, "backstepAttack", start)
    pbs = pose_bones(arm_obj)
    wind, active_end = hit_window("backstepAttack")
    assert (wind, active_end) == (5, 8), (wind, active_end)
    # 和跑攻同一条刺击，但人站得高、步子小、盾留在身前。Z 走 -170→-270，剑从持剑侧收到正前。
    charge = body_pose(
        (0, 0, 0.92), (8, 0, 2), (4, 0, -170), (-88, 0, 0),
        shield=(-18, 0, -46), shield_fore=(-48, 0, -8),
        head=(-4, 0, 2), spine=(4, 0, 0),
        thigh_l=(6, 0, 0), shin_l=(8, 0, 0), thigh_r=(-4, 0, 0), shin_r=(6, 0, 0),
    )
    leaving = body_pose(
        (0, 0.01, 0.905), (10, 0, 0), (2, 0, -215), (-86, 0, 0),
        shield=(-16, 0, -44), shield_fore=(-42, 0, -6),
        head=(-2, 0, 0), spine=(2, 0, 0),
        thigh_l=(12, 0, 0), shin_l=(6, 0, 0), thigh_r=(-8, 0, 0), shin_r=(4, 0, 0),
    )
    thrust = body_pose(
        (0, 0.02, 0.89), (12, 0, 0), (-2, 0, -245), (-84, 0, 0),
        shield=(-14, 0, -42), shield_fore=(-36, 0, -4),
        head=(-2, 0, 0), spine=(2, 0, 0),
        thigh_l=(16, 0, 0), shin_l=(4, 0, 0), thigh_r=(-10, 0, 0), shin_r=(2, 0, 0),
    )
    through = body_pose(
        (0, 0.025, 0.885), (14, 0, 0), (-4, 0, -270), (-80, 0, 0),
        shield=(-12, 0, -40), shield_fore=(-32, 0, -2),
        head=(0, 0, 0), spine=(2, 0, 0),
        thigh_l=(18, 0, 0), shin_l=(2, 0, 0), thigh_r=(-12, 0, 0), shin_r=(0, 0, 0),
    )
    over = body_pose(
        (0, 0.03, 0.87), (18, 0, 0), (-8, 0, -286), (-76, 0, 0),
        shield=(-10, 0, -38), shield_fore=(-28, 0, 0),
        head=(4, 0, 0), spine=(0, 0, 0),
        thigh_l=(20, 0, 0), shin_l=(0, 0, 0), thigh_r=(-14, 0, 0), shin_r=(0, 0, 0),
    )
    stamp(pbs, 1, hang_pose())
    stamp(pbs, (2, wind), charge)
    stamp(pbs, wind + 1, leaving)               # f6
    stamp(pbs, wind + 2, thrust)                # f7
    stamp(pbs, active_end, through)             # f8 刺直
    stamp(pbs, active_end + 3, over)            # f11
    recover_stance(pbs, 22)
    unwrap_sword_end(pbs, 22, -382)

def anim_kick(arm_obj, start=2600):
    """24f 踢。剑全程停在待机角度。f3–f7 提膝停住，f8–f10 小腿弹出，f13 过冲，f24 回待机。"""
    begin_action(arm_obj, "kick", start)
    pbs = pose_bones(arm_obj)
    wind, active_end = hit_window("kick")
    assert (wind, active_end) == (7, 10), (wind, active_end)
    sword, fore = (-42, 0, -22), (-8, 0, 0)
    shield, sfore = (-28, 0, -70), (-52, 0, -8)
    charge = body_pose(
        (0, -0.02, 0.94), (-6, 0, -4), sword, fore, shield=shield, shield_fore=sfore,
        head=(-8, 0, 0), spine=(2, 0, 0),
        thigh_l=(-8, 0, 0), shin_l=(10, 0, 0), thigh_r=(50, 0, 0), shin_r=(78, 0, 0),
    )
    leaving = body_pose(
        (0, 0, 0.95), (-12, 0, -2), sword, fore, shield=shield, shield_fore=sfore,
        head=(-10, 0, 0), spine=(0, 0, 0),
        thigh_l=(-8, 0, 0), shin_l=(12, 0, 0), thigh_r=(72, 0, 0), shin_r=(36, 0, 0),
    )
    snap = body_pose(
        (0, 0.02, 0.96), (-16, 0, 0), sword, fore, shield=shield, shield_fore=sfore,
        head=(-12, 0, 0), spine=(-2, 0, 0),
        thigh_l=(-8, 0, 0), shin_l=(12, 0, 0), thigh_r=(90, 0, 0), shin_r=(4, 0, 0),
    )
    through = body_pose(
        (0, 0.03, 0.97), (-18, 0, 0), sword, fore, shield=shield, shield_fore=sfore,
        head=(-14, 0, 0), spine=(-4, 0, 0),
        thigh_l=(-6, 0, 0), shin_l=(10, 0, 0), thigh_r=(100, 0, 0), shin_r=(-8, 0, 0),
    )
    over = body_pose(
        (0, 0.02, 0.99), (-26, 0, 0), sword, fore, shield=shield, shield_fore=sfore,
        head=(-18, 0, 0), spine=(-6, 0, 0),
        thigh_l=(-4, 0, 0), shin_l=(6, 0, 0), thigh_r=(112, 0, 0), shin_r=(-18, 0, 0),
    )
    stamp(pbs, 1, hang_pose())
    stamp(pbs, (3, wind), charge)
    stamp(pbs, wind + 1, leaving)       # f8 小腿弹出
    stamp(pbs, wind + 2, snap)          # f9 腿蹬直
    stamp(pbs, active_end, through)     # f10
    stamp(pbs, active_end + 3, over)    # f13 脚踢过水平线，上身再后仰
    recover_stance(pbs, 24)

def anim_stance(arm_obj, start=2800):
    """20f 战技·架势：f5 入架，f20 保持（0.6s 由代码按帧数据结算）"""
    begin_action(arm_obj, "stance", start)
    pbs = pose_bones(arm_obj)
    apply_stance(pbs, 1)
    key(pbs["Hips"], 1, loc=(0, 0, 0.96))
    _stance_pose(pbs, 5)
    _stance_pose(pbs, 20)

def anim_stance_poke(arm_obj, start=3000):
    """25f 架势突刺。f3–f6 从架势收回并停住，f7–f9 盾冲着刺出，f10 停在刺直，f13 过冲，f25 回待机。"""
    begin_action(arm_obj, "stancePoke", start)
    pbs = pose_bones(arm_obj)
    wind, active_end = hit_window("stancePoke")
    assert (wind, active_end) == (6, 10), (wind, active_end)
    guard = guard_pose()
    # 从架势收到持剑侧再刺出。盾跟着往前压，步子比后撤刺大。
    charge = body_pose(
        (0, 0, 0.91), (8, 0, 4), (4, 0, -165), (-86, 0, 0),
        shield=(-12, 0, -42), shield_fore=(0, 0, 0),
        head=(-6, 0, 2), spine=(4, 0, 2),
        thigh_l=(12, 0, 0), shin_l=(16, 0, 0), thigh_r=(-6, 0, 0), shin_r=(14, 0, 0),
    )
    leaving = body_pose(
        (0, 0.02, 0.88), (14, 0, 2), (0, 0, -205), (-84, 0, 0),
        shield=(-28, 0, -34), shield_fore=(0, 0, 0),
        head=(-4, 0, 0), spine=(2, 0, 0),
        thigh_l=(30, 0, 0), shin_l=(14, 0, 0), thigh_r=(-20, 0, 0), shin_r=(10, 0, 0),
    )
    thrust = body_pose(
        (0, 0.045, 0.85), (18, 0, 0), (-4, 0, -240), (-82, 0, 0),
        shield=(-42, 0, -28), shield_fore=(0, 0, 0),
        head=(-2, 0, 0), spine=(2, 0, 0),
        thigh_l=(48, 0, 0), shin_l=(10, 0, 0), thigh_r=(-36, 0, 0), shin_r=(6, 0, 0),
    )
    through = body_pose(
        (0, 0.055, 0.84), (22, 0, 0), (-6, 0, -270), (-80, 0, 0),
        shield=(-50, 0, -18), shield_fore=(0, 0, 0),
        head=(0, 0, 0), spine=(0, 0, 0),
        thigh_l=(54, 0, 0), shin_l=(8, 0, 0), thigh_r=(-40, 0, 0), shin_r=(4, 0, 0),
    )
    over = body_pose(
        (0, 0.04, 0.86), (28, 0, 0), (-10, 0, -292), (-76, 0, 0),
        shield=(-56, 0, -10), shield_fore=(0, 0, 0),
        head=(6, 0, 0), spine=(0, 0, 0),
        thigh_l=(60, 0, 0), shin_l=(12, 0, 0), thigh_r=(-44, 0, 0), shin_r=(2, 0, 0),
    )
    stamp(pbs, 1, guard)
    stamp(pbs, (3, wind), charge)
    stamp(pbs, wind + 1, leaving)                         # f7
    stamp(pbs, wind + 2, thrust)                          # f8 盾压前、剑刺出
    stamp(pbs, (wind + 3, active_end), through)           # f9–f10
    stamp(pbs, active_end + 3, over)                      # f13
    recover_stance(pbs, 25)
    unwrap_sword_end(pbs, 25, -382)

def anim_stance_up(arm_obj, start=3200):
    """28f 上挑。f3–f7 剑停在身前垂地，f8–f10 从下往上挑过胸，f11 停在挑起，f14 过冲，f28 回待机。"""
    begin_action(arm_obj, "stanceUp", start)
    pbs = pose_bones(arm_obj)
    wind, active_end = hit_window("stanceUp")
    assert (wind, active_end) == (7, 11), (wind, active_end)
    legs = dict(thigh_l=(18, 0, 0), shin_l=(20, 0, 0), thigh_r=(-12, 0, 0), shin_r=(18, 0, 0))
    # 臂 Z 钉在 90° 附近，只收前臂：剑尖从脚下翻到头顶，不走到横斩那一侧。
    charge = body_pose(
        (0, 0.01, 0.87), (18, 0, 4), (-5, 0, 90), (15, 0, 0),
        shield=(-16, 0, -44), shield_fore=(0, 0, 0),
        head=(10, 0, 0), spine=(10, 0, 0), **legs,
    )
    leaving = body_pose(
        (0, 0.01, 0.90), (10, 0, 2), (-15, 0, 88), (-15, 0, 0),
        shield=(-28, 0, -48), shield_fore=(0, 0, 0),
        head=(0, 0, 0), spine=(4, 0, 0), **legs,
    )
    rising = body_pose(
        (0, 0.01, 0.95), (2, 0, 0), (-35, 0, 90), (-55, 0, 0),
        shield=(-36, 0, -52), shield_fore=(0, 0, 0),
        head=(-8, 0, 0), spine=(0, 0, 0), **legs,
    )
    up = body_pose(
        (0, 0.005, 1.00), (-12, 0, -4), (-55, 0, 90), (-120, 0, 0),
        shield=(-46, 0, -56), shield_fore=(0, 0, 0),
        head=(-18, 0, 0), spine=(-4, 0, 0), **legs,
    )
    over = body_pose(
        (0, -0.01, 1.02), (-20, 0, -6), (-68, 0, 85), (-135, 0, 0),
        shield=(-52, 0, -62), shield_fore=(0, 0, 0),
        head=(-24, 0, 0), spine=(-8, 0, 0), **legs,
    )
    stamp(pbs, 1, guard_pose())
    stamp(pbs, (3, wind), charge)
    stamp(pbs, wind + 1, leaving)                         # f8 剑离地
    stamp(pbs, wind + 2, rising)                          # f9 挑过胸线
    stamp(pbs, (wind + 3, active_end), up)                # f10–f11 剑指天
    stamp(pbs, active_end + 3, over)                      # f14 再扬过头顶
    recover_stance(pbs, 28)

# ============================================================
# 4. 导出
# ============================================================
def _fix_nla_slots(arm_obj):
    """Blender 4.4+ slotted actions：keyframe_insert 会在活动 action 里自动建 slot，
    但 NLA strip 的 action_slot 不会自动指上——空 slot 的轨道导出时退化为 2 键。"""
    for track in arm_obj.animation_data.nla_tracks:
        for strip in track.strips:
            act = strip.action
            if act is None:
                continue
            slots = getattr(act, "slots", None)
            if slots:
                strip.action_slot = slots[0]
            # strip 建于 action 尚无关键帧时，长度冻结在 1-2 帧；
            # 导出器按 strip 范围采样 → 全部动画退化为 2 键。这里拉回 action 实际帧范围。
            fmin, fmax = act.frame_range
            strip.frame_start = 1
            strip.frame_end = max(2.0, fmax - fmin + 1.0)

def _iter_fcurves(act):
    """Blender 4.4+ 的槽位 action 把曲线放在 channelbag 里，旧的 act.fcurves 可能是空的。"""
    legacy = getattr(act, "fcurves", None)
    if legacy and len(legacy):
        yield from legacy
        return
    for layer in getattr(act, "layers", []) or []:
        for strip in layer.strips:
            for slot in act.slots:
                bag = strip.channelbag(slot)
                if bag:
                    yield from bag.fcurves

def swap_arm_sides(arm_obj):
    """骨名 .R 在 -X，面朝 +Y 时是左手；剑的网格挂在 .L。
    动画仍按 .R=持剑 来写。这里对调左右臂通道并把 Z 欧拉取反，
    挥砍跟着重挂到右手，盾的姿势跟到左手。贝塞尔手柄夹紧，避免欧拉绕远路把胳膊甩抽。"""
    arm_tokens = ("UpperArm.", "LowerArm.", "Hand.")
    swapped = 0
    for track in arm_obj.animation_data.nla_tracks:
        for strip in track.strips:
            act = strip.action
            if act is None:
                continue
            curves = list(_iter_fcurves(act))
            arm_curves = [fc for fc in curves if any(tok in fc.data_path for tok in arm_tokens)]
            for fc in arm_curves:
                if "rotation_euler" in fc.data_path and fc.array_index == 2:
                    for kp in fc.keyframe_points:
                        kp.co[1] *= -1
                        kp.handle_left[1] *= -1
                        kp.handle_right[1] *= -1
                # 先改成临时名，避免 .R→.L 时和还没搬走的 .L 撞路径
                if ".R" in fc.data_path:
                    fc.data_path = fc.data_path.replace(".R", ".TMP")
            for fc in arm_curves:
                if ".L" in fc.data_path:
                    fc.data_path = fc.data_path.replace(".L", ".R")
            for fc in arm_curves:
                if ".TMP" in fc.data_path:
                    fc.data_path = fc.data_path.replace(".TMP", ".L")
                swapped += 1
            for fc in curves:
                if "rotation_euler" not in fc.data_path:
                    continue
                for kp in fc.keyframe_points:
                    kp.interpolation = "BEZIER"
                    kp.handle_left_type = "AUTO_CLAMPED"
                    kp.handle_right_type = "AUTO_CLAMPED"
    print(f"INFERNO_SWAP arm_fcurves={swapped}")

def export(arm_obj):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    swap_arm_sides(arm_obj)
    _fix_nla_slots(arm_obj)
    arm_obj.animation_data.action = None   # NLA 为权威
    # 回到静止姿态再导出：节点变换必须是 rest，动画才是相对 rest 的增量
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.select_all(action="SELECT")
    bpy.ops.pose.transforms_clear()
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.update()
    glb = OUT_DIR / "character.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(glb),
        export_format="GLB",
        export_animation_mode="ACTIONS",
        export_optimize_animation_size=False,   # 不做尺寸优化抽键（否则每通道被抽到 2 键）
    )
    (OUT_DIR / "character_frames.json").write_text(
        json.dumps(FRAME_DATA, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"INFERNO_EXPORT glb={glb} size={glb.stat().st_size} json={FRAME_DATA['clips'].keys()}")

def main():
    # 场景帧率对齐 FRAME_DATA 的 FPS=30：glTF 导出的关键帧时间 = 帧/30，
    # 与 character_frames.json 的秒数严格同步（默认 24 会慢 25%）
    bpy.context.scene.render.fps = FPS
    clear_scene()
    arm_obj = build_armature()
    build_parts(arm_obj)
    anim_idle(arm_obj)
    anim_attack(arm_obj)
    anim_roll(arm_obj)
    anim_walk(arm_obj)
    anim_block(arm_obj)
    anim_parry(arm_obj)
    anim_estus(arm_obj)
    anim_hurt(arm_obj)
    anim_death(arm_obj)
    anim_run_attack(arm_obj)
    anim_roll_attack(arm_obj)
    anim_backstep(arm_obj)
    anim_backstep_attack(arm_obj)
    anim_kick(arm_obj)
    anim_stance(arm_obj)
    anim_stance_poke(arm_obj)
    anim_stance_up(arm_obj)
    export(arm_obj)

main()
