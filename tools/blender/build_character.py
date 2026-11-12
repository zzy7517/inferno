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
from mathutils import Matrix, Quaternion, Vector

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

    # —— 剑在右手（+X / Hand.L），顺着小臂伸出去。
    #    以前刃垂直焊在手腕上，手臂一转剑就绕骨拧。锥尖是局部 -Z，Ry(-90) 把它送向 +X。
    SWORD_R = (0, math.radians(-90), 0)
    # 刃长 1.28m，宽端留在护手处。角色约 1.8m，这是一把看得清的长剑，不是一根针。
    BLADE_DEPTH = 1.28
    make_sphere("Pommel", (0.56, 0.02, 1.43), M_METAL, 0.032, seg=8, ring=6)
    make_cyl("Grip", (0.66, 0.02, 1.43), M_DARK, 0.018, 0.16, seg=8, rot=SWORD_R)
    guard = make_box("Guard", (0.32, 0.034, 0.046), (0.75, 0.02, 1.43), M_METAL)
    guard.rotation_euler = SWORD_R
    blade_center = 0.74 + BLADE_DEPTH / 2
    blade = make_cone("Blade", (blade_center, 0.02, 1.43), M_STEEL, 0.004, 0.052, BLADE_DEPTH, seg=6,
                      rot=SWORD_R, scale=(1.0, 0.32, 1.0))
    blade["half"] = BLADE_DEPTH / 2
    # 刃口一条窄余烬，贴在朝前的一侧，远看能把剑从披风里认出来
    edge_depth = BLADE_DEPTH * 0.88
    make_cone("BladeEdge", (0.78 + edge_depth / 2, 0.07, 1.43), M_EMBER, 0.001, 0.016, edge_depth, seg=4,
              rot=SWORD_R, scale=(1.0, 0.28, 1.0))

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
# 3. 动画
#    时长与 FRAME_DATA 一致。挥砍直接写在真正拿剑的骨头上。
#
# 局部轴（静止姿态量过的，location 不是世界坐标）：
#   躯干：X 世界右，Y 世界向上，Z 世界向后。
#     欧拉 X 负 = 前倾；欧拉 Y 正 = 右肩向前。
#     location.y = 上下，location.z = 向后。静止高度已经在骨上，不要再写 0.96。
#   腿：大腿 X 正 = 向前抬。膝盖用负值才是向前弯，正值会反关节。
#   持剑臂 .L（+X，面朝 +Y 时的右手），持盾臂 .R。骨长是局部 Y。
#   剑 mesh 顺着这条骨长伸出，所以手臂指向哪，剑尖就指向哪。
# ============================================================
RAD = math.radians
_prev_q = {}

# 剑的方向是世界空间骨长（+Y 朝前，+Z 朝上）。
# 盾的方向是胸口空间 (右, 前, 上)，身体转向时盾留在左胸前，不滑到胯边。
C_GUARD = (-8.0, -4.0, 0.0)
SU_G = (0.58, 0.28, -0.72)
SF_G = (0.22, 0.78, -0.48)
HU_G = (-0.75, 0.40, -0.05)   # 肘向外，略向前
HF_G = (0.35, 0.85, 0.05)     # 小臂横在胸前
LEG_G = (10.0, -18.0, -8.0, -14.0)  # 右大腿、右膝、左大腿、左膝
# 小臂瞄准后再绕骨长转这么多，圆盾的盘面才朝向敌人。对当前绑定量过。
SHIELD_ROLL = -24.0


def pose_bones(arm_obj):
    return arm_obj.pose.bones

def begin_action(arm_obj, name, start):
    global _prev_q
    _prev_q = {}
    if arm_obj.animation_data is None:
        arm_obj.animation_data_create()
    arm_obj.animation_data.use_nla = False
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    track = arm_obj.animation_data.nla_tracks.new()
    track.name = name
    track.mute = True
    # strip 落在 frame 1：导出的关键帧时间即 0 基，three.js 从 t=0 才对得上帧数据
    track.strips.new(name, 1, action)
    arm_obj.animation_data.action = action
    for t in arm_obj.animation_data.nla_tracks:
        t.mute = True
    return action

def reset_pose(arm_obj):
    for pb in arm_obj.pose.bones:
        pb.location = (0.0, 0.0, 0.0)
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
    bpy.context.view_layer.update()

def _euler(pb, deg):
    pb.rotation_mode = "XYZ"
    pb.rotation_euler = (RAD(deg[0]), RAD(deg[1]), RAD(deg[2]))

