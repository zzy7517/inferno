#!/usr/bin/env python3
"""
Inferno — 八个 Boss 的形体（ADR-0003：bpy 脚本是事实源，不存 .blend）

低多边形、平面着色、冷灰打底，每个 Boss 只用它在游戏里已经在用的那支强调色。
不打光、不贴图。挂到空物体上时用 parent_set(keep_transform=True)，
导出后网格留在挂点的局部空间，游戏再按名字挂回 torso / arm，姿态仍由代码转。

面朝 Blender -Y。glTF 导出把 -Y 收成 Three.js +Z（Boss 组的前方），+Z 收成向上。

用法:
  blender -b -P tools/blender/build_bosses.py
"""
import bpy
import math
from pathlib import Path
from mathutils import Euler, Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "web" / "public" / "assets" / "bosses"

# Blender 欧拉（度）。锥/柱的局部 +Z 是尖端。导出后外观与这里一致。
AIM = {
    "up": (0, 0, 0),
    "down": (180, 0, 0),
    "forward": (90, 0, 0),    # Blender -Y = 游戏 +Z
    "back": (-90, 0, 0),
    "right": (0, 90, 0),
    "left": (0, -90, 0),
}


def bpos(x, y, z):
    """Three.js (x, 上, 前) → Blender 位置。"""
    return (x, -z, y)


def game_rotation(rx, ry, rz):
    """Three.js 的 XYZ 欧拉（弧度）→ Blender 旋转矩阵。
    轴映射同 bpos：e_x→e_x、e_y→e_z、e_z→-e_y，共轭后
    Rx·Ry·Rz → Rx(rx)·Rz(ry)·Ry(-rz)。武器 rest 姿态必须走这里，
    直接在 Blender 轴上写欧拉会把 Y/Z 抄错。"""
    R = lambda axis, a: Matrix.Rotation(a, 4, axis)
    return R((1, 0, 0), rx) @ R((0, 0, 1), ry) @ R((0, 1, 0), -rz)



def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.armatures):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def make_mat(name, color, rough=0.85, metal=0.05, emission=None, emission_strength=0.0, alpha=1.0, double=False):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    if double:
        mat.use_backface_culling = False
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")

    def put(pred, value):
        sock = next((i for i in bsdf.inputs if pred(i)), None)
        if sock is not None:
            sock.default_value = value

    put(lambda i: i.name in ("Base Color", "Base Colour"), (*color, 1.0))
    put(lambda i: "Roughness" in i.name, rough)
    put(lambda i: i.name.startswith("Metallic"), metal)
    if alpha < 0.999:
        put(lambda i: i.name == "Alpha", alpha)
        if hasattr(mat, "blend_method"):
            mat.blend_method = "BLEND"
    if emission is not None and emission_strength > 0:
        put(lambda i: i.name in ("Emission Color", "Emission Colour", "Emission"), (*emission, 1.0))
        put(lambda i: "Strength" in i.name and "Emission" in i.name, emission_strength)
    return mat


def shade(obj):
    for p in obj.data.polygons:
        p.use_smooth = False
    return obj


def parent_keep(child, parent):
    """部件挂到空物体上，世界位置不动。运行时不会再被父矩阵乘一次。"""
    world = child.matrix_world.copy()
    bpy.ops.object.select_all(action="DESELECT")
    child.select_set(True)
    parent.select_set(True)
    bpy.context.view_layer.objects.active = parent
    bpy.ops.object.parent_set(type="OBJECT", keep_transform=True)
    bpy.context.view_layer.update()
    got = child.matrix_world
    drift = max(abs(got[i][j] - world[i][j]) for i in range(4) for j in range(4))
    if drift > 1e-4:
        raise RuntimeError(f"{child.name} -> {parent.name} 绑定后漂移 {drift:.6f}")
    return child


def empty(name):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = 0.12
    bpy.context.collection.objects.link(obj)
    return obj


def slot(name, parent, x, y, z):
    """挂点。x,y,z 是游戏里这个组相对父级的位置（米）。旋转留给代码。"""
    obj = empty(name)
    local = Matrix.Translation(Vector(bpos(x, y, z)))
    obj.matrix_world = (parent.matrix_world @ local) if parent else local
    if parent:
        parent_keep(obj, parent)
    return obj


def _finish(obj, parent, mat):
    shade(obj)
    if mat is not None and obj.data.materials:
        obj.data.materials[0] = mat
    elif mat is not None:
        obj.data.materials.append(mat)
    parent_keep(obj, parent)
    return obj


def _place(obj, parent, center, rot, scale):
    sx, sy, sz = scale
    R = Euler(tuple(math.radians(a) for a in rot), "XYZ").to_matrix().to_4x4()
    S = Matrix.Diagonal(Vector((sx, sz, sy, 1.0)))
    T = Matrix.Translation(Vector(bpos(*center)))
    obj.matrix_world = parent.matrix_world @ (T @ R @ S)
    return obj


def sphere(name, parent, center, r, mat, scale=(1, 1, 1), seg=8, ring=6):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=ring, radius=r, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    _place(obj, parent, center, (0, 0, 0), scale)
    return _finish(obj, parent, mat)


def box(name, parent, center, size, mat, brot=(0, 0, 0)):
    """size 是游戏空间的 (宽, 高, 深)。"""
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    _place(obj, parent, center, brot, size)
    return _finish(obj, parent, mat)


