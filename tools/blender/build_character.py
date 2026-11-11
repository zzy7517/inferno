#!/usr/bin/env python3
"""
Inferno — 剑盾不死人生成脚本（ADR-0003：脚本即事实源）

形体 v2：从方块堆升级为真形体（球/锥/环组合 + 平滑着色）——
  头盔球冠、渐细四肢、胸甲圆壳、曲面前盾、带护手宝剑、肩后披风。
  骨架 / 动画 / 导出契约与 v1 完全一致（玩家代码零改动）。

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

def make_mat(name, color, rough=0.85):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    color_in = next(i for i in bsdf.inputs if i.name in ("Base Color", "Base Colour"))
    color_in.default_value = (*color, 1.0)
    rough_in = next(i for i in bsdf.inputs if "Roughness" in i.name)
    rough_in.default_value = rough
    return mat

def _smooth(obj):
    for p in obj.data.polygons:
        p.use_smooth = True
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
    return _smooth(_add(bpy.context.active_object, name, loc, mat, rot=rot, scale=scale))

def make_cone(name, loc, mat, r1, r2, depth, seg=12, rot=(0, 0, 0), scale=(1, 1, 1)):
    """圆台（平滑着色）：渐细四肢/躯干/剑刃（r2=0 即锥尖）。"""
    bpy.ops.mesh.primitive_cone_add(vertices=seg, radius1=r1, radius2=r2, depth=depth,
                                    location=(0, 0, 0), rotation=rot)
    return _smooth(_add(bpy.context.active_object, name, loc, mat, rot=rot, scale=scale))

def make_cyl(name, loc, mat, r, depth, seg=12, rot=(0, 0, 0), scale=(1, 1, 1)):
    """圆柱（平滑着色）：剑柄/脖颈等。"""
    bpy.ops.mesh.primitive_cylinder_add(vertices=seg, radius=r, depth=depth,
                                        location=(0, 0, 0), rotation=rot)
    return _smooth(_add(bpy.context.active_object, name, loc, mat, rot=rot, scale=scale))

def make_torus(name, loc, mat, r, tube, seg=20, rot=(0, 0, 0), scale=(1, 1, 1)):
    """环（平滑着色）：盾缘/盔沿。"""
    bpy.ops.mesh.primitive_torus_add(major_segments=seg, minor_segments=8,
                                     major_radius=r, minor_radius=tube,
                                     location=(0, 0, 0), rotation=rot)
    return _smooth(_add(bpy.context.active_object, name, loc, mat, rot=rot, scale=scale))

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
    """父子绑定到骨骼；matrix_parent_inverse 使 obj 保持世界坐标创作。"""
    obj.parent = arm_obj
    obj.parent_type = "BONE"
    obj.parent_bone = bone_name
    obj.matrix_parent_inverse = arm_obj.matrix_world.inverted()

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
# 2. 部件（世界坐标创作，绑定到骨骼）—— 不死人剑盾侠，灰锈基调
#    v2：球/锥/环真形体，平滑着色；绑定骨骼与质心位置沿用 v1，动画轮廓不变
# ============================================================
M_BODY  = make_mat("body",  (0.29, 0.27, 0.25))
M_LIMB  = make_mat("limb",  (0.23, 0.215, 0.20))
M_METAL = make_mat("metal", (0.35, 0.33, 0.29), 0.7)
M_STEEL = make_mat("steel", (0.56, 0.60, 0.64), 0.4)
M_RUST  = make_mat("rust",  (0.43, 0.23, 0.18))
M_DARK  = make_mat("dark",  (0.10, 0.10, 0.12), 0.6)
M_CLOTH = make_mat("cloth", (0.16, 0.14, 0.13), 0.95)

RX90 = (math.radians(90), 0, 0)        # Z 轴几何体躺平成 X 轴（手臂方向）
RY90 = (0, math.radians(90), 0)

def build_parts(arm_obj):
    # —— 躯干：圆台腰身 + 球形胸甲 ——
    make_sphere("Pelvis",   (0, 0, 0.98), M_BODY, 0.125, scale=(1.15, 0.92, 0.85))
    make_cone("TorsoLower", (0, 0, 1.10), M_BODY, 0.155, 0.145, 0.20)
    make_cone("Chest",      (0, 0, 1.31), M_BODY, 0.175, 0.150, 0.24)   # 肩宽腰窄
    make_sphere("ChestPlate", (0, 0.045, 1.30), M_METAL, 0.155, seg=14, ring=10, scale=(1.0, 0.72, 1.05))
    make_cyl("Neck",        (0, 0, 1.50), M_LIMB, 0.045, 0.10)

    # —— 头：球头 + 鼻护盔（球冠 + 盔沿环 + 眼缝）——
    make_sphere("Head",     (0, 0.01, 1.70), M_BODY, 0.095)
    make_sphere("Helm",     (0, 0, 1.715), M_METAL, 0.105, seg=16, ring=10, scale=(1.0, 0.95, 1.02))
    make_torus("HelmBrim",  (0, 0.035, 1.70), M_METAL, 0.098, 0.014, rot=RY90, scale=(1.0, 1.0, 0.55))
    make_box("EyeSlit",     (0.15, 0.026, 0.045), (0, 0.098, 1.705), M_DARK)

    # —— 肩甲：半球壳扣肩 ——
    make_sphere("PauldronL", (0.215, 0, 1.455), M_METAL, 0.085, seg=12, ring=8, scale=(1.1, 1.05, 0.72))
    make_sphere("PauldronR", (-0.215, 0, 1.455), M_METAL, 0.085, seg=12, ring=8, scale=(1.1, 1.05, 0.72))

    # —— 手臂：渐细圆台沿 X 轴，拳为球 ——
    make_cone("UArmL", (0.31, 0, 1.435), M_LIMB, 0.058, 0.048, 0.24, rot=RY90)
    make_cone("UArmR", (-0.31, 0, 1.435), M_LIMB, 0.058, 0.048, 0.24, rot=RY90)
    make_cone("LArmL", (0.51, 0, 1.435), M_LIMB, 0.046, 0.038, 0.20, rot=RY90)
    make_cone("LArmR", (-0.51, 0, 1.435), M_LIMB, 0.046, 0.038, 0.20, rot=RY90)
    make_sphere("HandL", (0.635, 0, 1.43), M_LIMB, 0.048, seg=10, ring=8, scale=(0.95, 0.9, 1.15))
    make_sphere("HandR", (-0.635, 0, 1.43), M_LIMB, 0.048, seg=10, ring=8, scale=(0.95, 0.9, 1.15))

    # —— 腿：渐细圆台沿 Z 轴，靴为拉长球 ——
    make_cone("ThighL", (0.11, 0, 0.72), M_LIMB, 0.075, 0.058, 0.42)
    make_cone("ThighR", (-0.11, 0, 0.72), M_LIMB, 0.075, 0.058, 0.42)
    make_cone("ShinL",  (0.11, 0, 0.31), M_LIMB, 0.056, 0.042, 0.40)
    make_cone("ShinR",  (-0.11, 0, 0.31), M_LIMB, 0.056, 0.042, 0.40)
    make_sphere("FootL", (0.11, 0.055, 0.055), M_DARK, 0.058, seg=10, ring=8, scale=(0.72, 1.55, 0.55))
    make_sphere("FootR", (-0.11, 0.055, 0.055), M_DARK, 0.058, seg=10, ring=8, scale=(0.72, 1.55, 0.55))

    # —— 披风：细分网格带弧度（挂胸骨，身后垂坠）——
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=4, y_subdivisions=6, size=0.42, location=(0, 0, 0))
    cape = bpy.context.active_object
    cape.name = "Cape"
    cape.rotation_euler = RX90                       # 竖起贴背
    cape.location = (0, -0.135, 1.36)
    cape.scale = (0.82, 1.6, 1.0)
    # 沿高度弯出弧度：下摆向后飘
    for v in cape.data.vertices:
        vz = v.co.y                                  # RX90 后平面局部 y 即世界高度方向
        v.co.z += (vz ** 2) * 0.55                   # 下摆后掠
        v.co.x *= 1.0 - max(0.0, -vz) * 0.12         # 下摆略收
    _smooth(cape)
    if not cape.users_collection:                    # grid 原语已自动挂 collection
        bpy.context.collection.objects.link(cape)
    cape.data.materials.append(M_CLOTH)

    # —— 剑（绑右手）：柄/护手/刃（压扁圆台出剑尖）/配重球 ——
    make_cyl("Grip",   (-0.645, 0, 1.62), M_DARK, 0.016, 0.15)
    make_box("Guard",  (0.15, 0.035, 0.045), (-0.645, 0, 1.535), M_METAL)
    make_sphere("Pommel", (-0.645, 0, 1.695), M_METAL, 0.026, seg=10, ring=8)
    make_cone("Blade", (-0.645, 0, 1.14), M_STEEL, 0.030, 0.003, 0.80, seg=8, scale=(1.0, 0.24, 1.0))

    # —— 盾（绑左前臂）：曲面圆盾 + 盾缘 + 盾心 ——
    make_cyl("Shield",     (0.545, 0.075, 1.36), M_RUST, 0.175, 0.035, seg=20, rot=(math.radians(75), 0, 0))
    make_torus("ShieldRim", (0.556, 0.095, 1.36), M_METAL, 0.172, 0.011, rot=(math.radians(75), 0, 0))
    make_sphere("ShieldBoss", (0.525, 0.105, 1.36), M_METAL, 0.045, seg=10, ring=8, scale=(0.55, 1, 1))

    # —— 绑骨（沿用 v1 映射）——
    BONE_OF = {
        "Pelvis": "Hips", "TorsoLower": "Spine", "Chest": "Chest", "ChestPlate": "Chest",
        "Neck": "Neck", "Head": "Head", "Helm": "Head", "HelmBrim": "Head", "EyeSlit": "Head",
        "PauldronL": "UpperArm.L", "PauldronR": "UpperArm.R",
        "UArmL": "UpperArm.L", "UArmR": "UpperArm.R",
        "LArmL": "LowerArm.L", "LArmR": "LowerArm.R",
        "HandL": "Hand.L", "HandR": "Hand.R",
        "ThighL": "UpperLeg.L", "ThighR": "UpperLeg.R",
        "ShinL": "LowerLeg.L", "ShinR": "LowerLeg.R",
        "FootL": "Foot.L", "FootR": "Foot.R",
        "Cape": "Chest",
        "Grip": "Hand.R", "Guard": "Hand.R", "Pommel": "Hand.R", "Blade": "Hand.R",
        "Shield": "LowerArm.L", "ShieldRim": "LowerArm.L", "ShieldBoss": "LowerArm.L",
    }
    for name, bone in BONE_OF.items():
        attach_to_bone(bpy.data.objects[name], arm_obj, bone)

# ============================================================
# 3. 动画（pose 关键帧 → 独立 action → NLA 轨道）—— 与 v1 逐帧一致
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

STANCE = {  # 待机基准姿态（各动画的 f1 与收尾都回到这里）
    "Chest":      {"rot": (RAD(6), 0, 0)},
    "Spine":      {"rot": (RAD(4), 0, 0)},
    "Head":       {"rot": (RAD(-6), 0, 0)},
    "UpperArm.R": {"rot": (0, 0, RAD(18))},   # 右臂微收，剑贴腿
    "UpperArm.L": {"rot": (0, 0, RAD(-24))},  # 左臂持盾微抬
    "LowerArm.L": {"rot": (RAD(-20), 0, 0)},
}

def apply_stance(pbs, frame):
    for bone, p in STANCE.items():
        key(pbs[bone], frame, rot=p["rot"])

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
    """27f=0.9s：前摇f1-6 蓄势右转，判定f7-9 横斩，后摇f10-27 收势"""
    begin_action(arm_obj, "attack", start)
    pbs = pose_bones(arm_obj)
    apply_stance(pbs, 1)
    # —— 前摇结束 f6：拧腰向后拉剑
    key(pbs["Chest"], 6, rot=(RAD(8), 0, RAD(28)))
    key(pbs["UpperArm.R"], 6, rot=(RAD(-30), 0, RAD(60)))   # 举剑后引
    key(pbs["LowerArm.R"], 6, rot=(RAD(-35), 0, 0))
    key(pbs["Hips"], 6, loc=(0, 0, 0.945))
    # —— 判定帧 f9：腰拧到左侧，剑横扫过去
    key(pbs["Chest"], 9, rot=(RAD(10), 0, RAD(-38)))
    key(pbs["UpperArm.R"], 9, rot=(RAD(25), 0, RAD(-40)))
    key(pbs["LowerArm.R"], 9, rot=(RAD(-10), 0, 0))
    key(pbs["Hips"], 9, loc=(0, 0, 0.94))                    # 重心下沉=重量感
    # —— 后摇 f12 过冲 → f27 回到待机
    key(pbs["Chest"], 12, rot=(RAD(9), 0, RAD(-30)))
    key(pbs["UpperArm.R"], 12, rot=(RAD(18), 0, RAD(-28)))
    apply_stance(pbs, 27)

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
#     姿势约定：Chest x+ 前倾 / UpperArm.R z- 臂前送 / LowerArm.R x- 剑放平前指
#               UpperLeg x+ 腿前抬。关键帧终点都 ≥ total×30+1 帧（两种导出 fps 下状态机可收尾）
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
    """24f 跑攻·跳步直刺：f4 蜷身拉剑（前摇 0.18s），f7 跃进刺出（判定 0.12s），f24 收势"""
    begin_action(arm_obj, "runAttack", start)
    pbs = pose_bones(arm_obj)
    apply_stance(pbs, 1)
    key(pbs["Hips"], 1, loc=(0, 0, 0.96))
    # f4 蜷身蓄势：重心压低，剑收腰后
    key(pbs["Hips"], 4, loc=(0, -0.02, 0.90))
    key(pbs["Chest"], 4, rot=(RAD(14), 0, RAD(22)))
    key(pbs["UpperArm.R"], 4, rot=(RAD(-10), 0, RAD(-25)))
    key(pbs["LowerArm.R"], 4, rot=(RAD(-100), 0, 0))             # 剑尖拉后
    key(pbs["UpperLeg.L"], 4, rot=(RAD(30), 0, 0))
    key(pbs["LowerLeg.L"], 4, rot=(RAD(35), 0, 0))
    # f7 跃进刺出：臂前送、剑水平、低重心、双腿劈叉
    key(pbs["Hips"], 7, loc=(0, 0.03, 0.84))
    key(pbs["Chest"], 7, rot=(RAD(16), 0, RAD(-8)))
    key(pbs["UpperArm.R"], 7, rot=(RAD(-6), 0, RAD(-72)))
    key(pbs["LowerArm.R"], 7, rot=(RAD(-84), 0, 0))
    key(pbs["UpperArm.L"], 7, rot=(RAD(-25), 0, RAD(-55)))       # 盾臂后张开平衡
    key(pbs["UpperLeg.L"], 7, rot=(RAD(42), 0, 0))
    key(pbs["LowerLeg.L"], 7, rot=(RAD(15), 0, 0))
    key(pbs["UpperLeg.R"], 7, rot=(RAD(-32), 0, 0))
    key(pbs["LowerLeg.R"], 7, rot=(RAD(8), 0, 0))
    # f11 前穿过度 → f24 回待机
    key(pbs["Hips"], 11, loc=(0, 0.01, 0.90))
    key(pbs["Chest"], 11, rot=(RAD(12), 0, RAD(-4)))
    key(pbs["UpperArm.R"], 11, rot=(RAD(-2), 0, RAD(-55)))
    key(pbs["LowerArm.R"], 11, rot=(RAD(-60), 0, 0))
    key(pbs["Hips"], 24, loc=(0, 0, 0.96))
    key(pbs["LowerArm.R"], 24, rot=(0, 0, 0))
    apply_stance(pbs, 24)
    _reset_legs(pbs, 24)

def anim_roll_attack(arm_obj, start=2000):
    """20f 翻滚攻·起身横扫：从翻滚收尾的低伏姿势抡剑起身，f5 判定（active 0.12s @0.14）"""
    begin_action(arm_obj, "rollAttack", start)
    pbs = pose_bones(arm_obj)
    # f1 低伏起手（接翻滚收尾姿态）
    key(pbs["Hips"], 1, loc=(0, 0.03, 0.74))
    key(pbs["Spine"], 1, rot=(RAD(18), 0, 0))
    key(pbs["Chest"], 1, rot=(RAD(20), 0, RAD(24)))
    key(pbs["UpperArm.R"], 1, rot=(RAD(-20), 0, RAD(55)))
    key(pbs["LowerArm.R"], 1, rot=(RAD(-40), 0, 0))
    key(pbs["UpperLeg.L"], 1, rot=(RAD(-35), 0, 0))
    key(pbs["LowerLeg.L"], 1, rot=(RAD(50), 0, 0))
    key(pbs["UpperLeg.R"], 1, rot=(RAD(20), 0, 0))
    key(pbs["LowerLeg.R"], 1, rot=(RAD(30), 0, 0))
    # f5 起身横扫过中线（判定帧）
    key(pbs["Hips"], 5, loc=(0, 0.01, 0.90))
    key(pbs["Chest"], 5, rot=(RAD(14), 0, RAD(-36)))
    key(pbs["UpperArm.R"], 5, rot=(RAD(10), 0, RAD(-30)))
    key(pbs["LowerArm.R"], 5, rot=(RAD(-12), 0, 0))
    # f8 过冲 → f20 回待机
    key(pbs["Chest"], 8, rot=(RAD(10), 0, RAD(-28)))
    key(pbs["UpperArm.R"], 8, rot=(RAD(6), 0, RAD(-20)))
    key(pbs["Hips"], 20, loc=(0, 0, 0.96))
    key(pbs["LowerArm.R"], 20, rot=(0, 0, 0))
    apply_stance(pbs, 20)
    _reset_legs(pbs, 20)

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
    """22f 后撤攻·后撤直刺：从后撤落定的低姿直接捅出，f6 判定（active 0.12s @0.16）"""
    begin_action(arm_obj, "backstepAttack", start)
    pbs = pose_bones(arm_obj)
    apply_stance(pbs, 1)
    key(pbs["Hips"], 1, loc=(0, 0, 0.92))
    # f3 拉剑
    key(pbs["Chest"], 3, rot=(RAD(12), 0, RAD(18)))
    key(pbs["UpperArm.R"], 3, rot=(RAD(-8), 0, RAD(-20)))
    key(pbs["LowerArm.R"], 3, rot=(RAD(-95), 0, 0))
    # f6 直刺（判定）
    key(pbs["Hips"], 6, loc=(0, 0.02, 0.88))
    key(pbs["Chest"], 6, rot=(RAD(15), 0, RAD(-6)))
    key(pbs["UpperArm.R"], 6, rot=(RAD(-4), 0, RAD(-68)))
    key(pbs["LowerArm.R"], 6, rot=(RAD(-82), 0, 0))
    key(pbs["UpperLeg.L"], 6, rot=(RAD(28), 0, 0))
    key(pbs["UpperLeg.R"], 6, rot=(RAD(-20), 0, 0))
    # f10 收 → f22 待机
    key(pbs["Hips"], 10, loc=(0, 0, 0.94))
    key(pbs["UpperArm.R"], 10, rot=(0, 0, RAD(-40)))
    key(pbs["LowerArm.R"], 10, rot=(RAD(-50), 0, 0))
    key(pbs["Hips"], 22, loc=(0, 0, 0.96))
    key(pbs["LowerArm.R"], 22, rot=(0, 0, 0))
    apply_stance(pbs, 22)
    _reset_legs(pbs, 22)

def anim_kick(arm_obj, start=2600):
    """24f 踢击（破盾）：f5 提膝蓄势，f7 前踢判定（active 0.10s @0.22），上身后仰配重"""
    begin_action(arm_obj, "kick", start)
    pbs = pose_bones(arm_obj)
    apply_stance(pbs, 1)
    key(pbs["Hips"], 1, loc=(0, 0, 0.96))
    # f5 提膝：重心后坐
    key(pbs["Hips"], 5, loc=(0, -0.01, 0.94))
    key(pbs["Chest"], 5, rot=(RAD(-8), 0, RAD(-10)))
    key(pbs["UpperLeg.R"], 5, rot=(RAD(45), 0, 0))               # 提膝
    key(pbs["LowerLeg.R"], 5, rot=(RAD(70), 0, 0))               # 小腿收紧
    key(pbs["UpperArm.L"], 5, rot=(RAD(-25), 0, RAD(-70)))       # 盾臂前顶
    # f7 踢出：腿水平蹬直，上身后仰
    key(pbs["Hips"], 7, loc=(0, 0.01, 0.95))
    key(pbs["Chest"], 7, rot=(RAD(-14), 0, RAD(-6)))
    key(pbs["Head"], 7, rot=(RAD(-10), 0, 0))
    key(pbs["UpperLeg.R"], 7, rot=(RAD(85), 0, 0))
    key(pbs["LowerLeg.R"], 7, rot=(RAD(5), 0, 0))
    # f10 收腿 → f24 待机
    key(pbs["Hips"], 10, loc=(0, 0, 0.94))
    key(pbs["UpperLeg.R"], 10, rot=(RAD(20), 0, 0))
    key(pbs["LowerLeg.R"], 10, rot=(RAD(35), 0, 0))
    key(pbs["UpperLeg.R"], 24, rot=(0, 0, 0))
    key(pbs["LowerLeg.R"], 24, rot=(0, 0, 0))
    key(pbs["Hips"], 24, loc=(0, 0, 0.96))
    apply_stance(pbs, 24)

def anim_stance(arm_obj, start=2800):
    """20f 战技·架势：f5 入架，f20 保持（0.6s 由代码按帧数据结算）"""
    begin_action(arm_obj, "stance", start)
    pbs = pose_bones(arm_obj)
    apply_stance(pbs, 1)
    key(pbs["Hips"], 1, loc=(0, 0, 0.96))
    _stance_pose(pbs, 5)
    _stance_pose(pbs, 20)

def anim_stance_poke(arm_obj, start=3000):
    """25f 架势派生·盾冲突刺：f8 大步突刺判定（active 0.12s @0.20），f25 收势"""
    begin_action(arm_obj, "stancePoke", start)
    pbs = pose_bones(arm_obj)
    _stance_pose(pbs, 1)
    # f5 蓄：剑后收半寸
    key(pbs["Chest"], 5, rot=(RAD(8), 0, RAD(14)))
    key(pbs["UpperArm.R"], 5, rot=(RAD(-6), 0, RAD(-38)))
    key(pbs["LowerArm.R"], 5, rot=(RAD(-95), 0, 0))
    # f8 大步突刺（判定帧）
    key(pbs["Hips"], 8, loc=(0, 0.04, 0.86))
    key(pbs["Chest"], 8, rot=(RAD(18), 0, RAD(-10)))
    key(pbs["UpperArm.R"], 8, rot=(RAD(-6), 0, RAD(-78)))
    key(pbs["LowerArm.R"], 8, rot=(RAD(-86), 0, 0))
    key(pbs["UpperArm.L"], 8, rot=(RAD(-40), 0, RAD(-30)))       # 盾压前顶
    key(pbs["UpperLeg.L"], 8, rot=(RAD(45), 0, 0))
    key(pbs["LowerLeg.L"], 8, rot=(RAD(12), 0, 0))
    key(pbs["UpperLeg.R"], 8, rot=(RAD(-35), 0, 0))
    # f13 穿刺保持 → f25 回待机
    key(pbs["Hips"], 13, loc=(0, 0.01, 0.90))
    key(pbs["UpperArm.R"], 13, rot=(RAD(-4), 0, RAD(-60)))
    key(pbs["LowerArm.R"], 13, rot=(RAD(-70), 0, 0))
    key(pbs["Hips"], 25, loc=(0, 0, 0.96))
    key(pbs["LowerArm.R"], 25, rot=(0, 0, 0))
    apply_stance(pbs, 25)
    _reset_legs(pbs, 25)

def anim_stance_up(arm_obj, start=3200):
    """28f 架势派生·上挑：f5 沉剑蓄势，f8 上撩判定（active 0.14s @0.24），f28 收势"""
    begin_action(arm_obj, "stanceUp", start)
    pbs = pose_bones(arm_obj)
    _stance_pose(pbs, 1)
    # f5 沉剑向下蓄
    key(pbs["Hips"], 5, loc=(0, 0.01, 0.88))
    key(pbs["Chest"], 5, rot=(RAD(16), 0, RAD(10)))
    key(pbs["UpperArm.R"], 5, rot=(RAD(-10), 0, RAD(-40)))
    key(pbs["LowerArm.R"], 5, rot=(RAD(-115), 0, 0))             # 剑尖垂地
    # f8 上撩（判定）：剑挑上天，胸膛打开
    key(pbs["Hips"], 8, loc=(0, 0.01, 0.99))
    key(pbs["Chest"], 8, rot=(RAD(-12), 0, RAD(-14)))
    key(pbs["Head"], 8, rot=(RAD(-16), 0, 0))
    key(pbs["UpperArm.R"], 8, rot=(RAD(-30), 0, RAD(-30)))
    key(pbs["LowerArm.R"], 8, rot=(RAD(35), 0, 0))               # 剑指天
    key(pbs["UpperArm.L"], 8, rot=(RAD(-45), 0, RAD(-55)))       # 盾臂甩开
    key(pbs["UpperLeg.L"], 8, rot=(RAD(10), 0, 0))
    # f13 定格高点 → f28 回待机
    key(pbs["Hips"], 13, loc=(0, 0.01, 0.96))
    key(pbs["UpperArm.R"], 13, rot=(RAD(-20), 0, RAD(-35)))
    key(pbs["LowerArm.R"], 13, rot=(RAD(20), 0, 0))
    apply_stance(pbs, 28)
    key(pbs["Hips"], 28, loc=(0, 0, 0.96))
    key(pbs["LowerArm.R"], 28, rot=(0, 0, 0))
    _reset_legs(pbs, 28)

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

def export(arm_obj):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    _fix_nla_slots(arm_obj)
    arm_obj.animation_data.action = None   # NLA 为权威
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