def _aim_quat(pb, y_dir, z_hint=(0.0, 0.0, 1.0)):
    """让骨长（局部 Y）指向 y_dir。z_hint 只负责扭转，避免剑绕握把自旋。"""
    y = Vector(y_dir).normalized()
    hint = Vector(z_hint)
    z = hint - y * y.dot(hint)
    if z.length < 1e-6:
        alt = Vector((0.0, 1.0, 0.0))
        z = alt - y * y.dot(alt)
    z.normalize()
    x = y.cross(z).normalized()
    z = x.cross(y).normalized()
    arm_rot = Matrix((x, y, z)).transposed()
    rest = pb.bone.matrix_local.to_3x3()
    if pb.parent:
        parent_pose = pb.parent.matrix.to_3x3()
        parent_rest = pb.parent.bone.matrix_local.to_3x3()
        basis = rest.inverted() @ parent_rest @ parent_pose.inverted() @ arm_rot
    else:
        basis = rest.inverted() @ arm_rot
    q = basis.to_quaternion()
    prev = _prev_q.get(pb.name)
    if prev is not None and prev.dot(q) < 0.0:
        q.negate()
    _prev_q[pb.name] = q.copy()
    pb.rotation_mode = "QUATERNION"
    pb.rotation_quaternion = q

def _body_dir(chest_pb, spec):
    """胸口空间 (右, 前, 上) → 世界方向。胸口 Z 轴朝后，所以前方是 -Z。"""
    right, forward, up = spec
    m = chest_pb.matrix.to_3x3()
    return m.col[0] * right - m.col[2] * forward + m.col[1] * up

def _roll_local_y(pb, degrees):
    q = pb.rotation_quaternion @ Quaternion((0.0, 1.0, 0.0), RAD(degrees))
    prev = _prev_q.get(pb.name)
    if prev is not None and prev.dot(q) < 0.0:
        q.negate()
    _prev_q[pb.name] = q.copy()
    pb.rotation_quaternion = q

def pose_now(arm_obj, chest, su, sf, hu, hf, legs, head=None):
    """先把髋归零再瞄准，手臂局部旋转才不会被翻滚的髋带着算歪。
    剑用世界方向，盾用胸口方向，挥砍时盾跟着上身转。"""
    pbs = arm_obj.pose.bones
    hip = pbs["Hips"]
    hip.rotation_mode = "XYZ"
    hip.rotation_euler = (0.0, 0.0, 0.0)
    hip.location = (0.0, 0.0, 0.0)
    _euler(pbs["Chest"], chest)
    _euler(pbs["Spine"], (chest[0] * 0.45, chest[1] * 0.45, 0.0))
    if head is None:
        head = (chest[0] * 0.25, -chest[1] * 0.2, 0.0)
    _euler(pbs["Head"], head)
    bpy.context.view_layer.update()
    face = _body_dir(pbs["Chest"], (0.0, 1.0, 0.0))
    _aim_quat(pbs["UpperArm.L"], su)
    _aim_quat(pbs["UpperArm.R"], _body_dir(pbs["Chest"], hu), face)
    bpy.context.view_layer.update()
    _aim_quat(pbs["LowerArm.L"], sf)
    fore = pbs["LowerArm.R"]
    _aim_quat(fore, _body_dir(pbs["Chest"], hf), face)
    _roll_local_y(fore, SHIELD_ROLL)
    _euler(pbs["UpperLeg.L"], (legs[0], 0.0, 0.0))
    _euler(pbs["LowerLeg.L"], (legs[1], 0.0, 0.0))
    _euler(pbs["UpperLeg.R"], (legs[2], 0.0, 0.0))
    _euler(pbs["LowerLeg.R"], (legs[3], 0.0, 0.0))
    bpy.context.view_layer.update()

def pose_frame(arm_obj, frame, chest, su, sf, hu, hf, legs, hips_loc=None, hips_rot=None, head=None):
    pose_now(arm_obj, chest, su, sf, hu, hf, legs, head=head)
    pbs = arm_obj.pose.bones
    for name in ("Chest", "Spine", "Head", "UpperLeg.L", "LowerLeg.L", "UpperLeg.R", "LowerLeg.R"):
        pbs[name].keyframe_insert("rotation_euler", frame=frame)
    for name in ("UpperArm.L", "LowerArm.L", "UpperArm.R", "LowerArm.R"):
        pbs[name].keyframe_insert("rotation_quaternion", frame=frame)
    if hips_loc is None and hips_rot is None:
        return
    hip = pbs["Hips"]
    if hips_rot is not None:
        _euler(hip, hips_rot)
        hip.keyframe_insert("rotation_euler", frame=frame)
    if hips_loc is not None:
        hip.location = hips_loc
        hip.keyframe_insert("location", frame=frame)