def cone(name, parent, center, r1, r2, depth, mat, aim="up", seg=7, brot=None):
    """r1 在底、r2 在尖。尖端是局部 +Z，再转到 aim。"""
    bpy.ops.mesh.primitive_cone_add(vertices=seg, radius1=r1, radius2=r2, depth=depth, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    _place(obj, parent, center, AIM[aim] if brot is None else brot, (1, 1, 1))
    return _finish(obj, parent, mat)


def cyl(name, parent, center, r, depth, mat, aim="up", seg=8, brot=None):
    bpy.ops.mesh.primitive_cylinder_add(vertices=seg, radius=r, depth=depth, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    _place(obj, parent, center, AIM[aim] if brot is None else brot, (1, 1, 1))
    return _finish(obj, parent, mat)


def torus(name, parent, center, major, minor, mat, seg=10):
    bpy.ops.mesh.primitive_torus_add(
        major_segments=seg, minor_segments=6, major_radius=major, minor_radius=minor, location=(0, 0, 0)
    )
    obj = bpy.context.active_object
    obj.name = name
    _place(obj, parent, center, (0, 0, 0), (1, 1, 1))
    return _finish(obj, parent, mat)


def marker(name, parent, local_blender):
    """空物体留在武器局部空间。local_blender 沿网格自己的轴：锥尖在 +Z。"""
    obj = empty(name)
    obj.matrix_world = parent.matrix_world @ Matrix.Translation(Vector(local_blender))
    parent_keep(obj, parent)
    return obj


def blade_markers(blade, hilt_name, tip_name, depth):
    marker(hilt_name, blade, (0.0, 0.0, -depth / 2))
    marker(tip_name, blade, (0.0, 0.0, depth / 2))
    return blade


def mesh_local(name, parent, origin, verts, faces, mat):
    """verts 是网格局部的游戏坐标 (x, 上, 前)。物体原点在 origin，旋转为单位，方便代码再去摆它。"""
    bverts = [bpos(*v) for v in verts]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(bverts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    _place(obj, parent, origin, (0, 0, 0), (1, 1, 1))
    return _finish(obj, parent, mat)


def hanging_skirt(name, parent, y, top_r, bot_r, height, mat, gap=0.9, cols=8):
    """上沿在原点，下摆垂在脚下。前襟留缝。代码改 rotation 时围着腰带转。"""
    verts = []
    rings = ((0.0, top_r), (-height, bot_r))
    span = math.tau - gap
    for yy, rr in rings:
        for i in range(cols):
            ang = -span / 2 + span * (i / (cols - 1))
            verts.append((math.sin(ang) * rr, yy, math.cos(ang) * rr))
    faces = []
    for i in range(cols - 1):
        a, b = i, i + 1
        c, d = cols + i, cols + i + 1
        faces.append((a, b, d, c))
    return mesh_local(name, parent, (0, y, 0), verts, faces, mat)


def rag(name, parent, origin, width, length, mat):
    verts = [
        (-width * 0.5, 0, 0), (0, 0.02, -0.03), (width * 0.5, 0, 0),
        (-width * 0.35, -length * 0.55, -0.04), (0, -length * 0.5, -0.08), (width * 0.35, -length * 0.6, -0.03),
        (-width * 0.2, -length, -0.02), (0.02, -length * 0.92, -0.06), (width * 0.15, -length * 0.78, 0),
    ]
    faces = [(0, 1, 4, 3), (1, 2, 5, 4), (3, 4, 7, 6), (4, 5, 8, 7)]
    return mesh_local(name, parent, origin, verts, faces, mat)


def forward_segment(name, parent, length, r1, r2, mat, wide=1.0, tall=1.0):
    """蛇节。顶点烤进游戏的 +Z，物体旋转是单位，applyPose 才能拉长和瞄准。"""
    bpy.ops.mesh.primitive_cone_add(vertices=6, radius1=r1, radius2=r2, depth=length, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = (math.radians(90), 0, 0)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    obj.scale = (wide, 1.0, tall)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.matrix_world = parent.matrix_world.copy()
    return _finish(obj, parent, mat)


def skipped(obj):
    node = obj
    while node is not None:
        n = node.name
        if n.startswith(("weapon", "serpent", "bow", "summon", "ice", "dragon", "jaw", "gsword", "sword")):
            return True
        node = node.parent
    return False


def bounds(name_prefix=None, skip_gear=True):
    bpy.context.view_layer.update()
    zs = []
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        if name_prefix is not None and not obj.name.startswith(name_prefix):
            continue
        if name_prefix is None and skip_gear and skipped(obj):
            continue
        for v in obj.data.vertices:
            zs.append((obj.matrix_world @ v.co).z)
    if not zs:
        raise RuntimeError(f"没有可量的网格 {name_prefix}")
    return min(zs), max(zs)


def require_markers(*names):
    have = {obj.name for obj in bpy.data.objects}
    missing = [n for n in names if n not in have]
    if missing:
        raise RuntimeError(f"缺少判定点 {missing}")


def export_boss(name):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{name}.glb"
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        export_animations=False,
        export_skins=False,
        export_morph=False,
        use_selection=False,
    )
    print(f"INFERNO_BOSS_FILE {name} bytes={path.stat().st_size}")
    return path


def mesh_tops(limit=12):
    bpy.context.view_layer.update()
    rows = []
    for obj in bpy.data.objects:
        if obj.type != "MESH" or skipped(obj):
            continue
        top = max((obj.matrix_world @ v.co).z for v in obj.data.vertices)
        rows.append((top, obj.name))
    rows.sort(reverse=True)
    return rows[:limit]


def check_height(name, feet_max, helm, top_max, extra=()):
    feet, top = bounds()
    helm_z = bounds(helm[0], skip_gear=False)[1]
    print(f"INFERNO_BOSS {name} feet={feet:.2f} top={top:.2f} {helm[0]}={helm_z:.2f}")
    problems = []
    if feet < -0.08 or feet > feet_max:
        problems.append(f"脚底 {feet:.2f}")
    if abs(helm_z - helm[1]) > helm[2]:
        problems.append(f"{helm[0]} {helm_z:.2f} 不在 {helm[1]:.2f}±{helm[2]}")
    if top > top_max + 0.02:
        problems.append(f"身体最高 {top:.2f} 超过 {top_max}")
    for prefix, want, tol in extra:
        got = bounds(prefix, skip_gear=False)[1]
        print(f"INFERNO_BOSS {name} {prefix}={got:.2f} want={want:.2f}")
        if abs(got - want) > tol:
            problems.append(f"{prefix} {got:.2f} 不在 {want:.2f}±{tol}")
    if problems:
        for z, n in mesh_tops():
            print(f"  top {z:.2f} {n}")
        raise RuntimeError(name + " " + "; ".join(problems))


# ============================================================
# 共用：冷灰双足。各 Boss 再加自己的头、武器、强调色。
# ============================================================
def palette(accent, accent_emit=None, strength=1.6, metal_accent=0.45):
    stone = make_mat("stone", (0.23, 0.24, 0.26), 0.82, 0.28)
    dark = make_mat("dark", (0.12, 0.12, 0.13), 0.9, 0.12)
    steel = make_mat("steel", (0.55, 0.58, 0.62), 0.38, 0.72)
    cloth = make_mat("cloth", (0.10, 0.095, 0.09), 0.96, 0.0, double=True)
    cloth_dark = make_mat("clothDark", (0.06, 0.055, 0.05), 0.98, 0.0, double=True)
    emit = accent_emit or accent
    hot = make_mat("accent", accent, 0.42, metal_accent, emission=emit, emission_strength=strength)
    return {"stone": stone, "dark": dark, "steel": steel, "cloth": cloth, "clothDark": cloth_dark, "hot": hot}


def add_leg(body, name, shin_name, x, hip, thigh, shin, mat, foot_mat, thick=0.12):
    leg = slot(name, body, x, hip, 0.02)
    cone(name + "Thigh", leg, (0, -thigh / 2, 0), thick, thick * 0.72, thigh, mat, "down", seg=6)
    shin_s = slot(shin_name, leg, 0, -thigh, 0.01)
    cone(name + "Shin", shin_s, (0, -shin / 2, 0.01), thick * 0.7, thick * 0.45, shin, mat, "down", seg=6)
    sphere(name + "Foot", shin_s, (0, -shin + 0.02, 0.08), thick * 0.85, foot_mat, (0.7, 0.45, 1.7), seg=7, ring=5)
    return leg, shin_s


def add_arm(torso, name, x, y, z, upper, lower, mat, hand_mat, thick=0.09):
    arm = slot(name, torso, x, y, z)
    cone(name + "Upper", arm, (0, -upper / 2, 0), thick, thick * 0.78, upper, mat, "down", seg=6)
    cone(name + "Lower", arm, (0, -upper - lower / 2, 0.02), thick * 0.75, thick * 0.55, lower, mat, "down", seg=6)
    sphere(name + "Hand", arm, (0, -upper - lower, 0.05), thick * 0.7, hand_mat, (0.9, 1.05, 0.8), seg=6, ring=5)
    return arm


def biped(hip, hip_x, thigh, shin, torso_y, chest, shoulder, neck, head_r, arm, mats, thick=0.14):
    """返回挂点。chest=(半径, 高度)，shoulder=(半宽, 局部高, 半径)，arm=(上臂, 前臂, 粗)。"""
    body = slot("body", None, 0, 0, 0)
    add_leg(body, "legR", "shinR", hip_x, hip, thigh, shin, mats["dark"], mats["dark"], thick)
    add_leg(body, "legL", "shinL", -hip_x, hip, thigh, shin, mats["dark"], mats["dark"], thick)
    torso = slot("torso", body, 0, torso_y, 0)
    cone("belly", torso, (0, chest[1] * 0.28, 0.04), chest[0] * 0.92, chest[0], chest[1] * 0.55, mats["stone"], seg=7)
    cone("chest", torso, (0, chest[1] * 0.72, 0.02), chest[0], chest[0] * 0.78, chest[1] * 0.5, mats["stone"], seg=7)
    sphere("pauldronR", torso, (shoulder[0], shoulder[1], 0.02), shoulder[2], mats["steel"], (1.15, 0.62, 1.05), seg=7, ring=5)
    sphere("pauldronL", torso, (-shoulder[0], shoulder[1], 0.02), shoulder[2], mats["steel"], (1.15, 0.62, 1.05), seg=7, ring=5)
    head = slot("head", torso, 0, neck, 0.04)
    sphere("skull", head, (0, 0, 0), head_r, mats["dark"], (1.0, 1.12, 0.96), seg=8, ring=6)
    arm_r = add_arm(torso, "armR", shoulder[0] * 0.92, shoulder[1] * 0.72, 0.02, arm[0], arm[1], mats["dark"], mats["stone"], arm[2])
    arm_l = add_arm(torso, "armL", -shoulder[0] * 0.92, shoulder[1] * 0.72, 0.02, arm[0], arm[1], mats["dark"], mats["stone"], arm[2])
    return {"body": body, "torso": torso, "head": head, "armR": arm_r, "armL": arm_l}


def eyes(head, y, z, gap, mat, w=0.045, h=0.028):
    box("eyeL", head, (-gap, y, z), (w, h, 0.02), mat)
    box("eyeR", head, (gap, y, z), (w, h, 0.02), mat)


def sword(parent, center, length, width, mat, guard_mat, names, aim="down", brot=None, grip=0.22):
    """细长剑。护手在柄端，尖在另一端。names = (hilt, tip)。"""
    root = empty("weapon" if names[0] == "weapon-hilt" else "weapon2")
    local = Matrix.Translation(Vector(bpos(*center)))
    root.matrix_world = parent.matrix_world @ local
    parent_keep(root, parent)
    rot = AIM[aim] if brot is None else brot
    # 刃的中心沿瞄准方向离开握点半个刃长。down 时半长在游戏 -Y。
    along = {
        "down": (0, -length / 2, 0),
        "up": (0, length / 2, 0),
        "forward": (0, 0, length / 2),
        "back": (0, 0, -length / 2),
    }[aim]
    cyl("grip", root, (0, -grip / 2, 0) if aim == "down" else (0, grip / 2, 0), width * 0.22, grip, guard_mat, aim, seg=6)
    box("guard", root, (0, -grip, 0) if aim == "down" else (0, grip, 0), (width * 2.4, width * 0.28, width * 0.55), guard_mat)
    blade = cone("blade", root, along, width * 0.55, 0.012, length, mat, aim, seg=4, brot=brot)
    # 刃口一条更窄的强调色，让剑从披风里能认出来
    cone("edge", root, along, width * 0.16, 0.004, length * 0.92, mat, aim, seg=4, brot=brot)
    blade_markers(blade, names[0], names[1], length)
    return root


# ============================================================
# 八个 Boss
# ============================================================
def build_gundyr():
    """重甲骑士。盔顶 4.2，肩 3.6，身体不超过 4.8。戟可以更高。蛇在二阶段才被代码拉出来。"""
    ember = (1.0, 0.549, 0.227)  # COLORS.ember 0xff8c3a
    m = palette((0.45, 0.16, 0.06), ember, 1.8, 0.35)
    m["ember"] = make_mat("gundyr-ember", (0.28, 0.12, 0.05), 0.5, 0.2, emission=ember, emission_strength=1.4)
    # 髋 2.05，大腿 1.02 + 小腿 0.98，脚贴地。肩甲顶单独抬到 3.6，盔顶 4.2。
    rig = biped(
        hip=2.05, hip_x=0.48, thigh=1.02, shin=0.98,
        torso_y=2.08,
        chest=(0.62, 1.15),
        shoulder=(0.98, 1.28, 0.34),
        neck=1.72, head_r=0.34,
        arm=(0.72, 0.62, 0.16),
        mats=m, thick=0.22,
    )
    torso, head, arm_r = rig["torso"], rig["head"], rig["armR"]
    sphere("helm", head, (0, 0.04, 0.02), 0.40, m["steel"], (1.08, 1.05, 1.02), seg=8, ring=6)
    box("visor", head, (0, 0.02, 0.36), (0.46, 0.07, 0.06), m["dark"])
    eyes(head, 0.02, 0.40, 0.12, m["ember"], 0.09, 0.035)
    cone("crest", head, (0, 0.36, -0.02), 0.06, 0.01, 0.28, m["steel"], seg=4)
    # 肩甲再加一圈，顶面压到 3.6（躯干 2.08 + 局部 1.52）
    sphere("pauldronCapR", torso, (1.05, 1.48, 0.04), 0.22, m["steel"], (1.3, 0.55, 1.1), seg=6, ring=4)
    sphere("pauldronCapL", torso, (-1.05, 1.48, 0.04), 0.22, m["steel"], (1.3, 0.55, 1.1), seg=6, ring=4)
    torus("belt", torso, (0, 0.08, 0.02), 0.58, 0.045, m["dark"], seg=8)
    # 胸口螺旋剑：拔出前嵌着，代码在唤醒时关掉
    coil = empty("swordInChest")
    coil.matrix_world = torso.matrix_world @ Matrix.Translation(Vector(bpos(0.12, 0.7, 0.42)))
    parent_keep(coil, torso)
    for i in range(5):
        k = i / 4
        ang = -0.7 + k * math.pi * 1.7
        box(f"coil{i}", coil, (math.cos(ang) * 0.16, -0.28 + k * 0.62, math.sin(ang) * 0.16),
            (0.36, 0.08, 0.05), m["ember"], brot=(0, math.degrees(ang), 0))
    # 戟：从右手向前上方伸出，尖可以高过盔
    weapon = empty("weapon")
    weapon.matrix_world = arm_r.matrix_world @ Matrix.Translation(Vector(bpos(0.05, -1.28, 0.12)))
    parent_keep(weapon, arm_r)
    shaft_len = 3.15
    shaft = cyl("haft", weapon, (0, shaft_len * 0.15, 0.15), 0.07, shaft_len, m["dark"], brot=(78, 0, 8), seg=6)
    cone("spike", weapon, (0.15, 1.85, 0.55), 0.11, 0.012, 0.85, m["steel"], brot=(78, 0, 8), seg=5)
    box("axeHead", weapon, (0.35, 1.35, 0.42), (0.95, 0.12, 0.42), m["steel"], brot=(78, 0, 8))
    cone("edge", weapon, (0.35, 1.42, 0.55), 0.02, 0.004, 0.9, m["ember"], brot=(0, 90, 78), seg=4)
    marker("weapon-hilt", shaft, (0, 0, -shaft_len / 2))
    marker("weapon-tip", shaft, (0, 0, shaft_len / 2 + 0.7))
    # 蛇：腹、颈、头、下巴。静止贴在背后，代码二阶段才把它拉到身前。
    specs = [
        (0.34, 0.22, 0.30, 1.25, 1.15),
        (0.36, 0.30, 0.40, 1.45, 1.35),
        (0.36, 0.36, 0.46, 1.30, 1.25),
        (0.34, 0.28, 0.36, 1.05, 0.95),
        (0.32, 0.18, 0.24, 0.85, 0.7),
        (0.30, 0.12, 0.16, 0.7, 0.58),
        (0.28, 0.10, 0.13, 0.65, 0.55),
    ]
    for i, (length, r0, r1, wide, tall) in enumerate(specs):
        forward_segment(f"serpent{i:02d}", torso, length, r0, r1, m["stone"], wide, tall)
    head_seg = forward_segment("serpent07", torso, 0.36, 0.16, 0.20, m["stone"], 1.15, 0.85)
    cone("snout", head_seg, (0, -0.02, 0.32), 0.10, 0.02, 0.42, m["dark"], "forward", seg=5)
    box("chin", head_seg, (0, -0.22, 0.12), (0.28, 0.16, 0.32), m["stone"])
    box("maw", head_seg, (0, -0.08, 0.16), (0.16, 0.05, 0.22), m["ember"])
    marker("tail-hilt", bpy.data.objects["serpent00"], (0, 0, 0))
    marker("tail-tip", head_seg, (0, -0.16, 0))
    require_markers("weapon-hilt", "weapon-tip", "tail-hilt", "tail-tip")
    check_height(
        "gundyr", 0.08,
        ("helm", 4.20, 0.12),
        4.80,
        extra=(("pauldronCapR", 3.60, 0.15),),
    )


def build_vordt():
    """四足。肩甲 3.8，盔顶 4.5，角尖 5.2，不超过 5.5。"""
    ice_c = (0.624, 0.847, 0.910)   # 0x9fd8e8
    ice_e = (0.373, 0.725, 0.839)   # 0x5fb9d6
    m = palette(ice_c, ice_e, 0.7, 0.15)
    m["ice"] = make_mat("vordt-ice", ice_c, 0.28, 0.1, emission=ice_e, emission_strength=0.8, alpha=0.82)
    m["eye"] = make_mat("vordt-eye", (0.05, 0.07, 0.09), 0.4, 0.0, emission=ice_c, emission_strength=1.1)
    body = slot("body", None, 0, 0, 0)
    # 后肢
    for name, x in (("legR", 0.72), ("legL", -0.72)):
        leg = slot(name, body, x, 1.85, -1.15)
        cone(name + "Thigh", leg, (0, -0.55, 0.15), 0.38, 0.28, 1.15, m["dark"], "down", seg=6)
        cone(name + "Shin", leg, (0, -1.35, -0.05), 0.26, 0.18, 1.05, m["stone"], "down", seg=6)
        sphere(name + "Paw", leg, (0, -1.82, 0.15), 0.22, m["dark"], (1.1, 0.45, 1.6), seg=6, ring=4)
    torso = slot("torso", body, 0, 2.15, -0.15)
    sphere("ribcage", torso, (0, 0.15, 0.15), 0.72, m["stone"], (1.35, 0.85, 1.7), seg=8, ring=6)
    sphere("pelvis", torso, (0, -0.15, -0.85), 0.48, m["dark"], (1.2, 0.75, 1.15), seg=7, ring=5)
    cone("spine", torso, (0, 0.55, -0.15), 0.42, 0.22, 0.7, m["steel"], seg=6)
    # 肩甲圆盘，顶 3.8 = 躯干 2.15 + 1.65
    for name, x in (("pauldronR", 0.95), ("pauldronL", -0.95)):
        cyl(name, torso, (x, 1.18, 0.25), 0.46, 0.55, m["steel"], "right" if x > 0 else "left", seg=8)
        cone("iceSpike" + name[-1], torso, (x, 1.42, 0.15), 0.10, 0.02, 0.36, m["ice"], "up", seg=4)
    # 盔
    head = slot("headG", torso, 0, 1.78, 1.35)
    sphere("helm", head, (0, 0.15, 0.05), 0.48, m["steel"], (1.05, 0.92, 1.12), seg=8, ring=6)
    cone("snout", head, (0, -0.08, 0.55), 0.20, 0.08, 0.62, m["dark"], "forward", seg=6)
    box("jaw", head, (0, -0.28, 0.42), (0.28, 0.16, 0.40), m["stone"])
    eyes(head, 0.08, 0.42, 0.16, m["eye"], 0.10, 0.05)
    # 一对角：一侧扬起，一侧后钩。扬起的那根尖到 5.2
    cone("hornR", head, (0.18, 0.78, 0.02), 0.12, 0.015, 1.15, m["steel"], brot=(-12, 8, -14), seg=5)
    cone("hornL", head, (-0.16, 0.42, -0.25), 0.11, 0.018, 0.72, m["steel"], brot=(48, -8, 20), seg=5)
    # 脊上冰晶
    for i, (z, h) in enumerate(((-0.15, 0.55), (0.15, 0.42), (0.45, 0.34))):
        cone(f"ridge{i}", torso, (0.05 if i % 2 else -0.05, 0.85, z), 0.08, 0.015, h, m["ice"], brot=(55, 0, 0), seg=4)
    # 前肢 + 锤。锤是单独的挂点，代码用 halPitch 压它。
    arm_r = slot("armR", torso, 0.85, 0.25, 1.15)
    cone("armRUpper", arm_r, (0, -0.55, 0.05), 0.32, 0.24, 1.15, m["stone"], "down", seg=6)
    cone("armRLower", arm_r, (0, -1.45, 0.18), 0.22, 0.18, 1.05, m["dark"], "down", seg=6)
    sphere("armRPaw", arm_r, (0, -1.95, 0.35), 0.24, m["steel"], (1.15, 0.7, 1.3), seg=6, ring=4)
    hammer = slot("hammer", arm_r, 0, -1.85, 0.45)
    shaft = cyl("haft", hammer, (0, 0.05, 0.85), 0.09, 1.7, m["dark"], "forward", seg=6)
    box("hammerHead", hammer, (0, 0.15, 1.85), (1.15, 0.78, 0.72), m["steel"])
    box("hammerFace", hammer, (0, 0.15, 2.22), (1.28, 0.22, 0.16), m["stone"])
    marker("weapon-hilt", shaft, (0, 0, -0.85))
    marker("weapon-tip", bpy.data.objects["hammerFace"], (0, 0, 0.08))
    for i, pos in enumerate(((0.35, 0.62, 1.7), (0, 0.7, 1.95), (-0.32, 0.58, 2.05))):
        sphere(f"ice{i}", hammer, pos, 0.16 + (i % 2) * 0.04, m["ice"], (1, 1.2, 1), seg=5, ring=4)
    arm_l = slot("armL", torso, -0.85, 0.25, 1.15)
    cone("armLUpper", arm_l, (0, -0.55, 0.05), 0.32, 0.24, 1.15, m["stone"], "down", seg=6)
    cone("armLLower", arm_l, (0, -1.45, 0.15), 0.22, 0.18, 1.05, m["dark"], "down", seg=6)
    sphere("armLPaw", arm_l, (0, -1.95, 0.32), 0.26, m["dark"], (1.2, 0.65, 1.45), seg=6, ring=4)
    box("tail", body, (0, 1.15, -1.85), (0.22, 0.18, 0.7), m["dark"])
    require_markers("weapon-hilt", "weapon-tip")
    check_height(
        "vordt", 0.12,
        ("helm", 4.50, 0.15),
        5.50,
        extra=(("pauldronR", 3.80, 0.18), ("hornR", 5.20, 0.18)),
    )


def build_watchers():
    """瘦长剑士。盔顶 2.15，兜帽尖 2.30，不超过 2.5。大剑 + 短匕，破斗篷。"""
    fire = (1.0, 0.353, 0.125)  # 0xff5a20
    m = palette((0.16, 0.17, 0.19), fire, 0.0, 0.4)
    m["blade"] = make_mat("watcher-blade", (0.60, 0.64, 0.68), 0.35, 0.7, emission=fire, emission_strength=0.15)
    m["eye"] = make_mat("watcher-eye", (0.10, 0.02, 0.02), 0.55, 0.0, emission=(1.0, 0.23, 0.19), emission_strength=1.2)
    rig = biped(
        hip=1.08, hip_x=0.13, thigh=0.54, shin=0.50,
        torso_y=1.10,
        chest=(0.20, 0.62),
        shoulder=(0.28, 0.58, 0.10),
        neck=0.87, head_r=0.13,
        arm=(0.32, 0.30, 0.055),
        mats=m, thick=0.075,
    )
    head, torso, arm_r, arm_l = rig["head"], rig["torso"], rig["armR"], rig["armL"]
    sphere("helm", head, (0, 0.02, 0.01), 0.145, m["steel"], (1.02, 1.08, 1.05), seg=7, ring=5)
    box("slit", head, (0, 0.01, 0.14), (0.16, 0.035, 0.02), m["dark"])
    eyes(head, 0.01, 0.155, 0.045, m["eye"], 0.04, 0.02)
    cone("hood", head, (0, 0.17, -0.06), 0.16, 0.012, 0.38, m["clothDark"], brot=(-28, 0, 0), seg=5)
    hanging_skirt("tasset", rig["body"], 1.05, 0.16, 0.22, 0.42, m["clothDark"], gap=1.2, cols=6)
    rag("cape0", torso, (-0.08, 0.42, -0.16), 0.12, 0.55, m["cloth"])
    rag("cape1", torso, (0.06, 0.40, -0.15), 0.10, 0.42, m["cloth"])
    # 一条破斗篷贴背，不进摆动数组（摆动的是两片短布）
    mesh_local(
        "cloak", torso, (0, 0.5, -0.12),
        [(-0.16, 0.05, 0.02), (0, 0.08, -0.02), (0.10, 0.04, 0.02),
         (-0.18, -0.55, -0.12), (0, -0.62, -0.2), (0.08, -0.5, -0.1),
         (-0.12, -1.05, -0.28), (0.02, -1.15, -0.36), (0.06, -0.9, -0.22)],
        [(0, 1, 4, 3), (1, 2, 5, 4), (3, 4, 7, 6), (4, 5, 8, 7)],
        m["cloth"],
    )
    sword(arm_r, (0.02, -0.64, 0.06), 1.35, 0.09, m["blade"], m["steel"], ("weapon-hilt", "weapon-tip"))
    sword(arm_l, (-0.02, -0.62, 0.05), 0.48, 0.045, m["blade"], m["dark"], ("weapon2-hilt", "weapon2-tip"))
    require_markers("weapon-hilt", "weapon-tip", "weapon2-hilt", "weapon2-tip")
    check_height(
        "watchers", 0.08,
        ("helm", 2.15, 0.08),
        2.50,
        extra=(("hood", 2.30, 0.08),),
    )


def build_sulyvahn():
    """高瘦术士。脚到头 2.8，冠尖 3.1，不超过 3.3。右火剑，左暗紫剑。"""
    fire = (1.0, 0.353, 0.125)       # 0xff5a20
    dark_f = (0.478, 0.302, 0.620)   # 0x7a4d9e
    m = palette((0.14, 0.12, 0.18), fire, 0.0, 0.2)
    m["fire"] = make_mat("sul-fire", fire, 0.46, 0.22, emission=fire, emission_strength=0.2)
    m["darkflame"] = make_mat("sul-dark", dark_f, 0.5, 0.22, emission=dark_f, emission_strength=0.2)
    m["eye"] = make_mat("sul-eye", (0.04, 0.03, 0.06), 0.5, 0.0, emission=(0.45, 0.3, 0.7), emission_strength=1.3)
    m["gold"] = make_mat("sul-gold", (0.90, 0.76, 0.48), 0.4, 0.6)
    rig = biped(
        hip=1.48, hip_x=0.09, thigh=0.74, shin=0.70,
        torso_y=1.52,
        chest=(0.16, 0.7),
        shoulder=(0.22, 0.64, 0.07),
        neck=1.19, head_r=0.11,
        arm=(0.36, 0.34, 0.045),
        mats=m, thick=0.055,
    )
    head, torso = rig["head"], rig["torso"]
    sphere("face", head, (0, -0.02, 0.02), 0.10, m["clothDark"], (0.9, 1.15, 0.85), seg=6, ring=5)
    eyes(head, 0.0, 0.11, 0.04, m["eye"], 0.028, 0.018)
    # 两只眼睛都叫 sulEye 前缀，分身克隆时留着眼的材质
    bpy.data.objects["eyeL"].name = "sulEye"
    bpy.data.objects["eyeR"].name = "sulEye2"
    cone("crown", head, (0, 0.16, 0), 0.13, 0.015, 0.48, m["cloth"], seg=4)
    torus("crownBand", head, (0, 0.08, 0), 0.12, 0.018, m["gold"], seg=6)
    box("crownWingL", head, (-0.10, 0.22, 0), (0.025, 0.22, 0.08), m["clothDark"], brot=(0, 0, 18))
    box("crownWingR", head, (0.10, 0.22, 0), (0.025, 0.22, 0.08), m["clothDark"], brot=(0, 0, -18))
    hanging_skirt("skirt0", rig["body"], 1.55, 0.14, 0.26, 1.35, m["clothDark"], gap=0.7, cols=8)
    hanging_skirt("skirt1", rig["body"], 1.58, 0.16, 0.36, 1.48, m["cloth"], gap=0.95, cols=8)
    torus("belt", torso, (0, 0.06, 0.02), 0.16, 0.02, m["steel"], seg=7)
    box("medal", torso, (0, 0.28, 0.16), (0.08, 0.08, 0.02), m["gold"], brot=(0, 0, 45))
    sword(rig["armR"], (0.02, -0.72, 0.05), 1.85, 0.055, m["fire"], m["gold"], ("weapon-hilt", "weapon-tip"))
    sword(rig["armL"], (-0.02, -0.72, 0.05), 1.85, 0.055, m["darkflame"], m["gold"], ("weapon2-hilt", "weapon2-tip"))
    require_markers("weapon-hilt", "weapon-tip", "weapon2-hilt", "weapon2-tip")
    check_height(
        "sulyvahn", 0.08,
        ("face", 2.80, 0.12),
        3.30,
        extra=(("crown", 3.10, 0.10),),
    )


def build_margit():
    """恶兆。脚到头 3.4，角或斗篷最高 3.8，不超过 4。咒杖、袖刃、尾，金锤和咒剑先藏着。
    挂点位置 = boss-margit.ts 的组常量（手臂在躯干局部 y1.42 的肩窝上，头前探 z0.34）。"""
    gold = (0.847, 0.706, 0.416)  # 0xd8b46a
    m = palette(gold, gold, 0.9, 0.35)
    m["gold"] = make_mat("margit-gold", gold, 0.4, 0.45, emission=gold, emission_strength=0.45)
    m["eye"] = make_mat("margit-eye", (0.07, 0.05, 0.02), 0.5, 0.0, emission=gold, emission_strength=1.2)
    m["hammer"] = make_mat("margit-hammer", (0.80, 0.70, 0.47), 0.35, 0.5, emission=gold, emission_strength=0.15, alpha=0.9)
    m["sword"] = make_mat("margit-sword", (0.84, 0.74, 0.51), 0.32, 0.55, emission=gold, emission_strength=0.15, alpha=0.9)
    m["skin"] = make_mat("skin", (0.541, 0.490, 0.420), 0.95, 0.02)
    m["skinDark"] = make_mat("skinDark", (0.420, 0.376, 0.325), 1.0, 0.0)
    m["robe"] = make_mat("robe", (0.216, 0.200, 0.176), 1.0, 0.0, double=True)
    m["robeDark"] = make_mat("robeDark", (0.157, 0.145, 0.122), 1.0, 0.0, double=True)
    m["wood"] = make_mat("wood", (0.290, 0.239, 0.173), 0.9, 0.0)
    m["steel"] = make_mat("steel", (0.337, 0.361, 0.400), 0.5, 0.5)

    body = slot("body", None, 0, 0, 0)
    # 髋 1.58，膝 -0.76
    for name, shin_name, x in (("legR", "shinR", 0.17), ("legL", "shinL", -0.17)):
        leg = slot(name, body, x, 1.58, 0)
        cone(name + "Thigh", leg, (0, -0.38, 0), 0.074, 0.125, 0.76, m["skinDark"], "up", seg=6)
        shin = slot(shin_name, leg, 0, -0.76, 0)
        cone(shin_name + "Calf", shin, (0, -0.38, 0.012), 0.042, 0.072, 0.76, m["skinDark"], "up", seg=6)
        sphere(shin_name + "Foot", shin, (0, -0.789, 0.07), 0.07, m["skinDark"], (0.85, 0.45, 1.75), seg=6, ring=4)
    cone("waist", body, (0, 1.54, 0), 0.15, 0.175, 0.24, m["skinDark"], "up", seg=7)
    cone("waistBand", body, (0, 1.42, 0), 0.215, 0.215, 0.055, m["robeDark"], "up", seg=7)
    box("knot", body, (0.15, 1.36, 0.16), (0.055, 0.12, 0.04), m["robeDark"])
    # 四层下摆 + 六条破布（updateVisuals 按名字摆动）
    robes = [
        ("robe0", 0.24, 0.32, 0.28, 1.26, m["robe"]),
        ("robe1", 0.30, 0.40, 0.26, 1.00, m["robe"]),
        ("robe2", 0.36, 0.48, 0.26, 0.74, m["robeDark"]),
        ("robe3", 0.42, 0.54, 0.24, 0.50, m["robeDark"]),
    ]
    for nm, rt, rb, h, y, mat in robes:
        cone(nm, body, (0, y, 0.02), rb, rt, h, mat, "up", seg=8)
    for i in range(6):
        a = (i / 6) * math.tau + 0.4
        box(f"rag{i}", body, (math.sin(a) * 0.50, 0.30, math.cos(a) * 0.38),
            (0.07, 0.30 + (i % 3) * 0.08, 0.022), m["robeDark"], brot=(0, math.degrees(a), 0))
    # 尾：从 z0 伸到 -1.02，尾根尾尖钉在两端
    tail = slot("tail", body, 0, 1.44, -0.2)
    cone("tailRoot", tail, (0, 0.02, -0.15), 0.09, 0.11, 0.30, m["skinDark"], "back", seg=5)
    cone("tailLink", tail, (0, -0.02, -0.34), 0.035, 0.045, 0.14, m["skinDark"], "back", seg=5)
    cone("tailMid", tail, (0, -0.08, -0.54), 0.065, 0.08, 0.26, m["skinDark"], "back", seg=5)
    cone("tailLink2", tail, (0, -0.13, -0.70), 0.026, 0.034, 0.12, m["skinDark"], "back", seg=5)
    cone("tailEnd", tail, (0, -0.17, -0.84), 0.04, 0.055, 0.16, m["skinDark"], "back", seg=5)
    cone("tailPoint", tail, (0, -0.26, -1.02), 0.055, 0, 0.28, m["skinDark"], brot=(-126, 0, 0), seg=4)
    marker("tail-hilt", tail, bpos(0, 0.02, 0.15))
    marker("tail-tip", tail, bpos(0, -0.12, -1.05))

    # 躯干：腰最窄，肩梁在 1.72，头从肩窝前面伸出来
    torso = slot("torso", body, 0, 1.64, 0)
    sphere("gut", torso, (0, 0.12, 0.04), 0.16, m["skinDark"], (1.05, 0.9, 0.72), seg=6, ring=5)
    sphere("chest", torso, (0, 0.50, 0.06), 0.26, m["robe"], (1.28, 1.05, 1.08), seg=7, ring=5)
    sphere("mBack", torso, (0, 0.46, -0.22), 0.15, m["skinDark"], (0.8, 1.35, 0.62), seg=6, ring=4)
    cyl("laceR", torso, (0.07, 0.36, 0.24), 0.012, 0.38, m["robeDark"], seg=5)
    cyl("laceL", torso, (-0.07, 0.36, 0.24), 0.012, 0.38, m["robeDark"], seg=5)
    box("clasp", torso, (0, 0.16, 0.24), (0.055, 0.08, 0.03), m["skinDark"])
    cyl("yoke", torso, (0, 1.72, -0.06), 0.1, 1.28, m["robeDark"], brot=(0, 0, 90), seg=6)
    sphere("deltR", torso, (0.54, 1.58, -0.02), 0.2, m["robeDark"], (1.15, 1.0, 0.95), seg=6, ring=4)
    sphere("deltL", torso, (-0.54, 1.58, -0.02), 0.2, m["robeDark"], (1.15, 1.0, 0.95), seg=6, ring=4)
    cone("cowlR", torso, (0.34, 1.70, -0.08), 0.02, 0.11, 0.72, m["robe"], brot=(-20.1, 0, -16.0), seg=5)
    cone("cowlL", torso, (-0.34, 1.70, -0.08), 0.02, 0.11, 0.72, m["robe"], brot=(-20.1, 0, 16.0), seg=5)
    cone("hood", torso, (0, 1.70, -0.18), 0.04, 0.18, 0.62, m["robeDark"], brot=(24.1, 0, 0), seg=5)
    cone("mNeck", torso, (0, 1.30, 0.22), 0.075, 0.095, 0.18, m["skin"], "up", seg=6)
    cone("cloakCollar", torso, (0, 1.85, -0.12), 0.28, 0.04, 0.55, m["robeDark"], brot=(-20, 0, 0), seg=6)

    # 颅顶 3.40。角从肩窝里往后掠
    head = slot("head", torso, 0, 1.515, 0.34)
    sphere("skull", head, (0, 0.04, 0), 0.16, m["skin"], (0.98, 1.28, 1.08), seg=7, ring=5)
    sphere("jaw", head, (0, -0.10, 0.045), 0.10, m["skinDark"], (0.9, 0.6, 1.02), seg=5, ring=4)
    box("brow", head, (0, 0.10, 0.145), (0.17, 0.04, 0.04), m["skinDark"])
    sphere("eyeR", head, (0.05, 0.06, 0.158), 0.024, m["eye"], (0.83, 0.54, 0.67), seg=5, ring=4)
    sphere("eyeL", head, (-0.05, 0.06, 0.158), 0.024, m["eye"], (0.83, 0.54, 0.67), seg=5, ring=4)
    box("mark", head, (0, 0.16, 0.155), (0.048, 0.062, 0.016), m["gold"], brot=(0, 0, 45))
    for s in (1, -1):
        cone(f"hornA{'R' if s > 0 else 'L'}", head, (s * 0.07, 0.26, -0.02), 0.018, 0.038, 0.34, m["skinDark"],
             brot=(-27.5, 0, -s * 22.9), seg=5)
        cone(f"hornB{'R' if s > 0 else 'L'}", head, (s * 0.15, 0.525, -0.13), 0.01, 0.022, 0.40, m["skinDark"],
             brot=(-54.4, 0, -s * 31.5), seg=5)

    # 右臂从肩窝垂下；咒杖握在手里
    arm_r = slot("armR", torso, 0.34, 1.42, 0)
    cone("armRUpper", arm_r, (0, -0.26, 0), 0.072, 0.115, 0.52, m["skinDark"], "up", seg=6)
    cone("armRLower", arm_r, (0, -0.64, 0.02), 0.042, 0.07, 0.46, m["skin"], "up", seg=6)
    sphere("armRHand", arm_r, (0, -0.90, 0.04), 0.055, m["skinDark"], (1.05, 0.75, 0.9), seg=5, ring=4)

    staff = empty("weapon")
    local = Matrix.Translation(Vector(bpos(0, -0.98, 0.06)))
    R = game_rotation(0.16, 0, 0)
    staff.matrix_world = arm_r.matrix_world @ (local @ R)
    parent_keep(staff, arm_r)
    box("staffWrap", staff, (0, 0.02, 0), (0.08, 0.2, 0.08), m["robeDark"])
    cone("staffShaft", staff, (0, -0.36, 0), 0.05, 0.068, 2.05, m["wood"], "up", seg=6)
    box("staffKnot", staff, (0.012, -0.02, 0.03), (0.1, 0.11, 0.1), m["wood"])
    box("staffRuneA", staff, (0, 0.20, 0), (0.12, 0.05, 0.12), m["gold"])
    box("staffRuneB", staff, (0, 0.44, 0), (0.12, 0.05, 0.12), m["gold"])
    box("staffNeck", staff, (0, 0.78, 0), (0.18, 0.26, 0.18), m["wood"])
    box("staffBand", staff, (0, 0.86, 0), (0.22, 0.07, 0.22), m["gold"])
    box("staffForkRoot", staff, (0, 0.96, 0), (0.26, 0.16, 0.18), m["wood"])
    box("staffForkR", staff, (0.2, 1.15, 0.02), (0.16, 0.52, 0.16), m["wood"], brot=(0, 0, -37.2))
    box("staffForkRCap", staff, (0.37, 1.38, 0.02), (0.11, 0.12, 0.11), m["gold"], brot=(0, 0, -37.2))
    box("staffForkL", staff, (-0.17, 1.10, -0.02), (0.15, 0.44, 0.15), m["wood"], brot=(0, 0, 41.3))
    box("staffForkLRing", staff, (-0.29, 1.32, -0.02), (0.1, 0.1, 0.1), m["gold"], brot=(0, 0, 41.3))
    marker("weapon-hilt", staff, bpos(0, -1.025, 0))
    marker("weapon-tip", staff, bpos(0.36, 1.42, 0.02))

    # 召唤金锤：短木柄 + 厚方头（开局隐藏，hammerShow 渐显）
    hammer = slot("hammer", arm_r, 0, -1.02, 0.16)
    box("hammerHandle", hammer, (0, -0.15, 0), (0.09, 0.6, 0.09), m["wood"])
    box("hammerNeck", hammer, (0, 0.08, 0), (0.22, 0.12, 0.22), m["hammer"])
    box("hammerHead", hammer, (0, 0.30, 0), (0.62, 0.52, 0.58), m["hammer"])
    box("hammerFace", hammer, (0, 0.58, 0), (0.78, 0.14, 0.70), m["hammer"])
    marker("hammer-hilt", hammer, bpos(0, -0.30, 0))
    marker("hammer-tip", hammer, bpos(0, 0.65, 0))

    # 左臂 + 袖刃 + 召唤金剑
    arm_l = slot("armL", torso, -0.34, 1.42, 0)
    cone("armLUpper", arm_l, (0, -0.24, 0), 0.07, 0.11, 0.48, m["skinDark"], "up", seg=6)
    cone("armLLower", arm_l, (0, -0.60, 0.02), 0.04, 0.068, 0.44, m["skin"], "up", seg=6)
    sphere("armLHand", arm_l, (0, -0.85, 0.04), 0.05, m["skinDark"], (1.0, 0.7, 0.85), seg=5, ring=4)
    for i, fx in enumerate((-0.03, 0, 0.03)):
        cone(f"armLClaw{i}", arm_l, (fx, -0.95, 0.06), 0, 0.012, 0.14, m["skinDark"],
             brot=(180 + math.degrees(0.5) + i * math.degrees(0.12), 0, 0), seg=4)

    sleeve = empty("weapon2")
    local = Matrix.Translation(Vector(bpos(0, -0.75, 0.10)))
    R = game_rotation(0.35, 0, 0)
    sleeve.matrix_world = arm_l.matrix_world @ (local @ R)
    parent_keep(sleeve, arm_l)
    box("sleeveGrip", sleeve, (0, 0.115, 0), (0.05, 0.13, 0.046), m["wood"])
    box("sleeveGuard", sleeve, (0, 0.035, 0), (0.11, 0.032, 0.06), m["steel"])
    box("sleeveBlade", sleeve, (0, -0.055, 0), (0.028, 0.18, 0.014), m["steel"])
    cone("sleevePoint", sleeve, (0, -0.19, 0), 0, 0.02, 0.10, m["steel"], "down", seg=4)
    marker("weapon2-hilt", sleeve, bpos(0, 0.05, 0))
    marker("weapon2-tip", sleeve, bpos(0, -0.24, 0))

    sword = empty("sword")
    local = Matrix.Translation(Vector(bpos(0, -0.92, 0.08)))
    R = game_rotation(0.2, 0, 0)
    sword.matrix_world = arm_l.matrix_world @ (local @ R)
    parent_keep(sword, arm_l)
    box("swordGrip", sword, (0, 0, 0), (0.062, 0.26, 0.062), m["robeDark"])
    box("swordGuardA", sword, (0, -0.06, 0), (0.08, 0.028, 0.08), m["sword"])
    box("swordGuardB", sword, (0, 0.04, 0), (0.08, 0.028, 0.08), m["sword"])
    box("swordPommel", sword, (0, 0.16, 0), (0.11, 0.10, 0.11), m["sword"])
    box("swordQuillonR", sword, (0.24, -0.22, 0), (0.07, 0.16, 0.07), m["sword"], brot=(0, 0, -40.1))
    box("swordQuillonL", sword, (-0.24, -0.22, 0), (0.07, 0.16, 0.07), m["sword"], brot=(0, 0, 40.1))
    box("swordGuard", sword, (0, -0.16, 0), (0.52, 0.08, 0.10), m["sword"])
    box("swordHub", sword, (0, -0.16, 0), (0.14, 0.12, 0.12), m["sword"])
    box("swordRoot", sword, (0, -0.34, 0), (0.10, 0.28, 0.046), m["sword"])
    box("swordSpine", sword, (0, -0.80, 0), (0.05, 0.78, 0.042), m["sword"])
    box("swordEdge", sword, (0, -0.78, 0), (0.095, 0.70, 0.02), m["sword"])
    box("swordTaper", sword, (0, -1.26, 0), (0.05, 0.24, 0.03), m["sword"])
    cone("swordPoint", sword, (0, -1.46, 0), 0, 0.028, 0.22, m["sword"], "down", seg=4)
    marker("sword-hilt", sword, bpos(0, 0.21, 0))
    marker("sword-tip", sword, bpos(0, -1.35, 0))

    require_markers(
        "weapon-hilt", "weapon-tip", "weapon2-hilt", "weapon2-tip",
        "tail-hilt", "tail-tip", "hammer-hilt", "hammer-tip", "sword-hilt", "sword-tip",
    )
    check_height(
        "margit", 0.08,
        ("skull", 3.40, 0.15),
        4.00,
        extra=(("hornB", 3.80, 0.18), ("cloakCollar", 3.80, 0.20)),
    )


def build_godrick():
    """脚到头 3.6，肩 4.3，最高的手臂 5.6。巨斧、接肢爪，二阶段龙头另挂。
    挂点位置 = boss-godrick.ts 的组常量 × k(1.1526)，姿态代码不改就能挂。"""
    gold = (0.690, 0.553, 0.271)     # 0xb08d45
    gold_t = (0.839, 0.698, 0.420)   # 0xd6b26b
    rot = (0.361, 0.420, 0.290)      # 0x5c6b4a
    rot_d = (0.271, 0.322, 0.227)    # 0x45523a
    flame = (1.0, 0.478, 0.165)      # 0xff7a2a
    k = 3.6 / 3.123
    m = palette(gold, gold_t, 0.4, 0.5)
    m["gold"] = make_mat("godrick-gold", gold, 0.48, 0.5)
    m["goldHot"] = make_mat("godrick-trim", gold_t, 0.4, 0.55, emission=gold_t, emission_strength=0.35)
    m["flesh"] = make_mat("godrick-flesh", rot, 0.95, 0.0)
    m["fleshDark"] = make_mat("godrick-fleshDark", rot_d, 1.0, 0.0)
    m["eye"] = make_mat("godrick-eye", (0.08, 0.06, 0.03), 0.5, 0.0, emission=gold_t, emission_strength=1.1)
    m["flame"] = make_mat("godrick-flame", flame, 0.4, 0.0, emission=flame, emission_strength=0.2, alpha=0.9)
    m["dragon"] = make_mat("godrick-dragon", (0.416, 0.439, 0.349), 0.8, 0.1)
    m["hair"] = make_mat("godrick-hair", (0.788, 0.647, 0.361), 0.85, 0.0)
    m["iron"] = make_mat("iron", (0.239, 0.255, 0.282), 0.45, 0.6)
    m["ironDark"] = make_mat("ironDark", (0.173, 0.184, 0.208), 0.5, 0.5)
    m["wood"] = make_mat("wood", (0.227, 0.188, 0.149), 0.95, 0.0)
    m["steel"] = make_mat("steel", (0.439, 0.467, 0.518), 0.45, 0.6)

    body = slot("body", None, 0, 0, 0)
    # 髋 1.48，膝 -0.72，脚底贴地
    for name, shin_name, x in (("legR", "shinR", 0.32), ("legL", "shinL", -0.32)):
        leg = slot(name, body, x, 1.48, 0.02)
        cone(name + "Thigh", leg, (0, -0.36, 0), 0.15, 0.22, 0.70, m["ironDark"], "up", seg=6)
        cyl(name + "Knee", leg, (0, -0.66, 0.03), 0.175, 0.12, m["gold"], seg=6)
        shin = slot(shin_name, leg, 0, -0.72, 0)
        cone(shin_name + "Calf", shin, (0, -0.30, 0.02), 0.09, 0.14, 0.60, m["ironDark"], "up", seg=6)
        cyl(shin_name + "Foot", shin, (0, -0.64, 0.10), 0.09, 0.42, m["iron"], "forward", seg=6)
    cone("pelvis", body, (0, 1.58, 0.02), 0.30, 0.34, 0.28, m["ironDark"], "up", seg=7)
    cone("belt", body, (0, 1.42, 0.04), 0.38, 0.40, 0.07, m["gold"], "up", seg=7)
    box("fauldM", body, (0, 1.22, 0.28), (0.22, 0.36, 0.04), m["iron"], brot=(20.1, 4.6, 0))
    box("fauldR", body, (0.22, 1.22, 0.28), (0.22, 0.36, 0.04), m["iron"], brot=(20.1, 35.5, 0))
    box("fauldL", body, (-0.22, 1.22, 0.28), (0.22, 0.36, 0.04), m["iron"], brot=(20.1, -35.5, 0))

    torso = slot("torso", body, 0, 1.72, 0)
    sphere("belly", torso, (0, 0.02, 0.12), 0.50, m["flesh"], (1.18, 0.78, 1.26), seg=8, ring=6)
    cone("chest", torso, (0, 0.52, -0.02), 0.38, 0.30, 0.44, m["iron"], "up", seg=7)
    cone("breast", torso, (0, 0.78, 0.06), 0.28, 0.22, 0.20, m["gold"], "up", seg=7)
    sphere("back", torso, (0, 0.55, -0.30), 0.30, m["fleshDark"], (1.25, 1.05, 0.72), seg=7, ring=5)
    box("crest", torso, (0, 0.55, 0.40), (0.14, 0.18, 0.04), m["goldHot"])
    cone("gNeck", torso, (0, 1.08, 0.22), 0.11, 0.15, 0.28, m["fleshDark"], brot=(25.8, 0, 0), seg=6)
    marker("gust", torso, bpos(0, 0.55, 0.42))

    # 肩甲高过王冠：左肉右铁
    for side, top, mat in ((-1, 2.612, m["fleshDark"]), (1, 2.46, m["iron"])):
        h = top - 0.62
        cone(f"pauldron{'L' if side < 0 else 'R'}", torso, (side * 0.47, 0.62 + h * 0.46, -0.06),
             0.08, 0.26, h, mat, brot=(0, 0, -side * 11.5), seg=6)
        cone(f"pauldronCap{'L' if side < 0 else 'R'}", torso, (side * 0.50, 0.62 + h * 0.78, -0.03),
             0.04, 0.12, 0.18, m["gold"], brot=(0, 0, -side * 11.5), seg=5)
    cyl("stump", torso, (-0.56, 0.66, 0.02), 0.12, 0.12, m["fleshDark"], seg=6)

    # 头在肩前：冠顶 3.6
    head = slot("head", torso, 0, 1.235, 0.46)
    sphere("skull", head, (0, 0.02, 0), 0.20, m["flesh"], (1.02, 1.18, 1.05), seg=7, ring=5)
    sphere("jaw", head, (0, -0.16, 0.05), 0.12, m["fleshDark"], (1.05, 0.62, 0.95), seg=5, ring=4)
    cyl("brow", head, (0, 0.10, 0.16), 0.11, 0.06, m["fleshDark"], "forward", seg=5)
    sphere("eyeR", head, (0.07, 0.06, 0.20), 0.024, m["eye"], (1.04, 0.6, 0.83), seg=5, ring=4)
    sphere("eyeL", head, (-0.07, 0.06, 0.20), 0.024, m["eye"], (1.04, 0.6, 0.83), seg=5, ring=4)
    cone("hairA", head, (0, 0.02, -0.16), 0.06, 0.14, 0.36, m["hair"], brot=(40.1, 0, 0), seg=5)
    cone("hairB", head, (0.10, -0.02, -0.14), 0.04, 0.09, 0.28, m["hair"], brot=(28.6, 0, 17.2), seg=5)
    cone("hairC", head, (-0.10, -0.04, -0.12), 0.04, 0.08, 0.24, m["hair"], brot=(25.8, 0, -20.1), seg=5)
    cyl("crown", head, (0, 0.28, 0), 0.225, 0.05, m["goldHot"], seg=7)
    cone("crownSpikeM", head, (0, 0.52, 0.01), 0.012, 0.038, 0.44, m["goldHot"], seg=4)
    cone("crownSpikeR", head, (0.12, 0.45, 0.01), 0.012, 0.038, 0.30, m["gold"], seg=4)
    cone("crownSpikeL", head, (-0.12, 0.45, 0.01), 0.012, 0.038, 0.28, m["gold"], seg=4)

    # 右臂 + 月刃巨斧
    arm_r = slot("armR", torso, 0.56, 0.74, 0.04)
    cone("armRUpper", arm_r, (0, -0.24, 0), 0.11, 0.15, 0.46, m["ironDark"], "up", seg=6)
    cone("armRLower", arm_r, (0, -0.62, 0.03), 0.07, 0.11, 0.42, m["flesh"], "up", seg=6)
    cyl("armRWrist", arm_r, (0, -0.88, 0.05), 0.09, 0.16, m["iron"], seg=6)

    axe = empty("weapon")
    local = Matrix.Translation(Vector(bpos(0, -0.98, 0.05)))
    R = game_rotation(0.58, 0, 0)
    axe.matrix_world = arm_r.matrix_world @ (local @ R)
    parent_keep(axe, arm_r)
    haft = 1.7 * k
    hz = haft - 0.08 * k
    cyl("haft", axe, (0, 0, haft * 0.5 - 0.046), 0.068 * k, haft, m["wood"], "forward", seg=6)
    box("axeGuard", axe, (0, 0, -0.16), (0.42 * k, 0.13 * k, 0.14 * k), m["steel"])
    box("axeCollarA", axe, (0, 0, 0.115), (0.11 * k, 0.11 * k, 0.24 * k), m["iron"])
    box("axeCollarB", axe, (0, 0, 0.53 * k), (0.10 * k, 0.10 * k, 0.07 * k), m["goldHot"])
    box("axeCollarC", axe, (0, 0, 1.0 * k), (0.10 * k, 0.10 * k, 0.07 * k), m["goldHot"])
    box("axeCollarD", axe, (0, 0, 1.4 * k), (0.11 * k, 0.11 * k, 0.07 * k), m["goldHot"])
    cyl("axeGuardBar", axe, (0, 0, 0.115), 0.052 * k, 0.36 * k, m["iron"], "right", seg=5)
    cyl("axeNeck", axe, (0.023, 0, hz - 0.046), 0.138 * k, 0.16 * k, m["iron"], "forward", seg=5)
    for i, ang in enumerate((-1.12, -0.74, -0.36, 0, 0.36, 0.74, 1.1)):
        r = 0.52 * k
        box(f"moon{i}", axe, (math.cos(ang) * r, math.sin(ang) * r, hz),
            (0.50 * k, 0.36 * k, 0.24 * k), m["gold"], brot=(0, 0, math.degrees(ang) + 90))
        box(f"moonEdge{i}", axe, (math.cos(ang) * r * 1.42, math.sin(ang) * r * 1.42, hz + 0.023),
            (0.42 * k, 0.08 * k, 0.09 * k), m["goldHot"], brot=(0, 0, math.degrees(ang) + 90))
    box("moonPointA", axe, (math.cos(1.28) * 0.86 * k, math.sin(1.28) * 0.86 * k, hz),
        (0.10 * k, 0.50 * k, 0.07 * k), m["goldHot"], brot=(0, 0, math.degrees(1.28) - 90))
    box("moonPointB", axe, (math.cos(1.28) * 1.12 * k, math.sin(1.28) * 1.12 * k, hz),
        (0.06 * k, 0.22 * k, 0.045 * k), m["goldHot"], brot=(0, 0, math.degrees(1.28) - 90))
    box("moonHook", axe, (math.cos(-1.26) * 0.78 * k, math.sin(-1.26) * 0.78 * k, hz),
        (0.11 * k, 0.42 * k, 0.08 * k), m["gold"], brot=(0, 0, math.degrees(-1.26) - 90))
    box("axeSpike", axe, (-0.25, 0.058, hz), (0.34 * k, 0.09 * k, 0.10 * k), m["steel"], brot=(0, 0, 28.6))
    marker("weapon-hilt", axe, bpos(0, 0, 0.115))
    marker("weapon-tip", axe, bpos(0.95 * k, 0, hz))
    marker("axe-head", axe, bpos(0.62 * k, 0.023 * k, hz))

    # 左臂：P1 接肢巨爪，P2 龙头换装
    arm_l = slot("armL", torso, -0.56, 0.74, 0.02)
    flesh = slot("flesh", arm_l, 0, 0, 0)
    cone("fleshUpper", flesh, (0, -0.26, 0), 0.14, 0.20, 0.50, m["flesh"], "up", seg=6)
    cone("fleshLower", flesh, (0, -0.68, 0.03), 0.09, 0.14, 0.46, m["fleshDark"], "up", seg=6)
    sphere("fleshPalm", flesh, (0, -0.96, 0.06), 0.12, m["flesh"], (1.15, 0.72, 1.05), seg=5, ring=4)
    for i, (fx, tip_y, fz, h) in enumerate(((-0.07, -1.10, 0.16, 0.22), (0, -1.23, 0.24, 0.26), (0.07, -1.08, 0.16, 0.20))):
        cone(f"claw{i}", flesh, (fx, tip_y + h * 0.5, fz), 0.012, 0.030, h, m["fleshDark"], "up", seg=4)
    marker("weapon2-hilt", flesh, bpos(0, 0, 0))
    marker("weapon2-tip", flesh, bpos(0, -1.23, 0.24))

    dragon = slot("dragon", arm_l, 0, 0, 0)
    cone("dNeck", dragon, (0, -0.253, 0), 0.14 * k, 0.20 * k, 0.48 * k, m["dragon"], "up", seg=6)
    sphere("dSkull", dragon, (0, -0.668, 0.184), 0.20 * k, m["dragon"], (1.15, 0.78, 1.05), seg=7, ring=5)
    cyl("dBrow", dragon, (0, -0.553, 0.346), 0.13 * k, 0.10 * k, m["dragon"], "forward", seg=5)
    cyl("snout", dragon, (0, -0.761, 0.898), 0.08 * k, 0.56 * k, m["dragon"], "forward", seg=5)
    box("dEyeR", dragon, (0.138, -0.622, 0.368), (0.07 * k, 0.045 * k, 0.03 * k), m["eye"])
    box("dEyeL", dragon, (-0.138, -0.622, 0.368), (0.07 * k, 0.045 * k, 0.03 * k), m["eye"])
    cone("dHornRBase", dragon, (0.184, -0.484, 0.069), 0.05 * k, 0.08 * k, 0.32 * k, m["dragon"],
         brot=(-24.1, 10.3, -51.6), seg=5)
    cone("dHornRTip", dragon, (0.30, -0.21, 0.10), 0.012 * k, 0.03 * k, 0.30 * k, m["gold"],
         brot=(-24.1, 10.3, -68.9), seg=4)
    cone("dHornLBase", dragon, (-0.184, -0.484, 0.069), 0.05 * k, 0.08 * k, 0.32 * k, m["dragon"],
         brot=(-24.1, -10.3, 51.6), seg=5)
    cone("dHornLTip", dragon, (-0.30, -0.21, 0.10), 0.012 * k, 0.03 * k, 0.30 * k, m["gold"],
         brot=(-24.1, -10.3, 68.9), seg=4)
    cone("dNose", dragon, (0, -0.576, 1.06), 0.015 * k, 0.03 * k, 0.28 * k, m["gold"], brot=(68.8, 0, 0), seg=4)
    for i, (yy, zz, rx) in enumerate(((-0.06, -0.16, -0.75), (-0.24, -0.18, -0.55), (-0.40, -0.12, -0.4))):
        cone(f"dSpine{i}", dragon, (0, yy * k, zz * k), 0.02 * k, 0.035 * k, 0.18 * k, m["dragon"],
             brot=(math.degrees(-rx), 0, 0), seg=4)
    cone("dThroat", dragon, (0, -0.852, 0.483), 0.06 * k, 0.08 * k, 0.16 * k, m["flame"], "forward", seg=4)
    cone("dBreath", dragon, (0, -0.829, 0.667), 0.035 * k, 0.05 * k, 0.12 * k, m["flame"], "forward", seg=4)
    for fx in (-0.07, -0.025, 0.025, 0.07):
        cone(f"dTooth{fx:+.3f}", dragon, (fx * k, -0.954, (0.55 + abs(fx) * 1.4) * k * 0.5 + 0.30 * k),
             0.01, 0.02, 0.12 * k, m["steel"], "up", seg=4)
    marker("maw-hilt", dragon, bpos(0, -0.254, 0.023))
    marker("maw-tip", dragon, bpos(0, -0.761, 1.221))
    marker("maw", dragon, bpos(0, -0.807, 1.291))

    jaw = slot("jaw", dragon, 0, -0.82 * k, 0.34 * k)
    cyl("jawBone", jaw, (0, -0.023, 0.323), 0.05 * k, 0.48 * k, m["dragon"], "forward", seg=5)
    cyl("jawTip", jaw, (0, 0, 0.668), 0.025 * k, 0.22 * k, m["dragon"], "forward", seg=5)
    for fx in (-0.08, -0.03, 0.03, 0.08):
        cone(f"jFang{fx:+.3f}", jaw, (fx * k, 0.069, (0.50 + abs(fx)) * k * 0.5 + 0.17 * k),
             0.01, 0.02, 0.14 * k, m["steel"], brot=(159.6, 0, 0), seg=4)
    cone("jLick", jaw, (0, 0.058, 0.415), 0.03 * k, 0.04 * k, 0.16 * k, m["flame"], "forward", seg=4)

    # 背上三条接肢臂（updateVisuals 每帧按游戏侧基准角写 rotation.x/.z，rest 必须走 game_rotation）
    grafts = [
        ("graft0", (0.26, 0.72, -0.40), (-1.15, 0, -0.42), 0.92, 0.10),
        ("graft1", (-0.28, 0.95, -0.38), (-1.25, 0, 0.48), 1.05, 0.11),
        ("graft2", (0.02, 2.22, -0.36), (-0.38, 0, 0.06), 1.717, 0.12),
    ]
    for name, pos, rot, length, thick in grafts:
        g = empty(name)
        R = game_rotation(*rot)
        T = Matrix.Translation(Vector(bpos(*pos)))
        g.matrix_world = torso.matrix_world @ (T @ R)
        parent_keep(g, torso)
        cone(name + "Upper", g, (0, length * 0.25, 0), thick * 0.62, thick, length * 0.50, m["flesh"], "up", seg=5)
        cone(name + "Lower", g, (0, length * 0.66, 0.02), thick * 0.28, thick * 0.62, length * 0.36, m["fleshDark"], "up", seg=5)
        cone(name + "Tip", g, (0, length * 0.90, 0.03), thick * 0.16, thick * 0.30, length * 0.14, m["flesh"], "up", seg=4)

    require_markers("weapon-hilt", "weapon-tip", "weapon2-hilt", "weapon2-tip", "maw-hilt", "maw-tip", "maw", "gust", "axe-head")
    check_height(
        "godrick", 0.1,
        ("crownSpikeM", 3.60, 0.15),
        5.70,
        extra=(("pauldronL", 4.30, 0.18), ("graft2Tip", 5.60, 0.2)),
    )




def build_morgott():
    """脚到头 3.2，斗篷 3.6。王杖、金锤、大剑、血色咒剑、尾。
    挂点位置 = boss-morgott.ts 的组常量，姿态代码不改就能挂。"""
    gold = (0.847, 0.702, 0.416)  # 0xd8b36a
    gold_d = (0.725, 0.604, 0.333)  # 0xb99a55
    blood = (0.608, 0.231, 0.196)  # 0x9b3b32
    m = palette(gold, gold, 0.7, 0.4)
    m["gold"] = make_mat("morgott-gold", gold_d, 0.4, 0.45, emission=gold, emission_strength=0.55)
    m["eye"] = make_mat("morgott-eye", (0.07, 0.05, 0.02), 0.5, 0.0, emission=gold, emission_strength=1.15)
    m["hammer"] = make_mat("morgott-hammer", (0.80, 0.70, 0.47), 0.35, 0.5, emission=gold, emission_strength=0.15, alpha=0.9)
    m["gsword"] = make_mat("morgott-gsword", (0.84, 0.74, 0.51), 0.32, 0.55, emission=gold, emission_strength=0.15, alpha=0.9)
    m["blood"] = make_mat("morgott-blood", blood, 0.45, 0.4, emission=blood, emission_strength=0.35)
    m["skin"] = make_mat("skin", (0.541, 0.490, 0.420), 0.95, 0.0)
    m["skinDark"] = make_mat("skinDark", (0.420, 0.376, 0.325), 0.98, 0.0)
    m["robe"] = make_mat("robe", (0.216, 0.200, 0.176), 1.0, 0.0)
    m["robeDark"] = make_mat("robeDark", (0.157, 0.145, 0.122), 1.0, 0.0)
    m["cloak"] = make_mat("cloak", (0.200, 0.227, 0.259), 0.96, 0.0, double=True)
    m["wood"] = make_mat("wood", (0.290, 0.239, 0.173), 0.92, 0.0)
    m["steel"] = make_mat("steel", (0.337, 0.361, 0.400), 0.5, 0.5)
    m["goldHot"] = make_mat("goldHot", gold, 0.4, 0.45, emission=gold, emission_strength=0.6)

    body = slot("body", None, 0, 0, 0)
    # 髋 1.555，膝 -0.78，脚底贴地
    for name, shin_name, x in (("legR", "shinR", 0.15), ("legL", "shinL", -0.15)):
        leg = slot(name, body, x, 1.555, 0.02)
        cone(name + "Thigh", leg, (0, -0.39, 0), 0.078, 0.12, 0.78, m["skinDark"], "up", seg=6)
        shin = slot(shin_name, leg, 0, -0.78, 0)
        cone(shin_name + "Calf", shin, (0, -0.34, 0.01), 0.042, 0.072, 0.68, m["skinDark"], "up", seg=6)
        sphere(shin_name + "Foot", shin, (0, -0.74, 0.07), 0.075, m["skinDark"], (0.72, 0.46, 1.45), seg=6, ring=4)
    cone("waist", body, (0, 1.52, 0.02), 0.18, 0.20, 0.24, m["skinDark"], "up", seg=7)
    cone("waistBand", body, (0, 1.38, 0.03), 0.22, 0.24, 0.07, m["robeDark"], "up", seg=7)
    sphere("knot", body, (0.16, 1.32, 0.16), 0.045, m["robeDark"], seg=5, ring=4)
    cone("robe0", body, (0, 0.86, 0.02), 0.46, 0.22, 1.12, m["robe"], "up", seg=10)
    cone("robe1", body, (0, 0.82, -0.02), 0.40, 0.20, 1.00, m["robeDark"], "up", seg=10)
    for i in range(7):
        a = (i / 7) * math.tau + 0.35
        h = 0.26 + (i % 3) * 0.05
        cone(f"rag{i}", body, (math.sin(a) * 0.42, 0.34 - h * 0.15 - h * 0.42, math.cos(a) * 0.40),
             0.010, 0.038, h, m["robeDark"], brot=(math.degrees(0.18), math.degrees(a), 0), seg=5)
    # 尾：节段从 z=-0.09 到刃尖 -1.17
    tail = slot("tail", body, 0, 1.46, -0.22)
    y = -0.082
    segs = [
        ("tailRoot", 0.15, 0.13, 0.18, -0.09, m["skinDark"]),
        ("tailKnotA", 0.055, 0.05, 0.055, -0.195, m["robeDark"]),
        ("tailMid", 0.125, 0.11, 0.16, -0.295, m["skin"]),
        ("tailKnotB", 0.048, 0.044, 0.05, -0.395, m["robeDark"]),
        ("tailLow", 0.11, 0.095, 0.15, -0.49, m["skinDark"]),
        ("tailKnotC", 0.042, 0.038, 0.048, -0.585, m["robeDark"]),
        ("tailEnd", 0.095, 0.082, 0.14, -0.675, m["skin"]),
        ("tailKnotD", 0.036, 0.032, 0.05, -0.765, m["robeDark"]),
    ]
    for nm, w, h_, d_, z, mat in segs:
        box(nm, tail, (0, y, z), (w, h_, d_), mat)
    box("tailBladeRoot", tail, (0, y, -0.81), (0.028, 0.10, 0.08), m["steel"])
    box("tailBlade", tail, (0, y, -0.93), (0.028, 0.26, 0.18), m["steel"])
    box("tailBladeTip", tail, (0, y, -1.05), (0.014, 0.14, 0.10), m["steel"])
    cone("tailPoint", tail, (0, y, -1.14), 0.012, 0.05, 0.08, m["steel"], brot=(90, 0, 0), seg=4)
    marker("tail-hilt", tail, bpos(0, y, 0))
    marker("tail-tip", tail, bpos(0, y, -1.17))

    torso = slot("torso", body, 0, 1.70, 0)
    cone("tWaist", torso, (0, 0.06, 0.02), 0.17, 0.20, 0.22, m["robeDark"], "up", seg=7)
    cone("tBelly", torso, (0, 0.32, 0.04), 0.20, 0.30, 0.36, m["robe"], "up", seg=8)
    cone("tChest", torso, (0, 0.68, 0.02), 0.28, 0.40, 0.42, m["robe"], "up", seg=8)
    cone("tCollar", torso, (0, 0.96, 0), 0.40, 0.34, 0.20, m["cloak"], "up", seg=8)
    sphere("tBack", torso, (0, 0.48, -0.20), 0.22, m["skinDark"], (1.15, 0.85, 0.72), seg=6, ring=5)
    cyl("laceR", torso, (0.08, 0.42, 0.22), 0.014, 0.42, m["robeDark"], seg=5)
    cyl("laceL", torso, (-0.08, 0.42, 0.22), 0.014, 0.42, m["robeDark"], seg=5)
    sphere("navel", torso, (0, 0.22, 0.26), 0.045, m["skinDark"], (0.8, 1.1, 0.55), seg=5, ring=4)
    cone("tNeck", torso, (0, 1.18, 0.24), 0.09, 0.11, 0.32, m["skinDark"], brot=(33.2, 0, 0), seg=6)
    sphere("capR", torso, (0.50, 1.34, -0.04), 0.32, m["cloak"], (1.05, 1.18, 0.88), seg=7, ring=5)
    sphere("capL", torso, (-0.50, 1.34, -0.04), 0.32, m["cloak"], (1.05, 1.18, 0.88), seg=7, ring=5)
    cone("cowlR", torso, (0.62, 1.58, -0.06), 0.10, 0.20, 0.28, m["cloak"], brot=(0, 0, -24.1), seg=6)
    cone("cowlL", torso, (-0.62, 1.58, -0.06), 0.10, 0.20, 0.28, m["cloak"], brot=(0, 0, 24.1), seg=6)
    cone("cloak", torso, (0, 1.62, -0.2), 0.42, 0.08, 0.85, m["cloak"], brot=(-25, 0, 0), seg=7)

    # 头沉在两肩之间，颅顶低于肩线
    head = slot("head", torso, 0, 1.336, 0.42)
    sphere("skull", head, (0, 0.02, 0), 0.155, m["skin"], (0.92, 1.18, 1.02), seg=7, ring=5)
    sphere("jaw", head, (0, -0.12, 0.04), 0.105, m["skinDark"], (0.90, 0.62, 0.95), seg=6, ring=4)
    sphere("nose", head, (0, 0.05, 0.12), 0.07, m["skinDark"], (1.35, 0.42, 0.65), seg=5, ring=4)

    def horn(side, length, r0, r1, x, y, z, rx, rz):
        h = empty(f"horn{side:+d}_{int(r0 * 1000)}")
        local = Matrix.Translation(Vector(bpos(side * x, y, z)))
        R = game_rotation(rx, 0, side * rz)
        h.matrix_world = head.matrix_world @ (local @ R)
        parent_keep(h, head)
        cone(h.name + "Seg", h, (0, length * 0.5, 0), r1, r0, length, m["skinDark"], "up", seg=5)
        return h

    horn(1, 0.30, 0.045, 0.028, 0.10, 0.02, -0.02, -1.05, 0.55)
    horn(-1, 0.30, 0.045, 0.028, 0.10, 0.02, -0.02, -1.05, 0.55)
    horn(1, 0.26, 0.026, 0.012, 0.20, 0.06, -0.16, -1.25, 0.85)
    horn(-1, 0.26, 0.026, 0.012, 0.20, 0.06, -0.16, -1.25, 0.85)
    sphere("eyeR", head, (0.055, 0.045, 0.145), 0.028, m["eye"], (1.15, 0.72, 0.55), seg=5, ring=4)
    sphere("eyeL", head, (-0.055, 0.045, 0.145), 0.028, m["eye"], (1.15, 0.72, 0.55), seg=5, ring=4)
    sphere("mark", head, (0, 0.10, 0.155), 0.04, m["gold"], (0.65, 1.2, 0.38), seg=5, ring=4)
    for i in range(7):
        a = 0.55 + (i / 6) * (math.pi * 1.55)
        h = 0.09 if i % 3 == 1 else 0.055
        cone(f"crownSpike{i}", head, (math.sin(a) * 0.145, 0.12 + h * 0.35, math.cos(a) * 0.12),
             0.012, 0.026, h, m["gold"], brot=(0, math.degrees(a), 0), seg=5)
    marker("mouth", head, bpos(0, -0.10, 0.16))

    # 右臂：王杖 + 血咒剑 + 金锤
    arm_r = slot("armR", torso, 0.58, 0.96, 0.05)
    cone("armRUpper", arm_r, (0, -0.28, 0), 0.086, 0.135, 0.52, m["skinDark"], "up", seg=6)
    cone("armRLower", arm_r, (0, -0.74, 0.02), 0.046, 0.078, 0.48, m["skin"], "up", seg=6)
    sphere("armRHand", arm_r, (0, -1.04, 0.05), 0.058, m["skinDark"], (1.05, 0.72, 1.15), seg=5, ring=4)
    for i, (fx, rx) in enumerate(((-0.03, 40.1), (0, 48.7), (0.03, 40.1))):
        cone(f"armRClaw{i}", arm_r, (fx, -1.13, 0.10), 0.006, 0.014, 0.11, m["skinDark"],
             brot=(rx + (i - 1) * 14.3, 0, 0), seg=4)

    staff = empty("weapon")
    local = Matrix.Translation(Vector(bpos(0, -1.10, 0.08)))
    R = game_rotation(0.16, 0, 0)
    staff.matrix_world = arm_r.matrix_world @ (local @ R)
    parent_keep(staff, arm_r)
    cone("staffShaft", staff, (0, -0.46, 0), 0.038, 0.024, 2.08, m["wood"], "up", seg=6)
    box("staffTailCap", staff, (0, -1.478, 0), (0.056, 0.044, 0.056), m["goldHot"])
    box("staffGrip", staff, (0, 0.02, 0), (0.050, 0.18, 0.050), m["robeDark"])
    box("staffRingA", staff, (0, -0.86, 0), (0.062, 0.026, 0.062), m["goldHot"])
    box("staffRingB", staff, (0, -0.22, 0), (0.058, 0.024, 0.058), m["goldHot"])
    box("staffSeat", staff, (0, 0.600, 0), (0.13, 0.07, 0.13), m["goldHot"])
    cone("staffSeatCap", staff, (0, 0.665, 0), 0.030, 0.040, 0.06, m["goldHot"], "up", seg=5)
    cone("staffOrbA", staff, (0, 0.735, 0), 0.034, 0.062, 0.08, m["gold"], "up", seg=5)
    cone("staffOrbB", staff, (0, 0.825, 0), 0.062, 0.100, 0.10, m["gold"], "up", seg=6)
    cone("staffOrbC", staff, (0, 0.910, 0), 0.100, 0.048, 0.07, m["gold"], "up", seg=6)
    cone("staffCross", staff, (0, 1.067, 0), 0, 0.022, 0.36, m["gold"], "up", seg=4)
    box("staffCrossArm", staff, (0, 1.020, 0), (0.26, 0.034, 0.034), m["gold"])
    box("staffCrossF", staff, (0, 1.020, 0), (0.034, 0.034, 0.16), m["goldHot"])
    marker("weapon-hilt", staff, bpos(0, -1.50, 0))
    marker("weapon-tip", staff, bpos(0, 1.25, 0))

    blade = empty("weapon2")
    local = Matrix.Translation(Vector(bpos(0, -1.12, 0.12)))
    R = game_rotation(0.22, 0, 0)
    blade.matrix_world = arm_r.matrix_world @ (local @ R)
    parent_keep(blade, arm_r)
    box("bpommel", blade, (0, 0.075, 0), (0.034, 0.050, 0.034), m["blood"])
    box("bgrip", blade, (0, -0.030, 0), (0.024, 0.18, 0.024), m["blood"])
    box("bguard", blade, (0, -0.125, 0), (0.26, 0.032, 0.038), m["blood"])
    box("bquillonR", blade, (0.12, -0.165, 0), (0.018, 0.08, 0.018), m["blood"], brot=(0, 0, -37.2))
    box("bquillonL", blade, (-0.12, -0.165, 0), (0.018, 0.08, 0.018), m["blood"], brot=(0, 0, 37.2))
    box("broot", blade, (0, -0.180, 0), (0.036, 0.08, 0.016), m["blood"])
    box("bspine", blade, (0, -0.580, 0), (0.064, 0.74, 0.014), m["blood"])
    box("bcore", blade, (0, -0.580, 0), (0.020, 0.74, 0.020), m["blood"])
    box("btaper", blade, (0, -1.050, 0), (0.034, 0.22, 0.012), m["blood"])
    cone("bpoint", blade, (0, -1.263, 0), 0, 0.014, 0.32, m["blood"], "down", seg=4)
    marker("weapon2-hilt", blade, bpos(0, 0.10, 0))
    marker("weapon2-tip", blade, bpos(0, -1.42, 0))

    hammer = slot("hammer", arm_r, 0, -1.14, 0.20)
    box("hammerHandle", hammer, (0, -0.190, 0), (0.04, 0.50, 0.04), m["goldHot"])
    box("hammerNeck", hammer, (0, 0.090, 0), (0.14, 0.09, 0.14), m["goldHot"])
    box("hammerHead", hammer, (0, 0.310, 0), (0.76, 0.42, 0.60), m["hammer"])
    box("hammerFace", hammer, (0, 0.300, 0), (0.90, 0.10, 0.74), m["hammer"])
    box("hammerCrown", hammer, (0, 0.520, 0), (0.60, 0.08, 0.48), m["hammer"])
    marker("hammer-hilt", hammer, bpos(0, -0.44, 0))
    marker("hammer-tip", hammer, bpos(0, 0.56, 0))

    # 左臂：王之大剑 + 袖中咒刃
    arm_l = slot("armL", torso, -0.58, 0.96, 0.05)
    cone("armLUpper", arm_l, (0, -0.27, 0), 0.082, 0.13, 0.50, m["skinDark"], "up", seg=6)
    cone("armLLower", arm_l, (0, -0.72, 0.02), 0.044, 0.075, 0.46, m["skin"], "up", seg=6)
    sphere("armLHand", arm_l, (0, -1.00, 0.05), 0.055, m["skinDark"], (1.0, 0.7, 1.1), seg=5, ring=4)
    cone("sleeveBlade", arm_l, (0.01, -1.02, 0.10), 0.012, 0.022, 0.40, m["steel"], brot=(22.9, 0, 0), seg=4)
    for i, fx in enumerate((-0.03, 0, 0.03)):
        cone(f"armLClaw{i}", arm_l, (fx, -1.10, 0.08), 0.005, 0.011, 0.10, m["skinDark"],
             brot=(31.5 + i * 6.9, 0, 0), seg=4)

    gs = empty("gsword")
    local = Matrix.Translation(Vector(bpos(0, -1.10, 0.12)))
    R = game_rotation(0.2, 0, 0)
    gs.matrix_world = arm_l.matrix_world @ (local @ R)
    parent_keep(gs, arm_l)
    box("gpommel", gs, (0, 0.068, 0), (0.078, 0.064, 0.078), m["gsword"])
    box("ggrip", gs, (0, -0.060, 0), (0.048, 0.24, 0.048), m["gsword"])
    box("gguard", gs, (0, -0.200, 0), (0.76, 0.06, 0.09), m["gsword"])
    box("ghub", gs, (0, -0.200, 0), (0.14, 0.10, 0.11), m["gsword"])
    box("gquillonR", gs, (0.36, -0.240, 0), (0.046, 0.20, 0.046), m["gsword"], brot=(0, 0, -31.5))
    box("gquillonL", gs, (-0.36, -0.240, 0), (0.046, 0.20, 0.046), m["gsword"], brot=(0, 0, 31.5))
    box("groot", gs, (0, -0.300, 0), (0.12, 0.14, 0.045), m["gsword"])
    box("gbladeA", gs, (0, -0.620, 0), (0.34, 0.52, 0.038), m["gsword"])
    box("gcoreA", gs, (0, -0.620, 0), (0.09, 0.52, 0.056), m["gsword"])
    box("gbladeB", gs, (0, -1.060, 0), (0.22, 0.42, 0.032), m["gsword"])
    box("gcoreB", gs, (0, -1.060, 0), (0.06, 0.42, 0.046), m["gsword"])
    box("gtaper", gs, (0, -1.400, 0), (0.11, 0.28, 0.024), m["gsword"])
    cone("gpoint", gs, (0, -1.680, 0), 0, 0.048, 0.42, m["gsword"], "down", seg=4)
    marker("gsword-hilt", gs, bpos(0, 0.10, 0))
    marker("gsword-tip", gs, bpos(0, -1.89, 0))

    require_markers(
        "weapon-hilt", "weapon-tip", "weapon2-hilt", "weapon2-tip",
        "tail-hilt", "tail-tip", "hammer-hilt", "hammer-tip", "gsword-hilt", "gsword-tip", "mouth",
    )
    check_height(
        "morgott", 0.08,
        ("skull", 3.20, 0.15),
        3.85,
        extra=(("cloak", 3.60, 0.15),),
    )


def build_radahn():
    """脚到头 8.1，发梢 11.7。双大剑，弓只在射箭时由代码显示。
    挂点位置 = boss-radahn.ts 的组常量 × FORM_SCALE(1.9704)，姿态代码不改就能挂。"""
    SC = 8.1 / 4.1108
    grav = (0.541, 0.435, 0.820)     # 0x8a6fd1
    grav_g = (0.663, 0.561, 0.910)   # 0xa98fe8
    hair = (0.561, 0.227, 0.165)     # 0x8f3a2a
    hair_d = (0.427, 0.173, 0.125)   # 0x6d2c20
    m = palette(grav, grav_g, 0.55, 0.35)
    m["sword"] = make_mat("radahn-sword", (0.439, 0.471, 0.533), 0.4, 0.6, emission=grav, emission_strength=0.45)
    m["edge"] = make_mat("radahn-edge", grav_g, 0.4, 0.2, emission=grav, emission_strength=0.9)
    m["eye"] = make_mat("radahn-eye", grav_g, 0.3, 0.0, emission=grav_g, emission_strength=1.4, alpha=0.95)
    m["bow"] = make_mat("radahn-bow", grav_g, 0.35, 0.2, emission=grav, emission_strength=1.1, alpha=0.85)
    m["hair"] = make_mat("radahn-hair", hair, 0.9, 0.0)
    m["hairDark"] = make_mat("radahn-hairDark", hair_d, 0.92, 0.0)
    m["gold"] = make_mat("radahn-gold", (0.659, 0.471, 0.235), 0.45, 0.5)
    m["skin"] = make_mat("skin", (0.431, 0.388, 0.333), 0.9, 0.05)
    m["iron"] = make_mat("iron", (0.227, 0.243, 0.278), 0.55, 0.55)
    m["ironDark"] = make_mat("ironDark", (0.169, 0.180, 0.212), 0.6, 0.45)

    body = slot("body", None, 0, 0, 0)
    # 腿：髋 (±0.5,1.95,0)×SC，膝 (0,-1.08,0.04)×SC，脚底贴地
    for name, shin_name, x in (("legR", "shinR", 0.5), ("legL", "shinL", -0.5)):
        leg = slot(name, body, x * SC, 1.95 * SC, 0)
        cone(name + "Thigh", leg, (0, -1.02, 0), 0.34, 0.22, 2.01, m["ironDark"], "down", seg=7)
        sphere(name + "Knee", leg, (0, -2.09, 0.06), 0.53, m["ironDark"], (1.08, 0.82, 1.12), seg=7, ring=5)
        shin = slot(shin_name, leg, 0, -1.08 * SC, 0.04 * SC)
        cone(shin_name + "Calf", shin, (0, -0.71, 0.02), 0.335, 0.236, 1.42, m["ironDark"], "down", seg=6)
        sphere(shin_name + "Foot", shin, (0, -1.52, 0.32), 0.394, m["iron"], (1.15, 0.42, 2.05), seg=7, ring=5)

    torso = slot("torso", body, 0, 2.0 * SC, 0)
    sphere("pelvis", torso, (0, -0.10, 0), 0.95, m["ironDark"], (1.18, 0.5, 0.98), seg=8, ring=6)
    cyl("belt", torso, (0, 0.28, 0.08), 1.26, 0.20, m["gold"], seg=8)
    for sx in (1, -1):
        cone("tasset" + ("R" if sx > 0 else "L"), torso, (sx * 0.59, -0.63, 0.59), 0.217, 0.089, 0.99,
             m["ironDark"], brot=(24, 0, sx * 12.6), seg=5)
    cone("tassetM", torso, (0, -0.55, 0.75), 0.177, 0.079, 0.83, m["ironDark"], brot=(12.6, 0, 0), seg=5)
    sphere("belly", torso, (0, 0.79, 0.12), 1.02, m["iron"], (1.28, 0.7, 1.18), seg=8, ring=6)
    sphere("chest", torso, (0, 1.89, 0.20), 1.30, m["iron"], (1.38, 0.84, 1.24), seg=9, ring=7)
    sphere("chestUp", torso, (0, 2.76, 0.08), 0.67, m["iron"], (1.02, 0.52, 0.92), seg=7, ring=5)
    sphere("backplate", torso, (0, 1.62, -0.99), 0.95, m["ironDark"], (1.22, 0.98, 0.6), seg=7, ring=5)
    cyl("neck", torso, (0, 3.05, 0.20), 0.39, 0.71, m["skin"], seg=7)
    for name, sx in (("pauldronR", 1), ("pauldronL", -1)):
        sphere(name, torso, (sx * 2.21, 2.60, 0.04), 1.14, m["iron"], (1.2, 0.72, 0.95), seg=8, ring=6)
        sphere(name + "Trim", torso, (sx * 2.92, 2.72, 0.20), 0.32, m["gold"], (1, 0.55, 0.75), seg=6, ring=4)
    cyl("badge", torso, (0, 1.97, 1.85), 0.24, 0.10, m["gold"], "forward", seg=7)

    # 头夹在两肩之间，残盔顶就是 8.1 的盔顶
    head = slot("head", torso, 0, 1.526 * SC, 0.1 * SC)
    cyl("headNeck", head, (0, -0.24, 0), 0.355, 0.43, m["skin"], seg=6)
    sphere("face", head, (0, 0, 0.20), 0.43, m["skin"], (1.02, 1.08, 0.96), seg=7, ring=6)
    sphere("jaw", head, (0, -0.24, 0.16), 0.31, m["skin"], (1.05, 0.62, 0.9), seg=6, ring=4)
    sphere("helm", head, (0, 0.32, -0.20), 0.67, m["iron"], (1.08, 1.08, 1.02), seg=8, ring=6)
    sphere("cheekR", head, (0.47, -0.04, 0.12), 0.20, m["ironDark"], (0.7, 1.15, 1.1), seg=6, ring=4)
    sphere("cheekL", head, (-0.47, -0.04, 0.12), 0.20, m["ironDark"], (0.7, 1.15, 1.1), seg=6, ring=4)
    box("crestC", head, (0, 0.98, 0.02), (0.16, 0.39, 0.06), m["ironDark"], brot=(-6, 0, 0))
    box("crestR", head, (0.51, 0.91, -0.04), (0.14, 0.32, 0.05), m["ironDark"], brot=(-9, 0, -10))
    box("crestL", head, (-0.51, 0.91, -0.04), (0.14, 0.32, 0.05), m["ironDark"], brot=(-9, 0, 10))
    box("crestTop", head, (0, 1.03, 0.12), (0.12, 0.12, 0.04), m["gold"])
    sphere("eyeR", head, (0.18, 0.16, 0.65), 0.089, m["eye"], (1.15, 0.7, 0.55), seg=6, ring=4)
    sphere("eyeL", head, (-0.18, 0.16, 0.65), 0.089, m["eye"], (1.15, 0.7, 0.55), seg=6, ring=4)

    # 红鬃：主鬃到 11.7，后披和搭肩的几绺
    hair_g = slot("hair", head, 0, 0.22 * SC, -0.08 * SC)
    cone("hairTip", hair_g, (0, 2.17, -0.19), 0.55, 0.07, 4.25, m["hair"], brot=(-8, 0, 0), seg=6)
    cone("hairSideR", hair_g, (0.79, 0.79, -0.47), 0.24, 0.06, 2.06, m["hairDark"], brot=(15, 0, 28), seg=5)
    cone("hairSideL", hair_g, (-0.79, 0.79, -0.47), 0.24, 0.06, 2.06, m["hairDark"], brot=(15, 0, -28), seg=5)
    cone("hairDrape", hair_g, (0.08, -1.92, -0.59), 0.39, 0.05, 3.15, m["hair"], brot=(180, 0, 3), seg=5)
    cone("hairBackR", hair_g, (-0.55, -1.18, -0.47), 0.24, 0.05, 2.17, m["hairDark"], brot=(172, 0, -8), seg=5)
    cone("hairBackL", hair_g, (0.67, -1.08, -0.35), 0.22, 0.05, 2.06, m["hair"], brot=(172, 0, 8), seg=5)
    cone("hairShoulderR", hair_g, (1.38, -1.22, 0.24), 0.20, 0.05, 1.94, m["hair"], brot=(170, 0, 14), seg=5)
    cone("hairShoulderL", hair_g, (-1.38, -1.22, 0.24), 0.20, 0.05, 1.94, m["hair"], brot=(170, 0, -14), seg=5)

    # 双臂：枢轴 (±1.22,1.14,0.04)×SC
    for name, sx in (("armR", 1), ("armL", -1)):
        arm = slot(name, torso, sx * 1.22 * SC, 1.14 * SC, 0.04 * SC)
        cone(name + "Upper", arm, (0, -0.71, 0), 0.51, 0.335, 1.34, m["iron"], "down", seg=7)
        sphere(name + "Elbow", arm, (0, -1.38, 0.04), 0.37, m["ironDark"], (1.05, 0.75, 1.05), seg=6, ring=5)
        cone(name + "Fore", arm, (0, -1.93, 0.06), 0.296, 0.236, 0.95, m["ironDark"], "down", seg=6)
        sphere(name + "Fist", arm, (0, -2.44, 0.12), 0.37, m["iron"], (1.2, 0.68, 1.15), seg=7, ring=5)

    # 碎星大剑：组局部 -Y 是刃向，rest 姿态 (-1.08, ±0.38, ±0.2) rad 与游戏一致
    def greatsword(arm, side, names):
        root_name = "weapon" if names[0] == "weapon-hilt" else "weapon2"
        root = empty(root_name)
        R = game_rotation(-1.08, side * 0.38, side * 0.2)
        T = Matrix.Translation(Vector(bpos(side * 0.02 * SC, -1.24 * SC, 0.12 * SC + side * 0.05 * SC)))
        root.matrix_world = arm.matrix_world @ (T @ R)
        parent_keep(root, arm)
        x = side
        box("pommel", root, (0, 0.55, 0), (0.39, 0.32, 0.39), m["gold"])
        box("grip", root, (0, 0.04, 0), (0.24, 0.71, 0.24), m["ironDark"])
        box("guard", root, (0, -0.51, 0), (2.32, 0.32, 0.55), m["gold"])
        box("guardTip", root, (x * 1.03, -0.16, 0), (0.28, 0.55, 0.32), m["gold"], brot=(0, 0, x * -34))
        box("guardIn", root, (x * -0.99, -0.20, 0), (0.24, 0.43, 0.28), m["iron"], brot=(0, 0, x * 26))
        box("swordNeck", root, (0, -0.95, 0), (0.39, 0.47, 0.20), m["ironDark"])
        box("bladeUp", root, (x * 0.10, -2.76, 0), (1.73, 2.86, 0.20), m["sword"], brot=(0, 0, x * 2))
        box("fullerR", root, (x * 0.10, -2.72, 0.11), (0.28, 2.56, 0.08), m["ironDark"])
        box("fullerL", root, (x * 0.10, -2.72, -0.11), (0.28, 2.56, 0.08), m["ironDark"])
        box("bladeLow", root, (x * 0.32, -5.03, 0), (1.34, 2.36, 0.18), m["sword"], brot=(0, 0, x * 5))
        box("edgeUpR", root, (x * 0.10, -2.68, 0.14), (1.85, 2.66, 0.04), m["edge"])
        box("edgeUpL", root, (x * 0.10, -2.68, -0.14), (1.85, 2.66, 0.04), m["edge"])
        box("edgeLowR", root, (x * 0.32, -4.97, 0.12), (1.46, 2.17, 0.035), m["edge"])
        box("edgeLowL", root, (x * 0.32, -4.97, -0.12), (1.46, 2.17, 0.035), m["edge"])
        box("tipTaper", root, (x * 0.47, -6.60, 0.02), (0.51, 0.99, 0.12), m["sword"], brot=(0, 0, x * 6))
        box("point", root, (x * 0.55, -7.37, 0.02), (0.24, 0.67, 0.08), m["sword"], brot=(0, 0, x * 7))
        box("tipEdge", root, (x * 0.50, -6.55, 0.09), (0.32, 0.83, 0.03), m["edge"], brot=(0, 0, x * 6))
        marker(names[0], root, bpos(0, 0.02 * SC, 0))
        marker(names[1], root, bpos(x * 0.241 * SC, -3.916 * SC, 0.01 * SC))
        return root

    greatsword(bpy.data.objects["armR"], 1, ("weapon-hilt", "weapon-tip"))
    greatsword(bpy.data.objects["armL"], -1, ("weapon2-hilt", "weapon2-tip"))
    # 弓：挂在左臂，代码控制显隐与不透明度
    bow = slot("bow", bpy.data.objects["armL"], -0.18 * SC, -1.4 * SC, 0.05 * SC)
    cyl("bowGrip", bow, (0, 0, 0), 0.20, 1.08, m["bow"], "up", seg=6)
    cone("bowUpper", bow, (-0.30, 1.38, 0.10), 0.16, 0.06, 2.27, m["bow"], brot=(8, 0, 18), seg=5)
    cone("bowLower", bow, (-0.24, -1.38, 0.04), 0.16, 0.06, 2.06, m["bow"], brot=(-8, 0, -16), seg=5)
    cyl("bowString", bow, (0.69, 0, 0.10), 0.024, 3.35, m["bow"], "up", seg=3)
    require_markers("weapon-hilt", "weapon-tip", "weapon2-hilt", "weapon2-tip")
    check_height(
        "radahn", 0.15,
        ("helm", 8.10, 0.25),
        11.9,
        extra=(("hairTip", 11.70, 0.25),),
    )


def build_all():
    builders = [
        ("gundyr", build_gundyr),
        ("vordt", build_vordt),
        ("watchers", build_watchers),
        ("sulyvahn", build_sulyvahn),
        ("margit", build_margit),
        ("godrick", build_godrick),
        ("morgott", build_morgott),
        ("radahn", build_radahn),
    ]
    failed = []
    for name, fn in builders:
        clear_scene()
        try:
            fn()
        except RuntimeError as err:
            failed.append(str(err))
            print(f"INFERNO_BOSS_FAIL {err}")
            continue
        export_boss(name)
    if failed:
        raise SystemExit("身高没对上:\n" + "\n".join(failed))
    print("INFERNO_BOSSES_OK")


if __name__ == "__main__":
    build_all()