def key_hips(arm_obj, frame, rot, loc):
    hip = arm_obj.pose.bones["Hips"]
    _euler(hip, rot)
    hip.location = loc
    hip.keyframe_insert("rotation_euler", frame=frame)
    hip.keyframe_insert("location", frame=frame)

def guard(arm_obj, frame, chest=None, legs=None, head=None, hips_loc=None):
    pose_frame(
        arm_obj, frame,
        C_GUARD if chest is None else chest,
        SU_G, SF_G, HU_G, HF_G,
        LEG_G if legs is None else legs,
        hips_loc=hips_loc, head=head,
    )

def hit_window(clip):
    """startup/active 秒数 → 1 基帧。attack 的 6/30、3/30 得到前摇到 f6、命中 f7–f9。"""
    c = FRAME_DATA["clips"][clip]
    wind = round(c["startup"] * FPS)
    active_end = round((c["startup"] + c["active"]) * FPS)
    print(f"INFERNO_HIT {clip} hold_until=f{wind} active=f{wind + 1}-f{active_end}")
    return wind, active_end

def seat_shield(arm_obj):
    """盾面朝向敌人（+Y）。圆盾跟着左小臂走，架势里才正对前方。"""
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="POSE")
    reset_pose(arm_obj)
    pose_now(arm_obj, C_GUARD, SU_G, SF_G, HU_G, HF_G, LEG_G)
    rot = Matrix.Identity(4)
    rot.col[0] = Vector((1.0, 0.0, 0.0, 0.0))
    rot.col[1] = Vector((0.0, 0.0, 1.0, 0.0))
    rot.col[2] = Vector((0.0, 1.0, 0.0, 0.0))
    for name, loc, sc in (
        ("Shield", (-0.28, 0.40, 1.28), (1.0, 1.0, 1.0)),
        ("ShieldRim", (-0.28, 0.42, 1.28), (1.0, 1.0, 1.0)),
        ("ShieldBoss", (-0.28, 0.445, 1.28), (1.0, 1.0, 0.5)),
    ):
        obj = bpy.data.objects[name]
        obj.matrix_world = Matrix.Translation(Vector(loc)) @ rot @ Matrix.Diagonal(Vector((*sc, 1.0)))
    bpy.context.view_layer.update()
    normal = bpy.data.objects["Shield"].matrix_world.to_3x3().col[2].normalized()
    if normal.y < 0.8:
        raise RuntimeError(f"盾没有朝前: {tuple(round(c, 2) for c in normal)}")
    reset_pose(arm_obj)
    print(f"INFERNO_SHIELD normal={tuple(round(c, 2) for c in normal)}")

def anim_idle(arm_obj, start=1):
    """120f 呼吸。剑垂在身前，盾横在胸前。"""
    begin_action(arm_obj, "idle", start)
    reset_pose(arm_obj)
    for f, breathe in ((1, 0), (30, 1), (60, 0), (90, -1), (120, 0)):
        guard(
            arm_obj, f,
            chest=(-8.0 - 1.2 * breathe, -4.0, 0.0),
            head=(-6.0 - 0.8 * breathe, 3.0 * breathe, 0.0),
            hips_loc=(0.0, -0.008 * breathe, 0.0),
        )

def anim_attack(arm_obj, start=200):
    """27f 横斩。f3–f6 剑停在右肩上方，f7–f9 贴着身前扫过，f12 收到左侧，f27 回架势。"""
    begin_action(arm_obj, "attack", start)
    reset_pose(arm_obj)
    wind, active_end = hit_window("attack")
    assert (wind, active_end) == (6, 9), (wind, active_end)
    guard(arm_obj, 1)
    chamber = ((-6, -24, 0), (0.85, 0.10, 0.35), (0.55, 0.35, 0.70), HU_G, HF_G, (8, -14, -6, -10))
    pose_frame(arm_obj, 3, *chamber)
    pose_frame(arm_obj, wind, *chamber)
    pose_frame(arm_obj, wind + 1, (-8, 2, 0), (0.45, 0.55, 0.15), (0.55, 0.78, 0.10), HU_G, HF_G, (12, -20, -6, -10))
    pose_frame(arm_obj, wind + 2, (-10, 12, 0), (0.15, 0.82, 0.05), (0.0, 0.98, 0.06), HU_G, HF_G, (14, -24, -4, -8))
    pose_frame(arm_obj, active_end, (-8, 20, 0), (-0.10, 0.55, 0.02), (-0.55, 0.78, 0.02), HU_G, HF_G, (12, -20, -6, -10))
    pose_frame(arm_obj, active_end + 3, (-4, 30, 0), (-0.15, 0.32, -0.05), (-0.88, 0.40, -0.10), HU_G, HF_G, (8, -14, -8, -12))
    guard(arm_obj, 27)

def anim_roll(arm_obj, start=400):
    """21f 前滚。手臂贴着身体，髋绕 X 翻一圈；位移不再把人推到身后。"""
    begin_action(arm_obj, "roll", start)
    reset_pose(arm_obj)
    su, sf = (0.35, 0.40, -0.35), (0.20, 0.45, -0.50)
    hu, hf = (-0.45, 0.30, -0.10), (0.05, 0.45, -0.20)
    legs = (50, -60, 50, -60)
    pose_frame(arm_obj, 1, (8, 0, 0), su, sf, hu, hf, legs, hips_loc=(0, -0.26, 0), hips_rot=(30, 0, 0))
    for f, ang, loc in (
        (4, 30, (0, -0.24, 0)),
        (7, -60, (0, -0.20, 0)),
        (11, -180, (0, -0.18, 0)),
        (15, -300, (0, -0.20, 0)),
    ):
        key_hips(arm_obj, f, (ang, 0, 0), loc)
    pose_frame(arm_obj, 18, (8, 0, 0), su, sf, hu, hf, legs, hips_loc=(0, -0.12, 0), hips_rot=(-355, 0, 0))
    guard(arm_obj, 21, hips_loc=(0, 0, 0))
    # -360 和 0 是同一个姿态，但插值才不会从 -355 绕远路甩回去
    key_hips(arm_obj, 21, (-360, 0, 0), (0, 0, 0))

def anim_walk(arm_obj, start=600):
    """24f 循环步行。向前的那条腿屈膝，脚不要反着撇出去。"""
    begin_action(arm_obj, "walk", start)
    reset_pose(arm_obj)
    for f, phase in ((1, 0.0), (7, 1.0), (13, 0.0), (19, -1.0), (24, 0.0)):
        # phase>0：左腿在前。膝盖负值才是向前弯。
        legs = (
            -28.0 * phase, -10.0 - 24.0 * max(0.0, -phase),
            28.0 * phase, -10.0 - 24.0 * max(0.0, phase),
        )
        guard(arm_obj, f, legs=legs, hips_loc=(0.0, -0.012 * abs(phase), 0.0))

def anim_block(arm_obj, start=800):
    """40f 举盾。盾挡在胸前，剑收到右侧。"""
    begin_action(arm_obj, "block_idle", start)
    reset_pose(arm_obj)
    for f, breathe in ((1, 0.0), (20, 1.0), (40, 0.0)):
        pose_frame(
            arm_obj, f, (-4.0, 0.0, 0.0),
            SU_G, SF_G,
            (-0.45, 0.40, 0.35), (0.10, 0.70, 0.45 + 0.04 * breathe),
            LEG_G, hips_loc=(0.0, -0.02 - 0.01 * breathe, 0.0),
        )

def anim_parry(arm_obj, start=1000):
    """14f 盾击。f4 盾推向敌人，再收回架势。"""
    begin_action(arm_obj, "parry", start)
    reset_pose(arm_obj)
    pose_frame(
        arm_obj, 1, (-4, 0, 0),
        SU_G, SF_G,
        (-0.55, 0.50, 0.15), (0.20, 0.85, 0.20), LEG_G,
    )
    pose_frame(
        arm_obj, 4, (-14, 2, 0),
        SU_G, SF_G,
        (-0.25, 0.75, 0.10), (0.05, 1.05, 0.08), (8, -16, -4, -10),
    )
    pose_frame(
        arm_obj, 8, (-6, 0, 0),
        SU_G, SF_G,
        (-0.60, 0.55, 0.05), (0.25, 0.90, 0.12), LEG_G,
    )
    guard(arm_obj, 14)

def anim_estus(arm_obj, start=1200):
    """33f 喝药。手举到嘴边，盾留在头的左侧，不扣到面甲上。"""
    begin_action(arm_obj, "estus", start)
    reset_pose(arm_obj)
    guard(arm_obj, 1)
    pose_frame(
        arm_obj, 8, (-4, 0, 0), SU_G, SF_G,
        (-0.55, 0.15, 0.65), (-0.45, 0.20, 0.80), LEG_G, head=(18, 0, 0),
    )
    pose_frame(
        arm_obj, 16, (-4, 0, 0), SU_G, SF_G,
        (-0.55, 0.15, 0.65), (-0.45, 0.20, 0.80), LEG_G, head=(22, 0, 0),
    )
    pose_frame(
        arm_obj, 22, (-6, 0, 0), SU_G, SF_G,
        (-0.65, 0.30, 0.25), (-0.05, 0.55, 0.35), LEG_G, head=(4, 0, 0),
    )
    guard(arm_obj, 33)

def anim_hurt(arm_obj, start=1400):
    """12f 受击。上身向后仰，手臂收到身前。"""
    begin_action(arm_obj, "hurt", start)
    reset_pose(arm_obj)
    guard(arm_obj, 1)
    pose_frame(
        arm_obj, 3, (14, 0, 0),
        (0.40, 0.15, -0.50), (0.20, 0.30, -0.60),
        (-0.60, 0.30, -0.05), (0.15, 0.65, 0.0),
        LEG_G, head=(18, 0, 0),
    )
    guard(arm_obj, 12)

def anim_death(arm_obj, start=1600):
    """24f 向前倒。髋的 X 负值才是前倾。"""
    begin_action(arm_obj, "death", start)
    reset_pose(arm_obj)
    guard(arm_obj, 1)
    key_hips(arm_obj, 1, (0, 0, 0), (0, 0, 0))
    pose_frame(
        arm_obj, 8, (-18, 0, 0),
        (0.30, 0.20, -0.70), (0.10, 0.15, -0.80),
        (-0.35, 0.15, -0.55), (-0.10, 0.15, -0.70),
        (30, -50, 25, -40), hips_loc=(0, -0.40, -0.06), hips_rot=(-55, 0, 0),
    )
    pose_frame(
        arm_obj, 24, (-8, 0, 0),
        (0.45, 0.10, -0.80), (0.15, 0.05, -0.90),
        (-0.40, 0.05, -0.70), (-0.15, 0.05, -0.85),
        (12, -18, 10, -16), hips_loc=(0, -0.78, -0.10), hips_rot=(-82, 0, 0), head=(12, 0, 0),
    )

def anim_run_attack(arm_obj, start=1800):
    """24f 跑攻前刺。剑先收到右后方，再沿身前平刺出去。前冲距离由代码负责。"""
    begin_action(arm_obj, "runAttack", start)
    reset_pose(arm_obj)
    wind, active_end = hit_window("runAttack")
    assert (wind, active_end) == (5, 9), (wind, active_end)
    guard(arm_obj, 1)
    chamber = ((-16, -12, 0), (0.55, -0.30, 0.10), (0.30, -0.70, 0.35), HU_G, HF_G, (-12, -16, 18, -30))
    pose_frame(arm_obj, 2, *chamber)
    pose_frame(arm_obj, wind, *chamber)
    pose_frame(arm_obj, wind + 1, (-16, -2, 0), (0.35, 0.45, 0.08), (0.12, 0.75, 0.10), HU_G, HF_G, (-14, -14, 22, -28))
    pose_frame(arm_obj, wind + 2, (-18, 4, 0), (0.12, 0.85, 0.04), (0.0, 0.98, 0.05), HU_G, HF_G, (-16, -12, 24, -26))
    pose_frame(arm_obj, active_end, (-18, 6, 0), (0.05, 0.90, 0.0), (0.0, 1.0, 0.02), HU_G, HF_G, (-16, -12, 26, -24))
    pose_frame(arm_obj, active_end + 3, (-14, 8, 0), (0.02, 0.92, -0.04), (-0.06, 0.98, 0.0), HU_G, HF_G, (-12, -14, 20, -26))
    guard(arm_obj, 24)

def anim_roll_attack(arm_obj, start=2000):
    """20f 起身横扫。从低伏把剑抡到身前，再扫向左侧。"""
    begin_action(arm_obj, "rollAttack", start)
    reset_pose(arm_obj)
    wind, active_end = hit_window("rollAttack")
    assert (wind, active_end) == (4, 8), (wind, active_end)
    low = ((-20, -8, 0), (0.45, 0.20, -0.80), (0.20, 0.40, -0.85), HU_G, HF_G, (24, -42, 18, -36))
    pose_frame(arm_obj, 1, *low, hips_loc=(0, -0.20, -0.02))
    pose_frame(arm_obj, wind, *low, hips_loc=(0, -0.18, -0.02))
    pose_frame(arm_obj, wind + 1, (-14, -2, 0), (0.50, 0.45, 0.20), (0.30, 0.70, 0.40), HU_G, HF_G, (16, -30, 12, -24), hips_loc=(0, -0.10, 0))
    pose_frame(arm_obj, wind + 2, (-12, 8, 0), (0.30, 0.65, 0.10), (0.20, 0.85, 0.15), HU_G, HF_G, (14, -26, 8, -18), hips_loc=(0, -0.06, 0))
    pose_frame(arm_obj, active_end, (-10, 16, 0), (0.05, 0.70, 0.05), (-0.25, 0.90, 0.08), HU_G, HF_G, (12, -22, 6, -16))
    pose_frame(arm_obj, active_end + 3, (-6, 26, 0), (-0.10, 0.40, 0.0), (-0.80, 0.45, -0.05), HU_G, HF_G, LEG_G)
    guard(arm_obj, 20)

def anim_backstep(arm_obj, start=2200):
    """16f 后撤步。后跃距离由代码驱动，这里只做蹬地和落地。"""
    begin_action(arm_obj, "backstep", start)
    reset_pose(arm_obj)
    guard(arm_obj, 1)
    key_hips(arm_obj, 1, (0, 0, 0), (0, 0, 0))
    pose_frame(arm_obj, 3, (-12, 0, 0), SU_G, SF_G, HU_G, HF_G, (28, -16, -22, -30), hips_loc=(0, 0.04, 0.02))
    pose_frame(arm_obj, 6, (-6, 0, 0), SU_G, SF_G, HU_G, HF_G, (12, -12, -8, -16), hips_loc=(0, 0.06, 0))
    pose_frame(arm_obj, 9, (-8, 0, 0), SU_G, SF_G, HU_G, HF_G, LEG_G, hips_loc=(0, -0.04, 0))
    guard(arm_obj, 16)

def anim_backstep_attack(arm_obj, start=2400):
    """22f 后撤直刺。人站得比跑攻高，盾留在身前，剑从肋侧平刺。"""
    begin_action(arm_obj, "backstepAttack", start)
    reset_pose(arm_obj)
    wind, active_end = hit_window("backstepAttack")
    assert (wind, active_end) == (5, 8), (wind, active_end)
    guard(arm_obj, 1)
    chamber = ((-8, -8, 0), (0.50, -0.15, -0.05), (0.25, -0.55, 0.30), HU_G, HF_G, (6, -14, -4, -12))
    pose_frame(arm_obj, 2, *chamber)
    pose_frame(arm_obj, wind, *chamber)
    pose_frame(arm_obj, wind + 1, (-8, 2, 0), (0.30, 0.55, 0.05), (0.10, 0.85, 0.08), HU_G, HF_G, (8, -16, -2, -10))
    pose_frame(arm_obj, active_end, (-8, 8, 0), (0.12, 0.80, 0.02), (0.0, 0.98, 0.04), HU_G, HF_G, (10, -16, 0, -10))
    pose_frame(arm_obj, active_end + 3, (-6, 10, 0), (0.08, 0.82, 0.0), (-0.04, 0.96, 0.02), HU_G, HF_G, LEG_G)
    guard(arm_obj, 22)

def anim_kick(arm_obj, start=2600):
    """24f 左腿前踢。剑和盾停在架势里，不跟着甩。"""
    begin_action(arm_obj, "kick", start)
    reset_pose(arm_obj)
    wind, active_end = hit_window("kick")
    assert (wind, active_end) == (7, 10), (wind, active_end)
    guard(arm_obj, 1)
    pose_frame(arm_obj, 3, (-4, 0, 0), SU_G, SF_G, HU_G, HF_G, (8, -14, 58, -72))
    pose_frame(arm_obj, wind, (-2, 0, 0), SU_G, SF_G, HU_G, HF_G, (6, -12, 64, -68))
    pose_frame(arm_obj, wind + 1, (4, 0, 0), SU_G, SF_G, HU_G, HF_G, (6, -12, 78, -28))
    pose_frame(arm_obj, wind + 2, (8, 0, 0), SU_G, SF_G, HU_G, HF_G, (4, -10, 88, -6))
    pose_frame(arm_obj, active_end, (8, 0, 0), SU_G, SF_G, HU_G, HF_G, (4, -10, 92, 0))
    pose_frame(arm_obj, active_end + 3, (6, 0, 0), SU_G, SF_G, HU_G, HF_G, (6, -12, 100, -8))
    guard(arm_obj, 24)

def _stance_pose(arm_obj, frame):
    pose_frame(
        arm_obj, frame, (-6, -10, 0),
        (0.30, 0.60, -0.05), (0.08, 0.96, 0.10),
        (-0.80, 0.20, -0.55), (-0.25, 0.45, -0.40),
        (20, -26, -16, -20),
    )

def anim_stance(arm_obj, start=2800):
    """20f 战技架势。剑平指前方，盾收到左侧。"""
    begin_action(arm_obj, "stance", start)
    reset_pose(arm_obj)
    guard(arm_obj, 1)
    _stance_pose(arm_obj, 5)
    _stance_pose(arm_obj, 20)

def anim_stance_poke(arm_obj, start=3000):
    """25f 架势突刺。先收到肋侧，再和盾一起刺出去。"""
    begin_action(arm_obj, "stancePoke", start)
    reset_pose(arm_obj)
    wind, active_end = hit_window("stancePoke")
    assert (wind, active_end) == (6, 10), (wind, active_end)
    _stance_pose(arm_obj, 1)
    chamber = ((-8, -14, 0), (0.50, -0.15, -0.05), (0.35, -0.50, 0.25), (-0.55, 0.35, -0.15), (0.05, 0.55, 0.05), (16, -24, -8, -16))
    pose_frame(arm_obj, 3, *chamber)
    pose_frame(arm_obj, wind, *chamber)
    pose_frame(arm_obj, wind + 1, (-12, 0, 0), (0.25, 0.55, 0.05), (0.10, 0.85, 0.06), (-0.30, 0.70, 0.08), (0.08, 0.95, 0.08), (20, -22, -6, -12))
    pose_frame(arm_obj, wind + 2, (-14, 6, 0), (0.10, 0.85, 0.0), (0.0, 1.0, 0.02), (-0.25, 0.80, 0.06), (0.05, 1.00, 0.06), (24, -20, -4, -10))
    pose_frame(arm_obj, active_end, (-14, 8, 0), (0.05, 0.90, -0.02), (0.0, 1.0, 0.0), (-0.20, 0.85, 0.04), (0.02, 1.02, 0.04), (24, -18, -2, -8))
    pose_frame(arm_obj, active_end + 3, (-10, 10, 0), (0.02, 0.88, -0.04), (-0.08, 0.96, 0.0), (-0.35, 0.65, 0.0), (0.05, 0.90, 0.02), (18, -22, -6, -12))
    guard(arm_obj, 25)

def anim_stance_up(arm_obj, start=3200):
    """28f 上挑。剑从身前下方翻上来，尖端走到头顶，不扫到身体另一侧。"""
    begin_action(arm_obj, "stanceUp", start)
    reset_pose(arm_obj)
    wind, active_end = hit_window("stanceUp")
    assert (wind, active_end) == (7, 11), (wind, active_end)
    _stance_pose(arm_obj, 1)
    hold = ((-0.80, 0.20, -0.55), (-0.25, 0.45, -0.40))
    low = ((-4, -8, 0), (0.35, 0.45, -0.40), (0.12, 0.40, -0.88), *hold, (18, -24, -14, -18))
    pose_frame(arm_obj, 3, *low)
    pose_frame(arm_obj, wind, *low)
    pose_frame(arm_obj, wind + 1, (-8, -2, 0), (0.25, 0.50, 0.05), (0.08, 0.55, 0.25), *hold, (16, -24, -12, -18))
    pose_frame(arm_obj, wind + 2, (-14, 4, 0), (0.18, 0.40, 0.40), (0.05, 0.40, 0.70), *hold, (14, -22, -12, -16))
    pose_frame(arm_obj, active_end, (-18, 6, 0), (0.12, 0.18, 0.72), (0.02, 0.12, 0.98), *hold, (12, -20, -10, -16))
    pose_frame(arm_obj, active_end + 3, (-16, 8, 0), (0.08, 0.10, 0.78), (0.0, 0.05, 1.0), *hold, (12, -20, -10, -16))
    guard(arm_obj, 28)

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

def finish_curves(arm_obj):
    """四元数走线性，欧拉夹紧。贝塞尔插值会把剑绕握把甩出去。"""
    nq = ne = 0
    for track in arm_obj.animation_data.nla_tracks:
        for strip in track.strips:
            act = strip.action
            if act is None:
                continue
            for fc in _iter_fcurves(act):
                if "quaternion" in fc.data_path:
                    nq += 1
                    for kp in fc.keyframe_points:
                        kp.interpolation = "LINEAR"
                elif "rotation_euler" in fc.data_path:
                    ne += 1
                    for kp in fc.keyframe_points:
                        kp.interpolation = "BEZIER"
                        kp.handle_left_type = "AUTO_CLAMPED"
                        kp.handle_right_type = "AUTO_CLAMPED"
    print(f"INFERNO_CURVES quat={nq} euler={ne}")
    if nq < 16:
        raise RuntimeError(f"手臂四元数曲线没有写进去 quat={nq}")

def _blade_tip():
    """锥尖在局部 -Z。半长记在刃上，换尺寸不用改这里。"""
    bpy.context.view_layer.update()
    blade = bpy.data.objects["Blade"]
    half = float(blade.get("half", 0.64))
    return blade.matrix_world @ Vector((0.0, 0.0, -half))

def assert_attacks(arm_obj):
    """剑尖必须在身前划过。拧到背后、指到天上的旧挥法在这里失败。"""
    for track in arm_obj.animation_data.nla_tracks:
        track.mute = True
    arm_obj.animation_data.use_nla = False

    def tip_at(action, frame):
        arm_obj.animation_data.action = bpy.data.actions[action]
        bpy.context.scene.frame_set(frame)
        return _blade_tip()

    checks = (
        ("attack", 1, lambda t: t.y > 0.4 and 0.2 < t.z < 1.15),
        ("attack", 6, lambda t: t.x > 0.4 and t.z > 1.8 and t.y > -0.15),
        ("attack", 8, lambda t: t.y > 1.0 and abs(t.x) < 0.85),
        ("attack", 12, lambda t: t.x < -0.5 and t.y > 0.3),
        ("runAttack", 8, lambda t: t.y > 0.9),
        ("rollAttack", 7, lambda t: t.y > 0.6),
        ("backstepAttack", 8, lambda t: t.y > 0.8),
        ("stancePoke", 9, lambda t: t.y > 0.9),
        ("stanceUp", 10, lambda t: t.z > 1.6 and t.y > -0.2),
    )
    for name, frame, pred in checks:
        tip = tip_at(name, frame)
        if not pred(tip):
            raise RuntimeError(f"{name} f{frame} 剑尖 {tuple(round(c, 2) for c in tip)}")
    def shield_at(action, frame):
        tip_at(action, frame)
        shield = bpy.data.objects["Shield"]
        loc = shield.matrix_world.translation
        normal = shield.matrix_world.to_3x3().col[2].normalized()
        return loc, normal

    shield_checks = (
        ("attack", 1, lambda loc, n: loc.x < -0.15 and loc.y > 0.25 and n.y > 0.8),
        ("attack", 12, lambda loc, n: n.y > 0.45),
        ("block_idle", 1, lambda loc, n: loc.z > 1.45 and n.y > 0.75),
        ("parry", 4, lambda loc, n: loc.y > 0.40 and n.y > 0.65),
        ("estus", 16, lambda loc, n: loc.x < -0.25 and loc.z > 1.55),
        ("stance", 5, lambda loc, n: loc.x < -0.30 and n.y > 0.55),
    )
    for name, frame, pred in shield_checks:
        loc, normal = shield_at(name, frame)
        if not pred(loc, normal):
            raise RuntimeError(
                f"{name} f{frame} 盾 loc={tuple(round(c, 2) for c in loc)} "
                f"n={tuple(round(c, 2) for c in normal)}"
            )
    print("INFERNO_SLASH_OK")

def export(arm_obj):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    finish_curves(arm_obj)
    _fix_nla_slots(arm_obj)
    arm_obj.animation_data.action = None
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
        export_optimize_animation_size=False,  # 不做尺寸优化抽键（否则每通道被抽到 2 键）
    )
    (OUT_DIR / "character_frames.json").write_text(
        json.dumps(FRAME_DATA, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"INFERNO_EXPORT glb={glb} size={glb.stat().st_size} json={list(FRAME_DATA['clips'].keys())}")

def main():
    # 场景帧率对齐 FRAME_DATA 的 FPS=30：glTF 导出的关键帧时间 = 帧/30，
    # 与 character_frames.json 的秒数严格同步（默认 24 会慢 25%）
    bpy.context.scene.render.fps = FPS
    clear_scene()
    arm_obj = build_armature()
    build_parts(arm_obj)
    seat_shield(arm_obj)
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
    assert_attacks(arm_obj)
    export(arm_obj)

main()
